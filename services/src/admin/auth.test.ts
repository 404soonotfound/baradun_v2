import { FetchError } from "aws-jwt-verify/error";
import { SimpleJwksCache } from "aws-jwt-verify/jwk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  allowsSample,
  authenticate,
  createTokenVerifier,
  type AuthDependencies,
} from "./auth";
import { OPS_SESSION_MAX_MS } from "./policy";
import type { SamplePolicy } from "./sample";
import {
  accessClaims,
  issuer,
  newKey,
  signToken,
  TEST_CONFIG,
  type TestKey,
} from "./test-tokens";

// 운영 API 토큰 검증 (BRD-146, D16-A3·A7·A8)
// 서명 검증은 실제 aws-jwt-verify로 함(공개 키만 캐시에 넣음)

const SAMPLE_SUB = "99999999-8888-7777-6666-555555555555";

let operatorKey: TestKey;
let sampleKey: TestKey;
let strangerKey: TestKey;
let verifier: ReturnType<typeof createTokenVerifier>;

beforeAll(() => {
  operatorKey = newKey("operator-kid");
  sampleKey = newKey("sample-kid");
  strangerKey = newKey("stranger-kid");
  // 모르는 kid가 와도 JWKS를 내려받지 않게 막음 → 테스트가 네트워크에 기대지 않음
  verifier = createTokenVerifier(
    TEST_CONFIG,
    new SimpleJwksCache({
      fetcher: {
        fetch: async () => {
          throw new Error("테스트에서 JWKS 다운로드 금지");
        },
      },
    }),
  );
  verifier.cacheJwks(
    { keys: [operatorKey.jwk] } as never,
    TEST_CONFIG.operator.userPoolId,
  );
  verifier.cacheJwks(
    { keys: [sampleKey.jwk] } as never,
    TEST_CONFIG.sample.userPoolId,
  );
});

// exp는 검증기가 실제 시계로 보므로 테스트 시각도 실제 시각에 맞춤
const nowSec = () => Math.floor(Date.now() / 1000);

function deps(policy: SamplePolicy | null = null): AuthDependencies {
  return {
    config: TEST_CONFIG,
    verifier,
    samplePolicy: async () => policy,
    now: () => new Date(),
  };
}

function sampleClaims(overrides: Record<string, unknown> = {}) {
  return accessClaims(nowSec(), {
    sub: SAMPLE_SUB,
    iss: issuer(TEST_CONFIG.sample.userPoolId),
    client_id: TEST_CONFIG.sample.clientId,
    "cognito:groups": ["sample"],
    ...overrides,
  });
}

function openPolicy(): SamplePolicy {
  return {
    subs: [SAMPLE_SUB],
    allowedFrom: new Date(Date.now() - 3_600_000),
    allowedUntil: new Date(Date.now() + 3_600_000),
  };
}

describe("운영자 토큰", () => {
  it("운영자 풀 access token이면 그 그룹을 역할로 받는다", async () => {
    const result = await authenticate(
      signToken(operatorKey, accessClaims(nowSec())),
      deps(),
    );
    expect(result).toEqual({
      ok: true,
      principal: expect.objectContaining({
        kind: "operator",
        role: "publisher",
      }),
    });
  });

  it("토큰이 없으면 거부한다", async () => {
    expect(await authenticate(undefined, deps())).toEqual({
      ok: false,
      reason: "missing_token",
    });
  });

  it.each([
    [
      "다른 키로 서명(위조)",
      () => signToken(strangerKey, accessClaims(nowSec())),
    ],
    [
      "ID token",
      () => signToken(operatorKey, accessClaims(nowSec(), { token_use: "id" })),
    ],
    [
      "다른 앱 클라이언트",
      () =>
        signToken(operatorKey, accessClaims(nowSec(), { client_id: "other" })),
    ],
    [
      "다른 풀 발급자",
      () =>
        signToken(
          operatorKey,
          accessClaims(nowSec(), { iss: issuer("ap-northeast-2_Unknown01") }),
        ),
    ],
    [
      "만료된 토큰",
      () =>
        signToken(operatorKey, accessClaims(nowSec(), { exp: nowSec() - 10 })),
    ],
    [
      "샘플 풀 키로 서명한 운영자 풀 토큰",
      () => signToken(sampleKey, accessClaims(nowSec())),
    ],
    ["형식이 틀린 문자열", () => "not-a-jwt"],
    [
      "디코딩만 한 값(서명 없음)",
      () =>
        signToken(operatorKey, accessClaims(nowSec()))
          .split(".")
          .slice(0, 2)
          .join(".") + ".",
    ],
  ])("%s는 invalid_token", async (_, token) => {
    expect(await authenticate(token(), deps())).toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });

  it("auth_time이 없거나 숫자가 아니면 거부한다", async () => {
    for (const authTime of [undefined, "1793683955"]) {
      const result = await authenticate(
        signToken(operatorKey, accessClaims(nowSec(), { auth_time: authTime })),
        deps(),
      );
      expect(result).toEqual({ ok: false, reason: "invalid_token" });
    }
  });

  it("최초 인증 8시간이 되면 새 토큰이어도 거부하고, 1초 전에는 받는다", async () => {
    const limitSec = OPS_SESSION_MAX_MS / 1000;
    const expired = await authenticate(
      signToken(
        operatorKey,
        accessClaims(nowSec(), { auth_time: nowSec() - limitSec }),
      ),
      deps(),
    );
    expect(expired).toEqual({ ok: false, reason: "session_expired" });

    const justBefore = await authenticate(
      signToken(
        operatorKey,
        accessClaims(nowSec(), { auth_time: nowSec() - limitSec + 5 }),
      ),
      deps(),
    );
    expect(justBefore.ok).toBe(true);
  });

  it("미래의 auth_time은 거부한다", async () => {
    const result = await authenticate(
      signToken(
        operatorKey,
        accessClaims(nowSec(), { auth_time: nowSec() + 600 }),
      ),
      deps(),
    );
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it.each([
    ["그룹 없음", []],
    ["알 수 없는 그룹만", ["admin"]],
    ["운영자 그룹 2개", ["viewer", "publisher"]],
    ["샘플 그룹 섞임", ["viewer", "sample"]],
  ])("%s이면 보기로 낮추지 않고 거부한다", async (_, groups) => {
    const result = await authenticate(
      signToken(
        operatorKey,
        accessClaims(nowSec(), { "cognito:groups": groups }),
      ),
      deps(),
    );
    expect(result).toEqual({ ok: false, reason: "role_unclear" });
  });
});

describe("공개 키를 받지 못함", () => {
  it("JWKS 다운로드 실패는 잘못된 토큰(401)이 아니라 장애로 던진다", async () => {
    // 캐시에 없는 kid라 다운로드를 시도함 → 테스트 가짜 fetcher가 FetchError를 던짐
    const failing = createTokenVerifier(
      TEST_CONFIG,
      new SimpleJwksCache({
        fetcher: {
          fetch: async (uri: string) => {
            throw new FetchError(uri, "network down");
          },
        },
      }),
    );
    await expect(
      authenticate(signToken(strangerKey, accessClaims(nowSec())), {
        ...deps(),
        verifier: failing,
      }),
    ).rejects.toBeInstanceOf(FetchError);
  });
});

describe("샘플 토큰", () => {
  it("허용 목록·허용 기간 안이면 샘플로 받는다", async () => {
    const result = await authenticate(
      signToken(sampleKey, sampleClaims()),
      deps(openPolicy()),
    );
    expect(result).toEqual({
      ok: true,
      principal: expect.objectContaining({ kind: "sample", sub: SAMPLE_SUB }),
    });
  });

  it("설정이 없으면 거부한다", async () => {
    const result = await authenticate(
      signToken(sampleKey, sampleClaims()),
      deps(null),
    );
    expect(result).toEqual({ ok: false, reason: "sample_not_allowed" });
  });

  it("허용 목록에 없는 sub는 거부한다", async () => {
    const result = await authenticate(
      signToken(sampleKey, sampleClaims({ sub: "someone-else" })),
      deps(openPolicy()),
    );
    expect(result).toEqual({ ok: false, reason: "sample_not_allowed" });
  });

  it("샘플 풀 토큰에 운영자 그룹이 있으면 거부한다(샘플 풀은 sample만)", async () => {
    const result = await authenticate(
      signToken(sampleKey, sampleClaims({ "cognito:groups": ["publisher"] })),
      deps(openPolicy()),
    );
    expect(result).toEqual({ ok: false, reason: "role_unclear" });
  });

  it("운영자 풀 키로 서명한 샘플 풀 토큰은 거부한다", async () => {
    const result = await authenticate(
      signToken(operatorKey, sampleClaims()),
      deps(openPolicy()),
    );
    expect(result).toEqual({ ok: false, reason: "invalid_token" });
  });

  it("허용 기간은 시작 포함·끝 제외다", () => {
    const from = new Date("2026-11-03T00:00:00Z");
    const until = new Date("2026-11-04T00:00:00Z");
    const policy = {
      subs: [SAMPLE_SUB],
      allowedFrom: from,
      allowedUntil: until,
    };
    expect(allowsSample(policy, SAMPLE_SUB, from)).toBe(true);
    expect(
      allowsSample(policy, SAMPLE_SUB, new Date(until.getTime() - 1)),
    ).toBe(true);
    expect(allowsSample(policy, SAMPLE_SUB, until)).toBe(false);
    expect(allowsSample(policy, SAMPLE_SUB, new Date(from.getTime() - 1))).toBe(
      false,
    );
  });
});
