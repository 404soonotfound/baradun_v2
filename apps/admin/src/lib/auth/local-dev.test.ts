import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_DEV_MARKER } from "../../../scripts/check-out.mts";
import {
  LOCAL_EMAIL,
  LOCAL_MARKER,
  attachLocalSession,
  isLocalToken,
  localOps,
  localPoolOf,
  localRefresh,
  localTokens,
} from "./local-dev";
import { SESSION } from "./policy";
import { AuthSession } from "./session";
import { fakeAccess, fakeJwt } from "./test-helpers";
import { accessClaims, idClaims } from "./tokens";

// 로컬 개발 서버 전용 테스트 로그인 (BRD-172)

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 4, 1, 0, 0);

describe("로컬 토큰", () => {
  it("빌드 결과 검사와 같은 표시를 쓴다(배포 빌드에 남으면 검사가 잡음)", () => {
    expect(LOCAL_MARKER).toBe(LOCAL_DEV_MARKER);
  });

  it("세션이 읽는 클레임 모양이고, 운영자 풀은 노출 변경·데모 풀은 샘플 그룹", () => {
    const tokens = localTokens("operator", T0, T0 + 5 * MIN);
    expect(accessClaims(tokens.accessToken)).toEqual({
      sub: "local-tester",
      expMs: T0 + 20 * MIN,
      authTimeMs: T0,
      groups: ["publisher"],
    });
    expect(idClaims(tokens.idToken).email).toBe(LOCAL_EMAIL);
    expect(localPoolOf(tokens.accessToken)).toBe("operator");
    expect(localPoolOf(localTokens("demo", T0, T0).accessToken)).toBe("demo");
  });

  it("갱신은 최초 인증 시각을 그대로 잇고, 실제 refresh token은 건드리지 않는다", () => {
    const { refreshToken } = localTokens("demo", T0, T0);
    expect(isLocalToken(refreshToken)).toBe(true);
    const next = localRefresh(refreshToken, T0 + 30 * MIN);
    expect(accessClaims(next?.accessToken ?? "")?.authTimeMs).toBe(T0);
    expect(localRefresh("eyJjdHkiOiJKV1QifQ.real.refresh", T0)).toBeNull();
    expect(isLocalToken("eyJhbGciOiJSUzI1NiJ9.e30.c2ln")).toBe(false);
  });
});

describe("로컬 샘플 응답", () => {
  it("/ops/me는 풀에 맞는 계정 종류를, 아직 없는 경로는 501을 준다(빈 성공으로 꾸미지 않음)", () => {
    expect(localOps("/ops/me", "operator", {})).toMatchObject({
      ok: true,
      body: { kind: "operator", role: "publisher" },
    });
    expect(localOps("/ops/me", "demo", {})).toMatchObject({
      ok: true,
      body: { kind: "sample" },
    });
    expect(localOps("/ops/stats", "operator", {})).toEqual({
      ok: false,
      status: 501,
      code: "local_sample_missing",
      requestId: null,
    });
  });
});

describe("로컬 예시 데이터 게시 (#331)", () => {
  it("게시 현황을 주고, 데모 계정은 서버처럼 403", () => {
    expect(localOps("/ops/publish", "operator", {})).toMatchObject({
      ok: true,
      body: { current: { ok: true }, history: { ok: true } },
    });
    expect(localOps("/ops/publish", "demo", {})).toMatchObject({
      ok: false,
      status: 403,
    });
  });
});

describe("로컬 예시 문의 (BRD-153)", () => {
  it("첫 쪽에만 상태별 수를 주고, cursor로 다음 쪽을 이어 가며, 없는 문의는 404", () => {
    const first = localOps<{
      items: { inquiryId: string }[];
      nextCursor: string | null;
      counts?: Record<string, number>;
    }>("/ops/inquiries?limit=20", "operator", {});
    if (!first.ok) throw new Error("첫 쪽 실패");
    expect(first.body.items).toHaveLength(20);
    expect(first.body.counts).toBeDefined();
    const next = localOps<{ items: unknown[]; counts?: unknown }>(
      `/ops/inquiries?limit=20&cursor=${first.body.nextCursor}`,
      "operator",
      {},
    );
    if (!next.ok) throw new Error("다음 쪽 실패");
    expect(next.body.counts).toBeUndefined();
    expect(
      localOps(
        `/ops/inquiries/${first.body.items[0]!.inquiryId}`,
        "operator",
        {},
      ),
    ).toMatchObject({ ok: true, body: { restricted: false } });
    expect(localOps("/ops/inquiries/nope", "operator", {})).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe("새로고침해도 이어 가기", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    store = new Map();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const newSession = () =>
    new AuthSession({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      refresh: async (_pool, token) => {
        const next = localRefresh(token, Date.now());
        if (!next) throw new Error("not local");
        return next;
      },
      revoke: async () => undefined,
    });

  it("로그인하면 시각만 저장하고, 새 탭 객체에서 같은 최초 인증으로 이어진다", () => {
    const first = newSession();
    const stop = attachLocalSession(first);
    first.signIn("operator", localTokens("operator", T0, T0));
    const saved = store.get(LOCAL_MARKER) ?? "";
    expect(JSON.parse(saved)).toEqual({
      pool: "operator",
      authTimeMs: T0,
      idleEndAt: T0 + SESSION.idleMs,
    });
    expect(saved).not.toContain("local-tester"); // 토큰은 저장하지 않음
    stop();

    vi.setSystemTime(T0 + 59 * MIN);
    const reloaded = newSession();
    attachLocalSession(reloaded);
    expect(reloaded.getSnapshot()).toMatchObject({
      status: "signed_in",
      email: LOCAL_EMAIL,
      times: { maxEndAt: T0 + SESSION.maxMs },
    });
  });

  it("60분 넘게 쓰지 않았으면 잇지 않고, 로그아웃하면 저장한 시각을 지운다", async () => {
    const first = newSession();
    attachLocalSession(first);
    first.signIn("operator", localTokens("operator", T0, T0));

    vi.setSystemTime(T0 + SESSION.idleMs);
    const late = newSession();
    attachLocalSession(late);
    expect(late.getSnapshot().status).toBe("signed_out");
    expect(store.has(LOCAL_MARKER)).toBe(false);

    vi.setSystemTime(T0);
    const again = newSession();
    attachLocalSession(again);
    again.signIn("operator", localTokens("operator", T0, T0));
    await again.logout();
    expect(store.has(LOCAL_MARKER)).toBe(false);
  });

  it("실제 계정 로그인은 저장하지 않는다", () => {
    const session = newSession();
    attachLocalSession(session);
    session.signIn("operator", {
      accessToken: fakeAccess({ exp: T0 / 1000 + 900, auth_time: T0 / 1000 }),
      idToken: fakeJwt({ email: "ops@example.test" }),
      refreshToken: "real-refresh",
    });
    expect(session.getSnapshot().status).toBe("signed_in");
    expect(store.has(LOCAL_MARKER)).toBe(false);
  });
});
