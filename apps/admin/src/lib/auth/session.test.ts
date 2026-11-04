import { describe, expect, it, vi } from "vitest";
import {
  AuthSession,
  JOIN_WAIT_MS,
  type SavedSession,
  type SessionDeps,
} from "./session";
import type { Tokens } from "./srp";
import { fakeAccess, fakeJwt } from "./test-helpers";

// 로그인 세션 (BRD-148, D16-A2·A3·A10)

const MIN = 60_000;
const AUTH_SEC = 1_700_000_000;
const AUTH = AUTH_SEC * 1000;

function tokens(expOffsetMin = 15, authTime = AUTH_SEC, n = 1): Tokens {
  return {
    accessToken: fakeAccess({
      exp: AUTH_SEC + expOffsetMin * 60,
      auth_time: authTime,
    }),
    idToken: fakeJwt({ email: "ops@example.test" }),
    refreshToken: `refresh-${n}`,
  };
}

function setup(overrides: Partial<SessionDeps> = {}) {
  let now = AUTH;
  const timers: { fn: () => void; at: number }[] = [];
  let refreshes = 0;
  const posted: unknown[] = [];
  let listener: ((m: unknown) => void) | undefined;
  const deps: SessionDeps = {
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, at: now + ms };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as never);
      if (i >= 0) timers.splice(i, 1);
    },
    // 갱신할 때마다 만료가 15분씩 늦어진 새 토큰(실제 Cognito처럼). 첫 갱신은 refresh-2·30분
    refresh: vi.fn(async () => {
      refreshes += 1;
      return tokens(15 * (refreshes + 1), AUTH_SEC, refreshes + 1);
    }),
    revoke: vi.fn(async () => undefined),
    channel: { post: (m) => posted.push(m), listen: (fn) => (listener = fn) },
    ...overrides,
  };
  const session = new AuthSession(deps);
  // 시계를 옮기고 그때까지 깰 타이머를 차례로 부름
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > until) break;
      timers.shift();
      now = next.at;
      next.fn();
      // 갱신은 잠금·예외 처리 안에서 여러 단계로 끝남
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    now = until;
  };
  return {
    session,
    deps,
    posted,
    advance,
    other: (m: unknown) => listener?.(m),
    setNow: (t: number) => (now = t),
  };
}

describe("AuthSession", () => {
  it("로그인하면 풀·이메일·그룹을 보여 주고 토큰은 스냅숏에 넣지 않는다", () => {
    const { session } = setup();
    expect(session.signIn("operator", tokens())).toBe(true);
    const snap = session.getSnapshot();
    expect(snap).toMatchObject({
      status: "signed_in",
      pool: "operator",
      email: "ops@example.test",
      groups: ["publisher"],
      phase: "active",
    });
    expect(JSON.stringify(snap)).not.toContain("refresh-1");
  });

  it("access 만료 1분 전에 refresh로 갱신하고 새 refresh token을 쓴다", async () => {
    const { session, deps, advance } = setup();
    session.signIn("operator", tokens());
    await advance(14 * MIN);
    expect(deps.refresh).toHaveBeenCalledWith("operator", "refresh-1");
    session.touch();
    await advance(15 * MIN);
    expect(deps.refresh).toHaveBeenLastCalledWith("operator", "refresh-2");
  });

  it("갱신에 실패하면 로그아웃하지 않고 '다시 로그인' 상태가 되며 토큰을 주지 않는다", async () => {
    const { session, advance } = setup({
      refresh: vi.fn(async () => {
        throw new Error("network");
      }),
    });
    session.signIn("operator", tokens());
    // 다른 탭이 먼저 갱신했는지 잠깐(1.5초) 기다린 뒤 '다시 로그인'
    await advance(14 * MIN + 2_000);
    expect(session.getSnapshot().status).toBe("reauth_required");
    expect(await session.accessToken()).toBeNull();
  });

  it("갱신 토큰의 최초 인증 시각이 바뀌면 받지 않는다(8시간 상한을 늘리지 않게)", async () => {
    const { session, advance } = setup({
      refresh: vi.fn(async () => tokens(30, AUTH_SEC + 100, 2)),
    });
    session.signIn("operator", tokens());
    await advance(14 * MIN);
    expect(session.getSnapshot().status).toBe("reauth_required");
  });

  it("로그인·다시 로그인마다 generation이 늘고, 토큰 갱신으로는 늘지 않는다", async () => {
    const { session, advance } = setup();
    const generation = () => {
      const snap = session.getSnapshot();
      return snap.status === "signed_out" ? null : snap.generation;
    };
    session.signIn("operator", tokens());
    expect(generation()).toBe(1);
    await advance(14 * MIN); // 갱신(refresh)
    expect(generation()).toBe(1);
    session.reauthenticate(tokens(60));
    expect(generation()).toBe(2);
  });

  it("활동 없이 58분이면 경고, 60분이면 로그아웃하고 다른 탭에 알린다", async () => {
    const { session, advance, posted, deps } = setup();
    session.signIn("demo", tokens(120));
    await advance(58 * MIN);
    expect(session.getSnapshot()).toMatchObject({ phase: "idle_warning" });
    // 끝내기 전에 다른 탭에 활동 시각을 한 번 물어봄(0.4초)
    await advance(2 * MIN + JOIN_WAIT_MS);
    expect(session.getSnapshot()).toEqual({
      status: "signed_out",
      reason: "idle",
    });
    expect(posted).toEqual([
      expect.objectContaining({ kind: "activity", ask: true }),
      {
        kind: "logout",
        reason: "idle",
        pool: "demo",
        sub: "operator-sub",
        authTimeMs: AUTH,
      },
    ]);
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it("'계속 쓰기'(활동)는 유휴 경고를 풀지만 8시간 상한은 늘리지 않는다", async () => {
    const { session, advance } = setup({
      refresh: vi.fn(async () => tokens(500, AUTH_SEC, 2)),
    });
    session.signIn("operator", tokens(500));
    for (let i = 0; i < 17; i++) {
      await advance(28 * MIN);
      session.touch();
    }
    // 476분 → 2분 뒤 상한 경고, 4분 뒤 끝
    await advance(2 * MIN);
    expect(session.getSnapshot()).toMatchObject({ phase: "max_warning" });
    session.touch();
    await advance(2 * MIN);
    expect(session.getSnapshot()).toEqual({
      status: "signed_out",
      reason: "max",
    });
  });

  it("로그아웃하면 refresh token을 폐기하고, 다른 탭 신호로도 로그아웃된다", async () => {
    const a = setup();
    a.session.signIn("operator", tokens());
    await a.session.logout();
    expect(a.deps.revoke).toHaveBeenCalledWith("operator", "refresh-1");
    expect(a.posted).toEqual([
      {
        kind: "logout",
        reason: "logout",
        pool: "operator",
        sub: "operator-sub",
        authTimeMs: AUTH,
      },
    ]);

    const b = setup();
    b.session.signIn("operator", tokens());
    b.other(a.posted[0]);
    expect(b.session.getSnapshot()).toEqual({
      status: "signed_out",
      reason: "other_tab",
    });
  });

  it("access 클레임이 틀린 토큰은 로그인으로 보지 않는다", () => {
    const { session } = setup();
    expect(
      session.signIn("operator", {
        ...tokens(),
        accessToken: fakeJwt({ token_use: "id" }),
      }),
    ).toBe(false);
    expect(session.getSnapshot()).toEqual({
      status: "signed_out",
      reason: "invalid_token",
    });
  });
});

// 새 탭 넘겨받기·탭 사이 갱신 (결정 기록 D17-9). 토큰은 메모리에만
describe("탭 사이 로그인", () => {
  // 두 탭을 같은 채널로 잇는 가짜 BroadcastChannel(보낸 탭은 받지 않음)
  function pair(overrides: Partial<SessionDeps> = {}) {
    const a = setup({ newId: () => "tab-a", ...overrides });
    const b = setup({ newId: () => "tab-b", ...overrides });
    const link = (from: typeof a, to: typeof b) => {
      from.deps.channel!.post = (m) => {
        from.posted.push(m);
        to.other(m);
      };
    };
    link(a, b);
    link(b, a);
    return { a, b };
  }

  it("새 탭은 로그인한 탭에서 토큰을 넘겨받아 같은 최초 인증으로 로그인한다", () => {
    const { a, b } = pair();
    a.session.signIn("operator", tokens());
    b.session.join();
    expect(b.session.getSnapshot()).toMatchObject({
      status: "signed_in",
      pool: "operator",
      email: "ops@example.test",
      generation: 1,
    });
    expect(b.session.getSnapshot()).toMatchObject({
      times: { maxEndAt: AUTH + 8 * 60 * MIN },
    });
  });

  it("로그인한 탭이 없으면 잠깐 기다린 뒤 로그인 화면으로(기다리는 동안 joining)", async () => {
    const { b } = pair();
    b.session.join();
    expect(b.session.getSnapshot()).toEqual({
      status: "signed_out",
      reason: null,
      joining: true,
    });
    await b.advance(JOIN_WAIT_MS);
    expect(b.session.getSnapshot()).toEqual({
      status: "signed_out",
      reason: null,
    });
  });

  it("다른 사용자 탭의 신호(토큰·활동·로그아웃)는 따르지 않고, 로그아웃한 탭은 갱신 신호로 다시 로그인되지 않는다", async () => {
    const { a, b } = pair();
    a.session.signIn("operator", tokens(30));
    const other = {
      ...tokens(15),
      accessToken: fakeAccess({
        sub: "someone-else",
        exp: AUTH_SEC + 15 * 60,
        auth_time: AUTH_SEC,
      }),
    };
    b.session.signIn("operator", other);
    const idleEnd = () => {
      const snap = b.session.getSnapshot();
      return snap.status === "signed_out" ? null : snap.times.idleEndAt;
    };
    const before = idleEnd();
    await a.advance(10 * MIN);
    a.session.touch();
    // a가 더 늦게 만료되는 토큰을 가졌지만 다른 사용자라 b는 받지 않음
    expect(await b.session.accessToken()).toBe(other.accessToken);
    expect(idleEnd()).toBe(before);
    void a.session.logout();
    expect(b.session.getSnapshot()).toMatchObject({ status: "signed_in" });

    // 로그아웃한 탭(a)은 b의 신호로 다시 로그인되지 않음
    b.session.touch();
    expect(a.session.getSnapshot()).toMatchObject({ status: "signed_out" });
  });

  it("멈춰 있던 탭이 옛 활동 시각으로 유휴 만료를 보내도 쓰던 탭은 로그아웃되지 않는다", async () => {
    const { a, b } = pair({
      refresh: vi.fn(async () => tokens(500, AUTH_SEC, 2)),
    });
    a.session.signIn("operator", tokens(500));
    b.session.join();
    // b가 멈춘 동안(신호를 못 받음) a에서 계속 씀
    const deliver = a.deps.channel!.post;
    a.deps.channel!.post = (m) => a.posted.push(m);
    for (let i = 0; i < 3; i++) {
      await a.advance(28 * MIN);
      a.session.touch();
    }
    a.deps.channel!.post = deliver;
    // b가 깨어나 자기 기준 유휴 만료 → 먼저 a에 물어보고 a의 늦은 활동 시각을 받아 이어 감
    await b.advance(84 * MIN + JOIN_WAIT_MS);
    expect(b.session.getSnapshot()).toMatchObject({ status: "signed_in" });
    expect(a.session.getSnapshot()).toMatchObject({ status: "signed_in" });
  });

  it("쓰던 탭은 같은 묶음의 유휴 만료 신호를 받아도 로그아웃되지 않고, 직접 로그아웃 신호는 따른다", () => {
    const { session, other } = setup();
    session.signIn("operator", tokens());
    const group = { pool: "operator", sub: "operator-sub", authTimeMs: AUTH };
    other({ kind: "logout", reason: "idle", ...group });
    expect(session.getSnapshot()).toMatchObject({ status: "signed_in" });
    other({ kind: "logout", reason: "logout", ...group, authTimeMs: 1 });
    expect(session.getSnapshot()).toEqual({
      status: "signed_out",
      reason: "other_tab",
    });
  });

  it("다시 로그인을 기다리던 탭은 다른 탭이 같은 계정으로 다시 로그인하면 이어 간다", async () => {
    const { a, b } = pair({
      refresh: vi.fn(async () => {
        throw new Error("revoked");
      }),
    });
    a.session.signIn("operator", tokens());
    b.session.join();
    await a.advance(14 * MIN + 2_000);
    await b.advance(14 * MIN + 2_000);
    expect(a.session.getSnapshot().status).toBe("reauth_required");
    expect(b.session.getSnapshot().status).toBe("reauth_required");
    const generation = (s: AuthSession) => {
      const snap = s.getSnapshot();
      return snap.status === "signed_out" ? null : snap.generation;
    };
    const bBefore = generation(b.session);
    const fresh = tokens(60, AUTH_SEC + 900, 9);
    expect(a.session.reauthenticate(fresh)).toBe(true);
    expect(b.session.getSnapshot().status).toBe("signed_in");
    expect(generation(b.session)).toBe(bBefore! + 1);
    expect(await b.session.accessToken()).toBe(fresh.accessToken);
  });

  it("데모 로그인 화면의 넘겨받기는 운영자 탭에서 받지 않는다", () => {
    const { a, b } = pair();
    a.session.signIn("operator", tokens());
    b.session.join("demo");
    expect(b.session.getSnapshot()).toMatchObject({
      status: "signed_out",
      joining: true,
    });
  });

  it("한 탭이 갱신하면 다른 탭은 새 토큰을 받아 다시 갱신하지 않는다", async () => {
    const { a, b } = pair();
    a.session.signIn("operator", tokens());
    b.session.join();
    await a.advance(14 * MIN);
    expect(a.deps.refresh).toHaveBeenCalledTimes(1);
    await b.advance(14 * MIN);
    expect(b.deps.refresh).not.toHaveBeenCalled();
    expect(await b.session.accessToken()).toBe(
      tokens(30, AUTH_SEC, 2).accessToken,
    );
  });

  it("넘겨받기는 탭마다 한 번만 하고, 넘겨받은 것도 활동으로 다른 탭에 알린다", async () => {
    const { a, b } = pair({
      refresh: vi.fn(async () => tokens(500, AUTH_SEC, 2)),
    });
    a.session.signIn("operator", tokens(500));
    await a.advance(30 * MIN);
    await b.advance(30 * MIN);
    b.session.join();
    expect(b.session.getSnapshot()).toMatchObject({ status: "signed_in" });
    // a는 0분 뒤로 활동이 없지만 b를 연 30분부터 다시 셈 → 70분에도 로그인
    await a.advance(40 * MIN);
    expect(a.session.getSnapshot()).toMatchObject({ status: "signed_in" });
    void b.session.logout();
    b.session.join();
    expect(b.session.getSnapshot()).toEqual({
      status: "signed_out",
      reason: "logout",
    });
  });

  it("다시 로그인을 기다리던 탭이 다른 탭의 새 토큰으로 풀리면 generation이 는다", async () => {
    const { a, b } = pair();
    a.session.signIn("operator", tokens());
    b.session.join();
    expect(b.session.getSnapshot()).toMatchObject({ generation: 1 });
    // b만 갱신 실패로 다시 로그인 상태로 둠
    (b.deps.refresh as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("NotAuthorizedException"),
    );
    await b.advance(14 * MIN);
    await b.advance(2_000);
    expect(b.session.getSnapshot()).toMatchObject({
      status: "reauth_required",
    });
    await a.advance(14 * MIN);
    expect(b.session.getSnapshot()).toMatchObject({
      status: "signed_in",
      generation: 2,
    });
  });

  it("한 탭에서 쓰는 동안 다른 탭의 유휴 시각도 늦춰져 함께 로그아웃되지 않는다", async () => {
    const { a, b } = pair({
      refresh: vi.fn(async () => tokens(500, AUTH_SEC, 2)),
    });
    a.session.signIn("operator", tokens(500));
    b.session.join();
    await a.advance(50 * MIN);
    await b.advance(50 * MIN);
    b.session.touch();
    await a.advance(20 * MIN);
    expect(a.session.getSnapshot()).toMatchObject({ status: "signed_in" });
  });
});

// 2026-11-04 사용자 결정(D17-11): refresh token만 이 탭의 저장소에 두고 새로고침해도 이어 감
describe("새로고침해도 로그인 유지", () => {
  function memoryStore(initial: SavedSession | null = null) {
    let value: unknown = initial;
    return {
      load: () => value,
      save: vi.fn((saved: SavedSession | null) => {
        value = saved;
      }),
      get: () => value,
    };
  }

  const SAVED: SavedSession = {
    pool: "operator",
    sub: "operator-sub",
    refreshToken: "refresh-1",
    authTimeMs: AUTH,
    lastActivityMs: AUTH,
  };

  // 새로고침한 탭: 저장 값을 가진 채 10분 뒤에 열림
  function reloaded(saved: SavedSession | null = SAVED) {
    const store = memoryStore(saved);
    const tab = setup({ store, newId: () => "tab-new" });
    tab.setNow(AUTH + 10 * MIN);
    return { ...tab, store };
  }

  it("로그인하면 refresh token·최초 인증·활동 시각만 두고, 갱신하면 회전된 토큰으로 바꾸고, 로그아웃하면 지운다", async () => {
    const store = memoryStore();
    const { session, advance } = setup({ store });
    session.signIn("operator", tokens());
    expect(store.get()).toEqual(SAVED);
    expect(JSON.stringify(store.get())).not.toMatch(/eyJ/);
    await advance(14 * MIN);
    expect(store.get()).toMatchObject({ refreshToken: "refresh-2" });
    await session.logout();
    expect(store.get()).toBeNull();
  });

  it("열린 탭이 없으면 저장한 refresh token으로 갱신해 같은 최초 인증으로 이어 간다(그동안 로그인 화면을 그리지 않음)", async () => {
    const { session, deps, advance, store } = reloaded();
    session.join();
    expect(session.getSnapshot()).toMatchObject({ joining: true });
    await advance(JOIN_WAIT_MS);
    expect(deps.refresh).toHaveBeenCalledWith("operator", "refresh-1");
    expect(session.getSnapshot()).toMatchObject({
      status: "signed_in",
      pool: "operator",
      email: "ops@example.test",
      times: { maxEndAt: AUTH + 8 * 60 * MIN },
    });
    expect(store.get()).toMatchObject({
      refreshToken: "refresh-2",
      lastActivityMs: AUTH + 10 * MIN + JOIN_WAIT_MS,
    });
  });

  it("갱신하는 동안 로그인 화면을 그리지 않는다", async () => {
    let finish: (t: Tokens) => void = () => undefined;
    const store = memoryStore(SAVED);
    const tab = setup({
      store,
      refresh: vi.fn(() => new Promise<Tokens>((done) => (finish = done))),
    });
    tab.session.join();
    await tab.advance(JOIN_WAIT_MS);
    expect(tab.session.getSnapshot()).toMatchObject({
      status: "signed_out",
      joining: true,
    });
    finish(tokens(30, AUTH_SEC, 2));
    await new Promise((done) => setTimeout(done, 0));
    expect(tab.session.getSnapshot()).toMatchObject({ status: "signed_in" });
  });

  it("유휴 60분이나 최초 인증 8시간이 지난 저장 값은 쓰지 않고 지운다", async () => {
    for (const now of [AUTH + 60 * MIN, AUTH + 8 * 60 * MIN]) {
      const saved =
        now === AUTH + 60 * MIN ? SAVED : { ...SAVED, lastActivityMs: now };
      const { session, deps, setNow, advance, store } = reloaded(saved);
      setNow(now);
      session.join();
      await advance(JOIN_WAIT_MS);
      expect(deps.refresh).not.toHaveBeenCalled();
      expect(session.getSnapshot()).toEqual({
        status: "signed_out",
        reason: null,
      });
      expect(store.get()).toBeNull();
    }
  });

  it("갱신이 실패하거나 다른 계정·다른 최초 인증의 토큰이면 지우고 로그인 화면으로", async () => {
    const answers: (() => Promise<Tokens>)[] = [
      () => Promise.reject(new Error("NotAuthorizedException")),
      async () => tokens(30, AUTH_SEC + 60, 2),
      async () => ({
        ...tokens(30, AUTH_SEC, 2),
        accessToken: fakeAccess({
          sub: "other-sub",
          exp: AUTH_SEC + 30 * 60,
        }),
      }),
    ];
    for (const answer of answers) {
      const store = memoryStore(SAVED);
      const tab = setup({ store, refresh: vi.fn(answer) });
      tab.session.join();
      await tab.advance(JOIN_WAIT_MS);
      expect(tab.session.getSnapshot()).toEqual({
        status: "signed_out",
        reason: null,
      });
      expect(store.get()).toBeNull();
    }
  });

  it("데모 로그인 화면은 운영자 저장 값으로 이어 가지 않는다", async () => {
    const { session, deps, advance, store } = reloaded();
    session.join("demo");
    await advance(JOIN_WAIT_MS);
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toEqual({
      status: "signed_out",
      reason: null,
    });
    expect(store.get()).toEqual(SAVED);
  });

  it("열린 탭이 답하면 저장 값으로 갱신하지 않고 넘겨받은 토큰을 저장한다", async () => {
    const a = setup({ newId: () => "tab-a" });
    const b = reloaded({ ...SAVED, refreshToken: "refresh-old" });
    a.deps.channel!.post = (m) => b.other(m);
    b.deps.channel!.post = (m) => a.other(m);
    a.session.signIn("operator", tokens());
    b.session.join();
    await b.advance(JOIN_WAIT_MS);
    expect(b.deps.refresh).not.toHaveBeenCalled();
    expect(b.session.getSnapshot()).toMatchObject({ status: "signed_in" });
    expect(b.store.get()).toMatchObject({ refreshToken: "refresh-1" });
  });

  it("다른 탭의 로그아웃 신호로 로그아웃하면 저장 값도 지운다", () => {
    const store = memoryStore();
    const { session, other } = setup({ store });
    session.signIn("operator", tokens());
    other({
      kind: "logout",
      reason: "logout",
      pool: "operator",
      sub: "operator-sub",
      authTimeMs: AUTH,
    });
    expect(store.get()).toBeNull();
  });
});
