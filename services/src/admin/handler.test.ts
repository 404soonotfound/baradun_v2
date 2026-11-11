import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import type { AuthDependencies } from "./auth";
import { handleOps } from "./handler";
import { ACCESS_TOKEN_HEADER } from "./policy";
import { TEST_CONFIG } from "./test-tokens";

// 운영 API 함수 (BRD-146). 토큰 검증 자체는 auth.test.ts, 여기서는 응답 모양·순서
// 검증기를 가짜로 바꿔 claims를 바로 돌려줌(서명 검사는 auth.test.ts가 실제로 함)

const IDS = { traceId: "trace-full-id", requestId: "req-abcd1234" };

// 업무 데이터를 쓰지 않는 경로용. 건드리면 테스트가 실패함
const NO_DATA = {
  client: {
    send: async () => {
      throw new Error("이 경로는 DB를 쓰면 안 됨");
    },
  },
  opsTable: "Ops",
  inquiryTable: "Inquiry",
  now: () => new Date("2026-11-03T06:00:00Z"),
};

function event(
  path: string,
  method: string,
  token?: string,
  extra: Record<string, string> = {},
): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    headers: { ...(token ? { [ACCESS_TOKEN_HEADER]: token } : {}), ...extra },
    requestContext: { http: { method } },
  } as unknown as APIGatewayProxyEventV2;
}

function authDeps(claims: Record<string, unknown> | Error): AuthDependencies {
  return {
    config: TEST_CONFIG,
    verifier: {
      verify: async () => {
        if (claims instanceof Error) throw claims;
        return claims;
      },
    },
    samplePolicy: async () => null,
    now: () => new Date("2026-11-03T06:00:00Z"),
  };
}

const AUTH_TIME = Date.parse("2026-11-03T05:00:00Z") / 1000;
const operatorClaims = {
  sub: "op",
  iss: `https://cognito-idp.ap-northeast-2.amazonaws.com/${TEST_CONFIG.operator.userPoolId}`,
  auth_time: AUTH_TIME,
  "cognito:groups": ["viewer"],
};

describe("handleOps", () => {
  it("/ops/me는 역할과 세션 끝 시각을 no-store로 돌려준다", async () => {
    const res = await handleOps(event("/ops/me", "GET", "t"), {
      auth: authDeps(operatorClaims),
      ids: () => IDS,
      data: NO_DATA,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      "cache-control": "no-store",
      "x-request-id": IDS.traceId,
    });
    expect(JSON.parse(res.body!)).toEqual({
      kind: "operator",
      role: "viewer",
      authTime: "2026-11-03T05:00:00.000Z",
      sessionExpiresAt: "2026-11-03T13:00:00.000Z",
    });
  });

  it("/ops/sources는 출처 목록과 키 상태를 돌려주고 키 값은 담지 않는다(ADM-SRC)", async () => {
    const res = await handleOps(event("/ops/sources", "GET", "t"), {
      auth: authDeps(operatorClaims),
      ids: () => IDS,
      data: {
        ...NO_DATA,
        client: { send: async () => ({ Items: [] }) },
        keys: {
          tags: async () => [{ Key: "expires", Value: "2027-03-31" }],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ "cache-control": "no-store" });
    const body = JSON.parse(res.body!);
    expect(body.sources).toHaveLength(5);
    expect(body.keys).toEqual([
      {
        name: "data-go-kr",
        status: "registered",
        expiresOn: "2027-03-31",
        daysLeft: 148,
        expiresInvalid: false,
      },
      {
        name: "kma-apihub",
        status: "registered",
        expiresOn: "2027-03-31",
        daysLeft: 148,
        expiresInvalid: false,
      },
    ]);
    expect(body.keysHidden).toBe(false);
    expect(res.body).not.toMatch(/ServiceKey|authKey/);
  });

  it("토큰이 없으면 401과 짧은 요청 번호·전체 ID를 돌려준다", async () => {
    const res = await handleOps(event("/ops/me", "GET"), {
      auth: authDeps(operatorClaims),
      ids: () => IDS,
      data: NO_DATA,
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body!)).toEqual({
      error: {
        code: "missing_token",
        requestId: IDS.requestId,
        traceId: IDS.traceId,
      },
    });
  });

  it("Authorization 헤더의 토큰은 받지 않는다(OAC 서명 자리)", async () => {
    const res = await handleOps(
      event("/ops/me", "GET", undefined, { authorization: "Bearer t" }),
      { auth: authDeps(operatorClaims), ids: () => IDS, data: NO_DATA },
    );
    expect(res.statusCode).toBe(401);
  });

  it("검증 실패는 401, 역할 불명확은 403", async () => {
    const invalid = await handleOps(event("/ops/me", "GET", "t"), {
      auth: authDeps(new Error("bad")),
      ids: () => IDS,
      data: NO_DATA,
    });
    expect(invalid.statusCode).toBe(401);
    const unclear = await handleOps(event("/ops/me", "GET", "t"), {
      auth: authDeps({ ...operatorClaims, "cognito:groups": [] }),
      ids: () => IDS,
      data: NO_DATA,
    });
    expect(unclear.statusCode).toBe(403);
    expect(JSON.parse(unclear.body!).error.code).toBe("role_unclear");
  });

  it("인증 뒤 없는 경로는 404, 없는 method는 405", async () => {
    const deps = {
      auth: authDeps(operatorClaims),
      ids: () => IDS,
      data: NO_DATA,
    };
    expect(
      (await handleOps(event("/ops/nope", "GET", "t"), deps)).statusCode,
    ).toBe(404);
    expect(
      (await handleOps(event("/ops/me", "POST", "t"), deps)).statusCode,
    ).toBe(405);
  });

  it("인증 전에는 경로가 있는지 알려 주지 않는다(없는 경로도 먼저 401)", async () => {
    const res = await handleOps(event("/ops/nope", "GET"), {
      auth: authDeps(operatorClaims),
      ids: () => IDS,
      data: NO_DATA,
    });
    expect(res.statusCode).toBe(401);
  });

  it("예상하지 못한 오류는 500이고 본문에 내부 정보를 넣지 않는다", async () => {
    const deps = {
      auth: {
        ...authDeps(operatorClaims),
        verifier: {
          verify: async () => {
            return {
              ...operatorClaims,
              iss: `https://cognito-idp.ap-northeast-2.amazonaws.com/${TEST_CONFIG.sample.userPoolId}`,
              "cognito:groups": ["sample"],
            };
          },
        },
        samplePolicy: async (): Promise<never> => {
          throw new Error("DynamoDB down");
        },
      },
      ids: () => IDS,
      data: NO_DATA,
    };
    const res = await handleOps(event("/ops/me", "GET", "t"), deps);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("DynamoDB");
    expect(JSON.parse(res.body!).error.code).toBe("internal");
  });

  describe("권한 거부 감시 로그 (D17-7)", () => {
    it("401·403 응답에만 ops_auth_denied 로그가 남고 다른 응답에는 남지 않는다", async () => {
      const logs: any[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((msg) => {
        try {
          logs.push(JSON.parse(msg));
        } catch {
          logs.push(msg);
        }
      });

      try {
        const deps = {
          auth: authDeps(operatorClaims),
          ids: () => IDS,
          data: NO_DATA,
        };

        // 1) 401: 토큰 누락
        logs.length = 0;
        const r401 = await handleOps(event("/ops/me", "GET"), deps);
        expect(r401.statusCode).toBe(401);
        const denied401 = logs.filter((l) => l.event === "ops_auth_denied");
        expect(denied401).toHaveLength(1);
        expect(denied401[0]).toEqual({
          level: "warn",
          event: "ops_auth_denied",
          status: 401,
          traceId: IDS.traceId,
        });

        // 2) 403: 역할 불명확
        logs.length = 0;
        const unclearDeps = {
          ...deps,
          auth: authDeps({ ...operatorClaims, "cognito:groups": [] }),
        };
        const r403 = await handleOps(event("/ops/me", "GET", "t"), unclearDeps);
        expect(r403.statusCode).toBe(403);
        const denied403 = logs.filter((l) => l.event === "ops_auth_denied");
        expect(denied403).toHaveLength(1);
        expect(denied403[0]).toEqual({
          level: "warn",
          event: "ops_auth_denied",
          status: 403,
          traceId: IDS.traceId,
        });

        // 3) 200: 정상
        logs.length = 0;
        const r200 = await handleOps(event("/ops/me", "GET", "t"), deps);
        expect(r200.statusCode).toBe(200);
        expect(logs.filter((l) => l.event === "ops_auth_denied")).toHaveLength(
          0,
        );

        // 4) 404: 없는 경로
        logs.length = 0;
        const r404 = await handleOps(event("/ops/nope", "GET", "t"), deps);
        expect(r404.statusCode).toBe(404);
        expect(logs.filter((l) => l.event === "ops_auth_denied")).toHaveLength(
          0,
        );

        // 5) 405: 잘못된 method
        logs.length = 0;
        const r405 = await handleOps(event("/ops/me", "POST", "t"), deps);
        expect(r405.statusCode).toBe(405);
        expect(logs.filter((l) => l.event === "ops_auth_denied")).toHaveLength(
          0,
        );

        // 6) 403: 인증은 통과했지만 역할이 모자람(라우터 거부, 열람자의 공지 만들기)
        logs.length = 0;
        const rRole = await handleOps(event("/ops/notices", "POST", "t"), deps);
        expect(rRole.statusCode).toBe(403);
        expect(logs.filter((l) => l.event === "ops_auth_denied")).toEqual([
          {
            level: "warn",
            event: "ops_auth_denied",
            status: 403,
            traceId: IDS.traceId,
          },
        ]);

        // 7) 403: 샘플 계정이 막힌 경로(sample.denied 감사 기록 뒤 거부)
        logs.length = 0;
        const sent: unknown[] = [];
        const sampleDeps = {
          auth: {
            ...authDeps({
              ...operatorClaims,
              sub: "sample-user",
              iss: `https://cognito-idp.ap-northeast-2.amazonaws.com/${TEST_CONFIG.sample.userPoolId}`,
              "cognito:groups": ["sample"],
            }),
            samplePolicy: async () => ({
              subs: ["sample-user"],
              allowedFrom: new Date("2026-11-01T00:00:00Z"),
              allowedUntil: new Date("2026-12-01T00:00:00Z"),
            }),
          },
          ids: () => IDS,
          data: {
            ...NO_DATA,
            client: {
              send: async (command: unknown) => {
                sent.push(command);
                return {};
              },
            },
          },
        };
        const rSample = await handleOps(
          event("/ops/audit", "GET", "t"),
          sampleDeps,
        );
        expect(rSample.statusCode).toBe(403);
        expect(sent).toHaveLength(1); // sample.denied 감사 기록
        expect(logs.filter((l) => l.event === "ops_auth_denied")).toHaveLength(
          1,
        );

        // 8) 500: 내부 오류는 권한 거부로 세지 않음
        logs.length = 0;
        const r500 = await handleOps(event("/ops/audit", "GET", "t"), {
          ...sampleDeps,
          data: {
            ...NO_DATA,
            client: {
              send: async () => {
                throw new Error("DynamoDB down");
              },
            },
          },
        });
        expect(r500.statusCode).toBe(500);
        expect(logs.filter((l) => l.event === "ops_auth_denied")).toHaveLength(
          0,
        );
      } finally {
        spy.mockRestore();
      }
    });
  });
});
