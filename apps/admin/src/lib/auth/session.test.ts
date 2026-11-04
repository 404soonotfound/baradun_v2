import { describe, expect, it, vi } from "vitest";
import { AuthSession, JOIN_WAIT_MS, type SessionDeps } from "./session";
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
    await advance(2 * MIN);
    expect(session.getSnapshot()).toEqual({
      status: "signed_out",
      reason: "idle",
    });
    expect(posted).toEqual(["logout"]);
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
    expect(a.posted).toEqual(["logout"]);

    const b = setup();
    b.session.signIn("operator", tokens());
    b.other("logout");
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

// 새 탭 넘겨받기·탭 사이 갱신 (2026-11-04 사용자 결정, D16-A10 변경). 토큰은 메모리에만
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

  it("로그아웃한 탭은 다른 탭의 갱신 신호로 다시 로그인되지 않고, 다른 계정 신호는 받지 않는다", () => {
    const { a, b } = pair();
    a.session.signIn("operator", tokens());
    b.session.signIn("operator", {
      ...tokens(),
      accessToken: fakeAccess({
        sub: "someone-else",
        exp: AUTH_SEC + 30 * 60,
        auth_time: AUTH_SEC,
      }),
    });
    a.session.touch();
    // b는 다른 사용자라 a의 신호로 토큰이 바뀌지 않음
    expect(b.deps.refresh).not.toHaveBeenCalled();
    void a.session.logout();
    expect(b.session.getSnapshot()).toMatchObject({ status: "signed_out" });
    a.session.touch();
    expect(b.session.getSnapshot()).toMatchObject({ status: "signed_out" });
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
