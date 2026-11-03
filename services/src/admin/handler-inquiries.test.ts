import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import type { AuthDependencies } from "./auth";
import { handleOps, type OpsDependencies } from "./handler";
import { ACCESS_TOKEN_HEADER, IDEMPOTENCY_KEY_HEADER } from "./policy";
import { FakeTable } from "./test-dynamo";
import { TEST_CONFIG } from "./test-tokens";

// 운영 API 문의 경로 (BRD-153). 토큰 검증은 가짜(claims를 바로 돌려줌), DB는 test-dynamo 가짜

const NOW = new Date("2026-11-03T06:00:00Z");
const NOW_SEC = NOW.getTime() / 1000;
const ID = "123e4567-e89b-42d3-a456-426614174000";
const KEY_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const KEY_B = "1f8fad5b-d9cb-469f-a165-70867728950e";
const ISS = (pool: string) =>
  `https://cognito-idp.ap-northeast-2.amazonaws.com/${pool}`;

function claims(group: string) {
  return group === "sample"
    ? {
        sub: "sample-sub",
        iss: ISS(TEST_CONFIG.sample.userPoolId),
        auth_time: NOW_SEC - 60,
        "cognito:groups": ["sample"],
      }
    : {
        sub: `${group}-sub`,
        iss: ISS(TEST_CONFIG.operator.userPoolId),
        auth_time: NOW_SEC - 60,
        "cognito:groups": [group],
      };
}

function deps(group: string, table: FakeTable): OpsDependencies {
  const auth: AuthDependencies = {
    config: TEST_CONFIG,
    verifier: { verify: async () => claims(group) },
    samplePolicy: async () => ({
      subs: ["sample-sub"],
      allowedFrom: new Date(NOW.getTime() - 3_600_000),
      allowedUntil: new Date(NOW.getTime() + 3_600_000),
    }),
    now: () => NOW,
  };
  return {
    auth,
    data: {
      client: table as never,
      opsTable: "Ops",
      inquiryTable: "Inquiry",
      now: () => NOW,
    },
    ids: () => ({ traceId: "trace", requestId: "req-00000000" }),
  };
}

function event(
  method: string,
  path: string,
  options: {
    query?: Record<string, string>;
    body?: unknown;
    idempotencyKey?: string;
  } = {},
): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    headers: {
      [ACCESS_TOKEN_HEADER]: "token",
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...(options.idempotencyKey
        ? { [IDEMPOTENCY_KEY_HEADER]: options.idempotencyKey }
        : {}),
    },
    queryStringParameters: options.query,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    isBase64Encoded: false,
    requestContext: { http: { method } },
  } as unknown as APIGatewayProxyEventV2;
}

function seeded(overrides: Record<string, unknown> = {}): FakeTable {
  const table = new FakeTable();
  table.items.set(table.id("Inquiry", { pk: `INQUIRY#${ID}` }), {
    pk: `INQUIRY#${ID}`,
    kind: "inquiry",
    inquiryId: ID,
    inquiryType: "data_error",
    message: "본문",
    receivedAt: "2026-11-02T00:00:00.000Z",
    inquiryStatus: "received",
    version: 1,
    ttl: NOW_SEC + 86_400,
    ...overrides,
  });
  return table;
}

const body = (res: { body?: string | undefined }) => JSON.parse(res.body!);

describe("문의 목록·상세", () => {
  it("편집 권한은 실제 목록과 본문이 있는 상세를 받는다", async () => {
    const table = seeded();
    const list = await handleOps(
      event("GET", "/ops/inquiries", { query: { status: "received" } }),
      deps("editor", table),
    );
    expect(list.statusCode).toBe(200);
    expect(
      body(list).items.map((i: { inquiryId: string }) => i.inquiryId),
    ).toEqual([ID]);

    const detail = await handleOps(
      event("GET", `/ops/inquiries/${ID}`),
      deps("editor", table),
    );
    expect(body(detail)).toMatchObject({ message: "본문", restricted: false });
  });

  it("보기 권한 상세에는 본문이 없다", async () => {
    const res = await handleOps(
      event("GET", `/ops/inquiries/${ID}`),
      deps("viewer", seeded()),
    );
    expect(body(res).restricted).toBe(true);
    expect(body(res)).not.toHaveProperty("message");
  });

  it("샘플 계정은 실제 테이블을 읽지 않고 예시 문의만 받는다", async () => {
    const table = seeded();
    const list = await handleOps(
      event("GET", "/ops/inquiries"),
      deps("sample", table),
    );
    expect(list.statusCode).toBe(200);
    const ids = body(list).items.map((i: { inquiryId: string }) => i.inquiryId);
    expect(ids).not.toContain(ID);
    expect(ids.length).toBeGreaterThan(0);
    const real = await handleOps(
      event("GET", `/ops/inquiries/${ID}`),
      deps("sample", table),
    );
    expect(real.statusCode).toBe(404);
    expect(table.transactions).toBe(0);
  });

  it.each([
    ["모르는 상태", { status: "done" }, "status"],
    ["limit 범위 밖", { limit: "0" }, "limit"],
    ["limit이 숫자가 아님", { limit: "ten" }, "limit"],
    ["깨진 cursor", { cursor: "!!" }, "cursor"],
  ])("목록 요청이 %s이면 400", async (_, query, field) => {
    const res = await handleOps(
      event("GET", "/ops/inquiries", { query }),
      deps("editor", seeded()),
    );
    expect(res.statusCode).toBe(400);
    expect(body(res).error).toMatchObject({ code: "invalid_request", field });
  });

  it("문의 ID 모양이 아니거나 보관 기한이 지나면 404", async () => {
    const bad = await handleOps(
      event("GET", "/ops/inquiries/not-a-uuid"),
      deps("editor", seeded()),
    );
    expect(bad.statusCode).toBe(404);
    const expired = await handleOps(
      event("GET", `/ops/inquiries/${ID}`),
      deps("editor", seeded({ ttl: NOW_SEC })),
    );
    expect(expired.statusCode).toBe(404);
  });
});

describe("문의 처리(PATCH)", () => {
  const patch = (requestBody: unknown, key = KEY_A) =>
    event("PATCH", `/ops/inquiries/${ID}`, {
      body: requestBody,
      idempotencyKey: key,
    });

  it("편집 권한은 상태를 바꾸고 새 version을 받는다. 같은 요청 재전송은 같은 결과", async () => {
    const table = seeded();
    const first = await handleOps(
      patch({ version: 1, status: "in_progress", memo: "확인 중" }),
      deps("editor", table),
    );
    expect(first.statusCode).toBe(200);
    expect(body(first)).toEqual({ inquiryId: ID, version: 2 });
    const again = await handleOps(
      patch({ version: 1, status: "in_progress", memo: "확인 중" }),
      deps("editor", table),
    );
    expect(body(again)).toEqual({ inquiryId: ID, version: 2 });
    expect(
      table.items.get(table.id("Inquiry", { pk: `INQUIRY#${ID}` })),
    ).toMatchObject({
      inquiryStatus: "in_progress",
      memo: "확인 중",
      version: 2,
      updatedBy: "editor-sub",
    });
  });

  it("읽은 version이 낡았으면 409", async () => {
    const table = seeded({ version: 3 });
    const res = await handleOps(
      patch({ version: 1, status: "resolved" }),
      deps("publisher", table),
    );
    expect(res.statusCode).toBe(409);
    expect(body(res).error).toMatchObject({
      code: "conflict",
      reason: "version",
    });
  });

  it("반려는 이유가 필요하고, 다른 상태로 바꾸면 반려 이유를 지운다", async () => {
    const table = seeded();
    const missing = await handleOps(
      patch({ version: 1, status: "rejected" }),
      deps("editor", table),
    );
    expect(body(missing).error).toMatchObject({ field: "rejectReason" });

    await handleOps(
      patch({ version: 1, status: "rejected", rejectReason: "중복 문의" }),
      deps("editor", table),
    );
    await handleOps(
      patch({ version: 2, status: "received" }, KEY_B),
      deps("editor", table),
    );
    expect(
      table.items.get(table.id("Inquiry", { pk: `INQUIRY#${ID}` })),
    ).toMatchObject({
      inquiryStatus: "received",
      rejectReason: null,
      version: 3,
    });
  });

  it("보기 권한·샘플은 403", async () => {
    for (const group of ["viewer", "sample"]) {
      const res = await handleOps(
        patch({ version: 1, status: "resolved" }),
        deps(group, seeded()),
      );
      expect(res.statusCode, group).toBe(403);
    }
  });

  it("멱등 키가 없거나 본문이 JSON이 아니면 400", async () => {
    const noKey = await handleOps(
      event("PATCH", `/ops/inquiries/${ID}`, {
        body: { version: 1, status: "resolved" },
      }),
      deps("editor", seeded()),
    );
    expect(body(noKey).error).toMatchObject({ field: "idempotencyKey" });

    const textBody = {
      ...patch({}),
      headers: {
        [ACCESS_TOKEN_HEADER]: "token",
        [IDEMPOTENCY_KEY_HEADER]: KEY_A,
        "content-type": "text/plain",
      },
    } as unknown as APIGatewayProxyEventV2;
    const res = await handleOps(textBody, deps("editor", seeded()));
    expect(body(res).error).toMatchObject({ field: "body" });
  });

  it("보관 기한이 지난 문의는 404로 바꾸지 않는다", async () => {
    const table = seeded({ ttl: NOW_SEC });
    const res = await handleOps(
      patch({ version: 1, status: "resolved" }),
      deps("editor", table),
    );
    expect(res.statusCode).toBe(404);
    expect(table.transactions).toBe(0);
  });

  it("이전된 문의(legacy, 확인 중)에 메모만 바꾸면 상태는 그대로다", async () => {
    const table = seeded({
      inquiryStatus: "in_progress",
      version: 2,
      legacy: true,
    });
    const res = await handleOps(
      patch({ version: 2, memo: "메모만" }),
      deps("editor", table),
    );
    expect(body(res)).toEqual({ inquiryId: ID, version: 3 });
    expect(
      table.items.get(table.id("Inquiry", { pk: `INQUIRY#${ID}` })),
    ).toMatchObject({
      inquiryStatus: "in_progress",
      memo: "메모만",
      legacy: true,
    });
  });

  it("상태 기록 전 문의는 version 0으로 바꾸고 접수·이전 문의 표시를 함께 채운다", async () => {
    const table = seeded({ inquiryStatus: undefined, version: undefined });
    const res = await handleOps(
      patch({ version: 0, memo: "이전 문의 확인" }),
      deps("editor", table),
    );
    expect(body(res)).toEqual({ inquiryId: ID, version: 1 });
    expect(
      table.items.get(table.id("Inquiry", { pk: `INQUIRY#${ID}` })),
    ).toMatchObject({ inquiryStatus: "received", legacy: true, version: 1 });
  });
});
