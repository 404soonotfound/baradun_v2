import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import type { AuthDependencies } from "./auth";
import { handleOps, type OpsDependencies } from "./handler";
import { ACCESS_TOKEN_HEADER, IDEMPOTENCY_KEY_HEADER } from "./policy";
import { AUDIT_PREFIX } from "./keys";
import { encodeCursor } from "./inquiries";
import { FakeTable, type Item } from "./test-dynamo";
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

// 요청마다 새 traceId(실제는 randomUUID). 감사 키가 시각+traceId라 같은 값이면 겹침
let seq = 0;
function nextIds() {
  seq++;
  const n = String(seq).padStart(6, "0");
  return { traceId: `trace-${n}`, requestId: `req-${n}` };
}

function audits(table: FakeTable): Item[] {
  return [...table.items.values()]
    .filter((i) => String(i.pk).startsWith(AUDIT_PREFIX))
    .sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
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
    ids: nextIds,
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

  it("첫 쪽에는 상태별 문의 수를 싣고, 다음 쪽(cursor)에는 싣지 않는다", async () => {
    const table = seeded();
    const first = await handleOps(
      event("GET", "/ops/inquiries", { query: { limit: "1" } }),
      deps("viewer", table),
    );
    expect(body(first).counts).toEqual({
      received: 1,
      in_progress: 0,
      resolved: 0,
      rejected: 0,
    });
    const next = await handleOps(
      event("GET", "/ops/inquiries", {
        query: { cursor: encodeCursor({ s: "in_progress" }) },
      }),
      deps("viewer", table),
    );
    expect(next.statusCode).toBe(200);
    expect(body(next)).not.toHaveProperty("counts");
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
    // 예시 문의 수도 예시 목록에서 셈(실제 테이블을 세지 않음)
    const counts = body(list).counts as Record<string, number>;
    expect(Object.values(counts).reduce((x, y) => x + y, 0)).toBe(ids.length);
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

  it("상태를 고른 목록에 전체 목록의 '다음 상태부터' cursor(키 없음)를 넣으면 400", async () => {
    const cursor = Buffer.from(JSON.stringify({ s: "received" })).toString(
      "base64url",
    );
    const res = await handleOps(
      event("GET", "/ops/inquiries", { query: { status: "received", cursor } }),
      deps("editor", seeded()),
    );
    expect(res.statusCode).toBe(400);
    expect(body(res).error).toMatchObject({ field: "cursor" });
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

  it("개인정보 가리기는 고른 부분만 '[가림]'으로 바꾸고 이력에는 'message'만 남긴다", async () => {
    const table = seeded({ message: "제 번호는 010-1234-5678 이에요" });
    const range = { start: 6, end: 19, text: "010-1234-5678" };
    const res = await handleOps(
      patch({ version: 1, redactions: [range] }),
      deps("editor", table),
    );
    expect(res.statusCode).toBe(200);
    expect(
      table.items.get(table.id("Inquiry", { pk: `INQUIRY#${ID}` })),
    ).toMatchObject({
      message: "제 번호는 [가림] 이에요",
      inquiryStatus: "received",
      version: 2,
    });
    const [entry] = audits(table);
    expect(entry).toMatchObject({ changes: ["message"] });
    expect(JSON.stringify(entry)).not.toContain("010");
    // 응답을 못 받아 같은 키로 다시 보내면 이미 가린 본문과 맞지 않아도 앞 결과를 줌
    const again = await handleOps(
      patch({ version: 1, redactions: [range] }),
      deps("editor", table),
    );
    expect(again.statusCode).toBe(200);
    expect(body(again)).toEqual({ inquiryId: ID, version: 2 });
  });

  it("가릴 부분이 지금 본문과 다르면 400, 낡은 version이면 409로 본문을 바꾸지 않는다", async () => {
    const table = seeded({ message: "이름은 홍길동" });
    const wrong = await handleOps(
      patch({ version: 1, redactions: [{ start: 0, end: 2, text: "홍길" }] }),
      deps("editor", table),
    );
    expect(wrong.statusCode).toBe(400);
    expect(body(wrong).error).toMatchObject({ field: "redactions" });
    const stale = await handleOps(
      patch(
        { version: 0, redactions: [{ start: 4, end: 7, text: "홍길동" }] },
        KEY_B,
      ),
      deps("editor", table),
    );
    expect(stale.statusCode).toBe(409);
    expect(
      table.items.get(table.id("Inquiry", { pk: `INQUIRY#${ID}` })),
    ).toMatchObject({ message: "이름은 홍길동", version: 1 });
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

describe("변경 이력 기록 (BRD-155)", () => {
  it("문의 처리는 바뀐 항목 이름·상태 앞뒤만 남기고 본문·메모·반려 이유 글은 남기지 않는다", async () => {
    const table = seeded();
    await handleOps(
      event("PATCH", `/ops/inquiries/${ID}`, {
        body: {
          version: 1,
          status: "rejected",
          rejectReason: "중복 문의",
          memo: "내부 메모 글",
        },
        idempotencyKey: KEY_A,
      }),
      deps("editor", table),
    );
    const [entry] = audits(table);
    expect(entry).toMatchObject({
      action: "inquiry.update",
      actorSub: "editor-sub",
      actorKind: "operator",
      role: "editor",
      targetKind: "inquiry",
      targetId: ID,
      changes: ["status", "rejectReason", "memo"],
      statusFrom: "received",
      statusTo: "rejected",
    });
    const text = JSON.stringify(entry);
    for (const secret of ["본문", "중복 문의", "내부 메모 글", "@"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("반려를 다른 상태로 바꾸면 반려 이유도 바뀐 항목으로 남는다", async () => {
    const table = seeded({ inquiryStatus: "rejected", rejectReason: "중복" });
    await handleOps(
      event("PATCH", `/ops/inquiries/${ID}`, {
        body: { version: 1, status: "received" },
        idempotencyKey: KEY_A,
      }),
      deps("editor", table),
    );
    expect(audits(table)[0]).toMatchObject({
      changes: ["status", "rejectReason"],
      statusFrom: "rejected",
      statusTo: "received",
    });
  });

  it("재전송·충돌·검사 실패는 기록하지 않는다", async () => {
    const table = seeded();
    const patch = (body: unknown, key = KEY_A) =>
      handleOps(
        event("PATCH", `/ops/inquiries/${ID}`, { body, idempotencyKey: key }),
        deps("editor", table),
      );
    await patch({ version: 1, memo: "a" });
    await patch({ version: 1, memo: "a" });
    await patch({ version: 1, memo: "b" }, KEY_B);
    await patch({ version: 2, status: "rejected" }, KEY_B);
    expect(audits(table)).toHaveLength(1);
  });

  it("샘플 계정은 로그인 확인·조회·거절된 요청을 모두 남긴다(경로 모양만)", async () => {
    const table = seeded();
    for (const [method, path] of [
      ["GET", "/ops/me"],
      ["GET", `/ops/inquiries/${ID}`],
      ["PATCH", `/ops/inquiries/${ID}`],
      ["GET", "/ops/audit"],
    ] as const) {
      await handleOps(event(method, path), deps("sample", table));
    }
    expect(
      audits(table).map((a) => [a.action, a.targetId, a.actorKind]),
    ).toEqual([
      ["sample.read", "GET /ops/me", "sample"],
      ["sample.read", "GET /ops/inquiries/{id}", "sample"],
      ["sample.denied", "PATCH /ops/inquiries/{id}", "sample"],
      ["sample.denied", "GET /ops/audit", "sample"],
    ]);
    expect(JSON.stringify(audits(table))).not.toContain(ID.slice(0, 8));
  });

  it("샘플 기록을 남기지 못하면 응답하지 않는다(500)", async () => {
    const table = seeded();
    const failing = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === "PutCommand") {
          throw new Error("ProvisionedThroughputExceededException");
        }
        return table.send(command as never);
      },
    };
    const d = deps("sample", table);
    const res = await handleOps(event("GET", "/ops/inquiries"), {
      ...d,
      data: { ...d.data, client: failing as never },
    });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("items");
  });

  it("운영자 조회는 기록하지 않는다(쓰기만 기록)", async () => {
    const table = seeded();
    await handleOps(
      event("GET", `/ops/inquiries/${ID}`),
      deps("viewer", table),
    );
    expect(audits(table)).toHaveLength(0);
  });
});

describe("변경 이력 목록 GET /ops/audit", () => {
  async function withHistory(): Promise<FakeTable> {
    const table = seeded();
    await handleOps(
      event("PATCH", `/ops/inquiries/${ID}`, {
        body: { version: 1, status: "in_progress" },
        idempotencyKey: KEY_A,
      }),
      deps("editor", table),
    );
    await handleOps(event("GET", "/ops/me"), deps("sample", table));
    return table;
  }

  it("보기 권한도 최근 기록부터 받고, 종류·운영자로 거를 수 있다", async () => {
    const table = await withHistory();
    const all = await handleOps(
      event("GET", "/ops/audit"),
      deps("viewer", table),
    );
    expect(all.statusCode).toBe(200);
    expect(body(all).items).toHaveLength(2);
    expect(body(all).items[0]).toMatchObject({
      action: "sample.read",
      target: { kind: "route", id: "GET /ops/me" },
    });
    expect(body(all).filter.to).toBe(NOW.toISOString());

    const onlyInquiry = await handleOps(
      event("GET", "/ops/audit", { query: { action: "inquiry.update" } }),
      deps("viewer", table),
    );
    expect(body(onlyInquiry).items).toEqual([
      expect.objectContaining({
        actorSub: "editor-sub",
        target: { kind: "inquiry", id: ID },
        statusFrom: "received",
        statusTo: "in_progress",
      }),
    ]);

    const byActor = await handleOps(
      event("GET", "/ops/audit", { query: { actor: "sample-sub" } }),
      deps("viewer", table),
    );
    expect(
      body(byActor).items.map((i: { action: string }) => i.action),
    ).toEqual(["sample.read"]);
  });

  it("첫 쪽에 분류별 수를 싣고(데모 기록은 전체에만), 분류·찾기로 거른다. 다음 쪽에는 수가 없다", async () => {
    const table = await withHistory();
    const all = await handleOps(
      event("GET", "/ops/audit", { query: { limit: "1" } }),
      deps("viewer", table),
    );
    expect(body(all).counts).toEqual({
      all: 2,
      notice: 0,
      beach: 0,
      publish: 0,
      inquiry: 1,
      permission: 0,
      login: 0,
    });
    const next = await handleOps(
      event("GET", "/ops/audit", {
        query: { cursor: body(all).nextCursor, limit: "1" },
      }),
      deps("viewer", table),
    );
    expect(body(next)).not.toHaveProperty("counts");

    const inquiries = await handleOps(
      event("GET", "/ops/audit", { query: { category: "inquiry" } }),
      deps("viewer", table),
    );
    expect(
      body(inquiries).items.map((i: { action: string }) => i.action),
    ).toEqual(["inquiry.update"]);
    // 분류를 골라도 탭 수는 분류 거르기를 빼고 셈
    expect(body(inquiries).counts.all).toBe(2);

    const found = await handleOps(
      event("GET", "/ops/audit", { query: { q: ID.slice(0, 8) } }),
      deps("viewer", table),
    );
    expect(body(found).items).toHaveLength(1);
    expect(body(found).counts.all).toBe(1);
  });

  it("counts=0이면 탭 수를 세지 않는다(화면이 같은 거르기의 수를 이미 가짐)", async () => {
    const res = await handleOps(
      event("GET", "/ops/audit", {
        query: { category: "inquiry", counts: "0" },
      }),
      deps("viewer", await withHistory()),
    );
    expect(res.statusCode).toBe(200);
    expect(body(res)).not.toHaveProperty("counts");
    expect(body(res).items).toHaveLength(1);
  });

  it.each([
    ["counts 값이 0이 아님", { counts: "1" }, "counts"],
    ["모르는 분류", { category: "beaches" }, "category"],
    ["빈 찾기", { q: "" }, "q"],
    ["앞뒤 공백 찾기", { q: " 공지" }, "q"],
    ["너무 긴 찾기", { q: "가".repeat(51) }, "q"],
  ])("%s이면 400(%s)", async (_, query, field) => {
    const res = await handleOps(
      event("GET", "/ops/audit", { query }),
      deps("viewer", await withHistory()),
    );
    expect(res.statusCode).toBe(400);
    expect(body(res).error).toMatchObject({ field });
  });

  it("샘플은 변경 이력을 받지 않는다(403)", async () => {
    const res = await handleOps(
      event("GET", "/ops/audit"),
      deps("sample", await withHistory()),
    );
    expect(res.statusCode).toBe(403);
  });

  it.each([
    ["시간대 없는 시각", { from: "2026-11-01T00:00:00" }, "from"],
    ["KST 표기", { to: "2026-11-03T15:00:00+09:00" }, "to"],
    [
      "시작이 끝보다 늦음",
      { from: "2026-11-03T07:00:00Z", to: "2026-11-03T06:00:00Z" },
      "from",
    ],
    [
      "367일 기간",
      { from: "2025-11-01T00:00:00Z", to: "2026-11-03T00:00:00Z" },
      "from",
    ],
    ["모르는 종류", { action: "inquiry.delete" }, "action"],
    ["운영자 모양이 아님", { actor: "a b" }, "actor"],
    ["limit 범위 밖", { limit: "101" }, "limit"],
    ["깨진 cursor", { cursor: "!!" }, "cursor"],
  ])("요청이 %s이면 400", async (_, query, field) => {
    const res = await handleOps(
      event("GET", "/ops/audit", { query }),
      deps("viewer", seeded()),
    );
    expect(res.statusCode).toBe(400);
    expect(body(res).error).toMatchObject({ code: "invalid_request", field });
  });
});
