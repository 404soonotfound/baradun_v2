import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import type { AuthDependencies } from "./auth";
import { handleOps, type OpsDependencies } from "./handler";
import { AUDIT_PREFIX, NOTICE_PK } from "./keys";
import { ACCESS_TOKEN_HEADER, IDEMPOTENCY_KEY_HEADER } from "./policy";
import { FakeTable, type Item } from "./test-dynamo";
import { TEST_CONFIG } from "./test-tokens";

// 운영 API 공지 경로 (BRD-151, ADM-NTC · D16-B3·D1~D4). 토큰 검증은 가짜, DB는 test-dynamo 가짜

const NOW = new Date("2026-11-03T06:00:00Z");
const NOW_SEC = NOW.getTime() / 1000;
const ISS = (pool: string) =>
  `https://cognito-idp.ap-northeast-2.amazonaws.com/${pool}`;

const CONTENT = {
  kind: "maintenance_notice",
  title: { ko: "데이터 점검 예고", en: "Planned data maintenance" },
  body: { ko: "11월 4일 새벽 갱신이 늦어요", en: "Updates may be late" },
  startsAt: "2026-11-03T05:00:00Z",
  endsAt: "2026-11-04T00:00:00Z",
};

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

let seq = 0;
function nextIds() {
  seq++;
  const n = String(seq).padStart(6, "0");
  return { traceId: `trace-${n}`, requestId: `req-${n}` };
}

// 멱등 키는 쓰기마다 새 UUID v4
let keySeq = 0;
function newKey(): string {
  keySeq++;
  return `${String(keySeq).padStart(8, "0")}-d9cb-469f-a165-70867728950e`;
}

function deps(group: string, table: FakeTable, now = NOW): OpsDependencies {
  const auth: AuthDependencies = {
    config: TEST_CONFIG,
    verifier: { verify: async () => claims(group) },
    samplePolicy: async () => ({
      subs: ["sample-sub"],
      allowedFrom: new Date(NOW.getTime() - 3_600_000),
      allowedUntil: new Date(NOW.getTime() + 3_600_000),
    }),
    now: () => now,
  };
  return {
    auth,
    data: {
      client: table as never,
      opsTable: "Ops",
      inquiryTable: "Inquiry",
      now: () => now,
    },
    ids: nextIds,
  };
}

function event(
  method: string,
  path: string,
  body?: unknown,
  key: string | null = newKey(),
): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    headers: {
      [ACCESS_TOKEN_HEADER]: "token",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(key ? { [IDEMPOTENCY_KEY_HEADER]: key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method } },
  } as unknown as APIGatewayProxyEventV2;
}

function audits(table: FakeTable): Item[] {
  return [...table.items.values()]
    .filter((i) => String(i.pk).startsWith(AUDIT_PREFIX))
    .sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
}

function stored(table: FakeTable, id: string): Item | undefined {
  return table.items.get(table.id("Ops", { pk: NOTICE_PK, sk: id }));
}

const parse = (result: { body?: string | undefined }) =>
  JSON.parse(result.body!);

async function create(table: FakeTable, content: unknown = CONTENT) {
  const result = await handleOps(
    event("POST", "/ops/notices", content),
    deps("editor", table),
  );
  expect(result.statusCode).toBe(201);
  return parse(result) as { noticeId: string; version: number };
}

async function expose(table: FakeTable, id: string, version: number) {
  return handleOps(
    event("POST", `/ops/notices/${id}/expose`, { version }),
    deps("publisher", table),
  );
}

describe("공지 만들기·저장 (편집)", () => {
  it("대기로 만들고 노출본은 없다. 변경 이력에는 대상 이름과 공지 문구 앞·뒤를 남긴다(시안 V23)", async () => {
    const table = new FakeTable();
    const { noticeId, version } = await create(table);
    expect(noticeId).toMatch(/^n-[0-9a-f]{12}$/);
    expect(version).toBe(1);
    expect(stored(table, noticeId)).toMatchObject({
      pk: NOTICE_PK,
      sk: noticeId,
      draft: CONTENT,
      live: null,
      deletedAt: null,
    });
    const [audit] = audits(table);
    expect(audit).toMatchObject({
      action: "notice.create",
      targetKind: "notice",
      targetId: noticeId,
      actorSub: "editor-sub",
    });
    // 공지 문구는 공개 문구라 변경 이력 펼치기에 남김(문의 본문·이메일만 복사 안 함, D16-B5)
    expect(audit).toMatchObject({
      targetLabel: CONTENT.title.ko,
      noticeBefore: null,
      noticeAfter: CONTENT,
    });
  });

  it("같은 멱등 키로 다시 보내면 같은 공지를 돌려주고 하나만 생긴다", async () => {
    const table = new FakeTable();
    const key = newKey();
    const first = await handleOps(
      event("POST", "/ops/notices", CONTENT, key),
      deps("editor", table),
    );
    const again = await handleOps(
      event("POST", "/ops/notices", CONTENT, key),
      deps("editor", table),
    );
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(parse(again).noticeId).toBe(parse(first).noticeId);
    expect(
      [...table.items.values()].filter((i) => i.pk === NOTICE_PK),
    ).toHaveLength(1);
  });

  it("고치기는 대기본만 바꾸고, 다른 version이면 409", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table);
    await expose(table, noticeId, 1);
    const edited = { ...CONTENT, title: { ko: "새 제목", en: "New title" } };
    const ok = await handleOps(
      event("PUT", `/ops/notices/${noticeId}`, { ...edited, version: 2 }),
      deps("editor", table),
    );
    expect(ok.statusCode).toBe(200);
    expect(stored(table, noticeId)).toMatchObject({
      draft: edited,
      live: CONTENT,
    });
    const stale = await handleOps(
      event("PUT", `/ops/notices/${noticeId}`, { ...edited, version: 2 }),
      deps("editor", table),
    );
    expect(stale.statusCode).toBe(409);
    expect(audits(table).at(-1)).toMatchObject({
      action: "notice.update",
      changes: ["title"],
    });
  });

  it("보기 권한·샘플은 쓰지 못한다", async () => {
    const table = new FakeTable();
    for (const group of ["viewer", "sample"]) {
      const result = await handleOps(
        event("POST", "/ops/notices", CONTENT),
        deps(group, table),
      );
      expect(result.statusCode).toBe(403);
    }
    expect([...table.items.values()].some((i) => i.pk === NOTICE_PK)).toBe(
      false,
    );
  });

  it("샘플은 고치기·노출·끝내기·지우기도 서버가 거절한다", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table);
    const before = stored(table, noticeId);
    for (const [method, path, body] of [
      ["PUT", `/ops/notices/${noticeId}`, { ...CONTENT, version: 1 }],
      ["POST", `/ops/notices/${noticeId}/expose`, { version: 1 }],
      ["POST", `/ops/notices/${noticeId}/end`, { version: 1 }],
      ["DELETE", `/ops/notices/${noticeId}`, { version: 1 }],
    ] as const) {
      const result = await handleOps(
        event(method, path, body),
        deps("sample", table),
      );
      expect(result.statusCode, `${method} ${path}`).toBe(403);
    }
    expect(stored(table, noticeId)).toEqual(before);
    // 거절은 sample.denied로만 남고 공지 쓰기 기록은 만들기 하나뿐
    expect(audits(table).map((a) => a.action)).toEqual([
      "notice.create",
      ...Array(4).fill("sample.denied"),
    ]);
  });

  it("멱등 키·본문이 틀리면 400", async () => {
    const table = new FakeTable();
    const noKey = await handleOps(
      event("POST", "/ops/notices", CONTENT, null),
      deps("editor", table),
    );
    expect(parse(noKey).error.field).toBe("idempotencyKey");
    const kst = await handleOps(
      event("POST", "/ops/notices", {
        ...CONTENT,
        startsAt: "2026-11-03T14:00:00+09:00",
      }),
      deps("editor", table),
    );
    expect(kst.statusCode).toBe(400);
    expect(parse(kst).error.field).toBe("startsAt");
  });
});

describe("노출·끝내기 (노출 변경)", () => {
  it("편집 권한은 노출하지 못한다", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table);
    const result = await handleOps(
      event("POST", `/ops/notices/${noticeId}/expose`, { version: 1 }),
      deps("editor", table),
    );
    expect(result.statusCode).toBe(403);
    expect(stored(table, noticeId)?.live).toBeNull();
  });

  it("영어 문구가 없으면 노출하지 않고 어느 칸인지 알려 준다", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table, {
      ...CONTENT,
      body: { ko: "본문", en: "" },
    });
    const result = await expose(table, noticeId, 1);
    expect(result.statusCode).toBe(400);
    expect(parse(result).error).toMatchObject({
      field: "body.en",
      reason: "required",
    });
    expect(stored(table, noticeId)?.live).toBeNull();
  });

  it("차단 표현은 대기 저장은 되지만 노출은 서버가 막는다(D16-D1·D17-8)", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table, {
      ...CONTENT,
      body: { ko: "오늘은 안 전 해 요", en: CONTENT.body.en },
    });
    expect(stored(table, noticeId)?.draft).toMatchObject({
      body: { ko: "오늘은 안 전 해 요" },
    });
    const result = await expose(table, noticeId, 1);
    expect(result.statusCode).toBe(400);
    expect(parse(result).error).toMatchObject({
      field: "body.ko",
      reason: "blocked_phrase",
    });
    expect(stored(table, noticeId)?.live).toBeNull();
    expect(audits(table).map((a) => a.action)).toEqual(["notice.create"]);
  });

  it("경고 표현·허용 표현만 있으면 노출한다", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table, {
      ...CONTENT,
      title: { ko: "파도가 잔잔해요", en: "Calm sea notice" },
      body: {
        ko: "안전요원 안내를 따라 주세요",
        en: "Follow the lifeguard on duty.",
      },
    });
    const result = await expose(table, noticeId, 1);
    expect(result.statusCode).toBe(200);
    expect(stored(table, noticeId)?.live).not.toBeNull();
  });

  it("노출하면 대기본이 노출본이 되고, 응답은 저장 결과만 준다(앱 반영은 다음 게시)", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table);
    const result = await expose(table, noticeId, 1);
    expect(result.statusCode).toBe(200);
    expect(parse(result)).toEqual({ noticeId, version: 2 });
    expect(stored(table, noticeId)).toMatchObject({
      live: CONTENT,
      exposedAt: NOW.toISOString(),
    });
    expect(audits(table).at(-1)).toMatchObject({
      action: "notice.expose",
      actorSub: "publisher-sub",
    });
  });

  it("읽은 version이 지금과 다르면 노출하지 않는다(다른 문구를 확인했을 수 있음)", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table);
    const result = await expose(table, noticeId, 5);
    expect(result.statusCode).toBe(409);
  });

  it("노출 중이면 끝 시각을 지금으로, 예약이면 노출본을 지운다", async () => {
    const table = new FakeTable();
    const live = await create(table);
    await expose(table, live.noticeId, 1);
    const ended = await handleOps(
      event("POST", `/ops/notices/${live.noticeId}/end`, { version: 2 }),
      deps("publisher", table),
    );
    expect(ended.statusCode).toBe(200);
    expect(stored(table, live.noticeId)).toMatchObject({
      live: { endsAt: NOW.toISOString() },
      draft: { endsAt: NOW.toISOString() },
    });

    const scheduled = await create(table, {
      ...CONTENT,
      startsAt: "2026-11-03T09:00:00Z",
    });
    await expose(table, scheduled.noticeId, 1);
    await handleOps(
      event("POST", `/ops/notices/${scheduled.noticeId}/end`, { version: 2 }),
      deps("publisher", table),
    );
    expect(stored(table, scheduled.noticeId)?.live).toBeNull();

    // 이미 끝났거나 노출본이 없으면 409
    const again = await handleOps(
      event("POST", `/ops/notices/${live.noticeId}/end`, { version: 3 }),
      deps("publisher", table),
    );
    expect(again.statusCode).toBe(409);
    expect(parse(again).error.reason).toBe("not_live");
  });
});

describe("재전송 (D16-B6)", () => {
  it("노출·끝내기·지우기를 같은 키·같은 본문으로 다시 보내면 앞 결과를 받는다", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table);
    const send = (method: string, path: string, version: number, key: string) =>
      handleOps(
        event(method, path, { version }, key),
        deps("publisher", table),
      );

    const exposeKey = newKey();
    const exposed = await send(
      "POST",
      `/ops/notices/${noticeId}/expose`,
      1,
      exposeKey,
    );
    const exposedAgain = await send(
      "POST",
      `/ops/notices/${noticeId}/expose`,
      1,
      exposeKey,
    );
    expect(exposedAgain.statusCode).toBe(200);
    expect(parse(exposedAgain)).toEqual(parse(exposed));

    const endKey = newKey();
    const ended = await send("POST", `/ops/notices/${noticeId}/end`, 2, endKey);
    const endedAgain = await send(
      "POST",
      `/ops/notices/${noticeId}/end`,
      2,
      endKey,
    );
    expect(endedAgain.statusCode).toBe(200);
    expect(parse(endedAgain)).toEqual(parse(ended));

    const deleteKey = newKey();
    const deleted = await send(
      "DELETE",
      `/ops/notices/${noticeId}`,
      3,
      deleteKey,
    );
    const deletedAgain = await send(
      "DELETE",
      `/ops/notices/${noticeId}`,
      3,
      deleteKey,
    );
    expect(deletedAgain.statusCode).toBe(200);
    expect(parse(deletedAgain)).toEqual(parse(deleted));
    // 다시 보낸 요청은 바꾼 것이 없으므로 이력도 하나씩만
    expect(audits(table).map((a) => a.action)).toEqual([
      "notice.create",
      "notice.expose",
      "notice.end",
      "notice.delete",
    ]);
  });

  it("같은 키에 다른 본문이면 409", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table);
    const key = newKey();
    await handleOps(
      event("POST", `/ops/notices/${noticeId}/expose`, { version: 1 }, key),
      deps("publisher", table),
    );
    const other = await handleOps(
      event("POST", `/ops/notices/${noticeId}/end`, { version: 2 }, key),
      deps("publisher", table),
    );
    expect(other.statusCode).toBe(409);
    expect(parse(other).error.reason).toBe("idempotency_mismatch");
  });
});

describe("끝내기와 대기본", () => {
  it("대기본의 시작이 아직이면 대기본 끝 시각을 바꾸지 않는다", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table);
    await expose(table, noticeId, 1);
    const later = {
      ...CONTENT,
      startsAt: "2026-11-05T00:00:00Z",
      endsAt: null,
    };
    await handleOps(
      event("PUT", `/ops/notices/${noticeId}`, { ...later, version: 2 }),
      deps("editor", table),
    );
    await handleOps(
      event("POST", `/ops/notices/${noticeId}/end`, { version: 3 }),
      deps("publisher", table),
    );
    expect(stored(table, noticeId)).toMatchObject({
      live: { endsAt: NOW.toISOString() },
      draft: later,
    });
  });
});

describe("지우기 (D16-D3)", () => {
  it("노출 중이면 지우지 않고, 먼저 노출을 끝내야 한다", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table);
    await expose(table, noticeId, 1);
    const result = await handleOps(
      event("DELETE", `/ops/notices/${noticeId}`, { version: 2 }),
      deps("publisher", table),
    );
    expect(result.statusCode).toBe(409);
    expect(parse(result).error.reason).toBe("live");
  });

  it("예약 공지는 노출 변경 권한만 지울 수 있다", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table, {
      ...CONTENT,
      startsAt: "2026-11-03T09:00:00Z",
    });
    await expose(table, noticeId, 1);
    const byEditor = await handleOps(
      event("DELETE", `/ops/notices/${noticeId}`, { version: 2 }),
      deps("editor", table),
    );
    expect(byEditor.statusCode).toBe(403);
    const byPublisher = await handleOps(
      event("DELETE", `/ops/notices/${noticeId}`, { version: 2 }),
      deps("publisher", table),
    );
    expect(byPublisher.statusCode).toBe(200);
  });

  it("지운 공지는 항목과 이력이 남고 목록·고치기에서는 없다", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table);
    const deleted = await handleOps(
      event("DELETE", `/ops/notices/${noticeId}`, { version: 1 }),
      deps("editor", table),
    );
    expect(deleted.statusCode).toBe(200);
    expect(stored(table, noticeId)?.deletedAt).toBe(NOW.toISOString());
    expect(audits(table).at(-1)).toMatchObject({ action: "notice.delete" });

    const list = await handleOps(
      event("GET", "/ops/notices", undefined, null),
      deps("viewer", table),
    );
    expect(parse(list).items).toEqual([]);
    const edit = await handleOps(
      event("PUT", `/ops/notices/${noticeId}`, { ...CONTENT, version: 2 }),
      deps("editor", table),
    );
    expect(edit.statusCode).toBe(404);
  });
});

describe("목록", () => {
  it("보기 권한이 상태와 함께 받고, 운영자 sub는 들어 있지 않다", async () => {
    const table = new FakeTable();
    const { noticeId } = await create(table);
    await expose(table, noticeId, 1);
    const result = await handleOps(
      event("GET", "/ops/notices", undefined, null),
      deps("viewer", table),
    );
    expect(result.statusCode).toBe(200);
    const [item] = parse(result).items;
    expect(item).toMatchObject({
      id: noticeId,
      state: "live",
      pendingEdit: false,
      hidden: false,
      version: 2,
    });
    expect(result.body).not.toContain("-sub");
  });

  it("샘플은 실제 공지(공개 전 대기본 포함) 대신 예시 공지를 받는다", async () => {
    const table = new FakeTable();
    await create(table);
    const result = await handleOps(
      event("GET", "/ops/notices", undefined, null),
      deps("sample", table),
    );
    expect(result.statusCode).toBe(200);
    expect(result.body).not.toContain("11월 4일 새벽 갱신이 늦어요");
    const items = parse(result).items as { id: string; state: string }[];
    expect(items.map((i) => i.state).sort()).toEqual([
      "draft",
      "live",
      "scheduled",
    ]);
    expect(items.every((i) => i.id.startsWith("sample-"))).toBe(true);
  });

  it("잘못된 공지 ID는 404", async () => {
    const table = new FakeTable();
    const result = await handleOps(
      event("PUT", "/ops/notices/Bad_ID", { ...CONTENT, version: 1 }),
      deps("editor", table),
    );
    expect(result.statusCode).toBe(404);
  });
});
