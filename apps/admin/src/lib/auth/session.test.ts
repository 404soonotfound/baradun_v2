import { describe, expect, it, vi } from "vitest";
import { AuthSession, type SessionDeps } from "./session";
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
  const posted: string[] = [];
  let listener: ((m: string) => void) | undefined;
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
    refresh: vi.fn(async () => tokens(30, AUTH_SEC, 2)),
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
      await Promise.resolve();
      await Promise.resolve();
    }
    now = until;
  };
  return {
    session,
    deps,
    posted,
    advance,
    other: (m: string) => listener?.(m),
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
    await advance(14 * MIN);
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
