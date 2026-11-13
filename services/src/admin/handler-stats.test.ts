import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { handleOps, type OpsDependencies } from "./handler";
import { ACCESS_TOKEN_HEADER } from "./policy";
import { FakeTable } from "./test-dynamo";
import { TEST_CONFIG } from "./test-tokens";
import { unconfiguredStats, type StatsReader } from "./stats";

const NOW = new Date("2026-11-13T03:00:00Z");
const NOW_SEC = NOW.getTime() / 1000;
const ISS = (pool: string) =>
  `https://cognito-idp.ap-northeast-2.amazonaws.com/${pool}`;

function tokenOf(group: "viewer" | "sample"): string {
  const payload =
    group === "sample"
      ? {
          sub: "u-sample",
          token_use: "access",
          auth_time: NOW_SEC - 60,
          exp: NOW_SEC + 300,
          iss: ISS(TEST_CONFIG.sample.userPoolId),
          client_id: TEST_CONFIG.sample.clientId,
          "cognito:groups": ["sample"],
        }
      : {
          sub: "u-viewer",
          token_use: "access",
          auth_time: NOW_SEC - 60,
          exp: NOW_SEC + 300,
          iss: ISS(TEST_CONFIG.operator.userPoolId),
          client_id: TEST_CONFIG.operator.clientId,
          "cognito:groups": ["viewer"],
        };
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

const VIEWER_TOKEN = tokenOf("viewer");
const SAMPLE_TOKEN = tokenOf("sample");

function makeDeps(stats?: StatsReader | null): OpsDependencies {
  const client = new FakeTable();
  return {
    auth: {
      config: TEST_CONFIG,
      verifier: {
        verify: async (token) => {
          if (token === VIEWER_TOKEN) {
            return {
              sub: "u-viewer",
              token_use: "access",
              auth_time: NOW_SEC - 60,
              exp: NOW_SEC + 300,
              iss: ISS(TEST_CONFIG.operator.userPoolId),
              client_id: TEST_CONFIG.operator.clientId,
              "cognito:groups": ["viewer"],
            };
          }
          if (token === SAMPLE_TOKEN) {
            return {
              sub: "u-sample",
              token_use: "access",
              auth_time: NOW_SEC - 60,
              exp: NOW_SEC + 300,
              iss: ISS(TEST_CONFIG.sample.userPoolId),
              client_id: TEST_CONFIG.sample.clientId,
              "cognito:groups": ["sample"],
            };
          }
          throw new Error("bad token");
        },
      },
      samplePolicy: async () => ({
        subs: ["u-sample"],
        allowedFrom: new Date(NOW.getTime() - 3_600_000),
        allowedUntil: new Date(NOW.getTime() + 3_600_000),
      }),
      now: () => NOW,
    },
    data: {
      client,
      opsTable: "ops",
      inquiryTable: "inq",
      now: () => NOW,
      stats: stats ?? null,
    },
  };
}

function statsEvent(
  token: string,
  range?: string,
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: "GET /ops/stats",
    rawPath: "/ops/stats",
    rawQueryString: range ? `range=${range}` : "",
    ...(range ? { queryStringParameters: { range } } : {}),
    headers: { [ACCESS_TOKEN_HEADER]: token },
    requestContext: {
      http: {
        method: "GET",
        path: "/ops/stats",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "vitest",
      },
    } as APIGatewayProxyEventV2["requestContext"],
    isBase64Encoded: false,
  };
}

describe("GET /ops/stats (#333 ADM-STATS)", () => {
  it("잘못된 range 파라미터는 400 invalid_request를 반환함", async () => {
    const res = await handleOps(statsEvent(VIEWER_TOKEN, "90d"), makeDeps());
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? "{}")).toMatchObject({
      error: { code: "invalid_request" },
    });
  });

  it("stats 리더가 없으면 configured: false를 반환함", async () => {
    const res = await handleOps(statsEvent(VIEWER_TOKEN, "7d"), makeDeps(null));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body ?? "{}")).toMatchObject({
      configured: false,
      range: "7d",
    });
  });

  it("stats 리더가 있으면 해당 range로 조회해 반환함", async () => {
    const read = vi.fn<StatsReader["read"]>(async (range) => ({
      ...unconfiguredStats(range, NOW),
      configured: true,
      realtime: { status: "ok", activeUsers: 7, pageViews: 15 },
    }));
    const res = await handleOps(
      statsEvent(VIEWER_TOKEN, "28d"),
      makeDeps({ read }),
    );
    expect(res.statusCode).toBe(200);
    expect(read).toHaveBeenCalledWith("28d");
    expect(JSON.parse(res.body ?? "{}")).toMatchObject({
      configured: true,
      range: "28d",
      realtime: { status: "ok", activeUsers: 7, pageViews: 15 },
    });
  });

  it("샘플 계정은 실제 stats 리더를 부르지 않고 예시 통계를 반환함", async () => {
    const read = vi.fn<StatsReader["read"]>();
    const res = await handleOps(
      statsEvent(SAMPLE_TOKEN, "today"),
      makeDeps({ read }),
    );
    expect(res.statusCode).toBe(200);
    expect(read).not.toHaveBeenCalled();
    expect(JSON.parse(res.body ?? "{}")).toMatchObject({
      configured: true,
      range: "today",
      realtime: { status: "ok" },
    });
  });
});
