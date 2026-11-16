import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countInquiries,
  decodeCursor,
  encodeCursor,
  forgetUnknownStatuses,
  getInquiry,
  applyRedactions,
  inquiryPatchFields,
  listFilteredInquiries,
  listInquiries,
  MEMO_MAX,
  parseInquiryPatch,
  readUnknownStatuses,
  REJECT_REASON_MAX,
  UNKNOWN_STATUS_TIMEOUT_MS,
} from "./inquiries";
import { INQUIRY_STATUS_INDEX_NAME } from "../inquiry/policy";
import { matchesUnknownStatusScan } from "./test-dynamo";

// 운영자 화면 문의 (BRD-153, D16-B4·D5·D6, 구현 제안 I07·I08)

const NOW = new Date("2026-11-03T06:00:00Z");
const NOW_SEC = NOW.getTime() / 1000;

type Item = Record<string, unknown>;

function inquiry(n: number, status: string, overrides: Item = {}): Item {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    pk: `INQUIRY#${id}`,
    kind: "inquiry",
    inquiryId: id,
    inquiryType: "data_error",
    receivedAt: new Date(NOW.getTime() - n * 60_000).toISOString(),
    inquiryStatus: status,
    version: 1,
    ttl: NOW_SEC + 86_400,
    message: "본문",
    ...overrides,
  };
}

// GSI Query를 흉내 냄: 상태가 같은 항목을 접수 시각 내림차순으로, Limit·ExclusiveStartKey 적용
// Scan(4종 밖 상태 찾기, #521)은 GSI 항목(상태가 글자)을 넣은 순서대로 scanPageSize개씩 평가한 뒤
// 거름 → 거른 결과가 0건이어도 LastEvaluatedKey가 이어질 수 있음(실제 Scan의 1MB 쪽과 같은 모양)
class FakeIndex {
  readonly queries: Item[] = [];
  readonly scans: Item[] = [];
  readonly gets: Item[] = [];
  constructor(
    private readonly items: Item[],
    private readonly pageSize = 100,
    private readonly scanPageSize = 100,
  ) {}

  async send(command: { constructor: { name: string }; input: any }) {
    const input = command.input;
    if (command.constructor.name === "GetCommand") {
      this.gets.push(input);
      return { Item: this.items.find((i) => i.pk === input.Key.pk) };
    }
    if (command.constructor.name === "ScanCommand") {
      this.scans.push(input);
      const indexed = this.items.filter(
        (i) => typeof i.inquiryStatus === "string",
      );
      const start = input.ExclusiveStartKey
        ? indexed.findIndex((i) => i.pk === input.ExclusiveStartKey.pk) + 1
        : 0;
      const evaluated = indexed.slice(start, start + this.scanPageSize);
      const last = evaluated.at(-1);
      const more = start + this.scanPageSize < indexed.length;
      return {
        Items: evaluated
          .filter((i) =>
            matchesUnknownStatusScan(i, input.ExpressionAttributeValues),
          )
          .map(({ message: _message, ...projection }) => projection),
        ...(more && last
          ? {
              LastEvaluatedKey: {
                pk: last.pk,
                inquiryStatus: last.inquiryStatus,
                receivedAt: last.receivedAt,
              },
            }
          : {}),
      };
    }
    this.queries.push(input);
    const status = input.ExpressionAttributeValues[":s"];
    // COUNT: 상태가 같고 ttl이 지금보다 뒤인 항목 수. pageSize로 여러 쪽에 나눠 돌려줌
    if (input.Select === "COUNT") {
      const matched = this.items.filter(
        (i) =>
          i.inquiryStatus === status &&
          (i.ttl as number) > input.ExpressionAttributeValues[":now"],
      );
      const start = input.ExclusiveStartKey?.n ?? 0;
      const end = Math.min(start + this.pageSize, matched.length);
      return {
        Count: end - start,
        ...(end < matched.length ? { LastEvaluatedKey: { n: end } } : {}),
      };
    }
    const sorted = this.items
      .filter((i) => {
        const { ":from": from, ":to": to } = input.ExpressionAttributeValues;
        return (
          i.inquiryStatus === status &&
          (!from || String(i.receivedAt) >= from) &&
          (!to || String(i.receivedAt) <= to)
        );
      })
      .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
    const start = input.ExclusiveStartKey
      ? sorted.findIndex((i) => i.pk === input.ExclusiveStartKey.pk) + 1
      : 0;
    const page = sorted.slice(start, start + input.Limit);
    const more = start + input.Limit < sorted.length;
    const last = page.at(-1);
    return {
      Items: page.map(({ message: _message, ...projection }) => projection),
      ...(more && last
        ? {
            LastEvaluatedKey: {
              pk: last.pk,
              inquiryStatus: last.inquiryStatus,
              receivedAt: last.receivedAt,
            },
          }
        : {}),
    };
  }
}

describe("문의 목록", () => {
  it("상태 GSI를 최근 접수 순으로 읽고 보관 기한이 지난 문의는 뺀다", async () => {
    const index = new FakeIndex([
      inquiry(1, "received"),
      inquiry(2, "received", { ttl: NOW_SEC }),
      inquiry(3, "received"),
    ]);
    const page = await listInquiries(
      index as never,
      "Inquiry",
      { status: "received", limit: 20 },
      NOW,
    );
    expect(page.items.map((i) => i.inquiryId.slice(-1))).toEqual(["1", "3"]);
    expect(page.nextCursor).toBeNull();
    expect(index.queries[0]).toMatchObject({
      IndexName: INQUIRY_STATUS_INDEX_NAME,
      ScanIndexForward: false,
    });
  });

  it("목록 항목에는 본문을 넣지 않는다", async () => {
    const index = new FakeIndex([inquiry(1, "received")]);
    const page = await listInquiries(
      index as never,
      "Inquiry",
      { limit: 20 },
      NOW,
    );
    expect(page.items[0]).not.toHaveProperty("message");
  });

  it("상태를 고르지 않으면 접수 → 확인 중 → 완료 → 반려 순으로 이어 붙이고 cursor로 이어 간다", async () => {
    const index = new FakeIndex([
      inquiry(1, "resolved"),
      inquiry(2, "received"),
      inquiry(3, "rejected"),
      inquiry(4, "in_progress"),
      inquiry(5, "received"),
    ]);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listInquiries(
        index as never,
        "Inquiry",
        { limit: 2, ...(cursor ? { cursor: decodeCursor(cursor)! } : {}) },
        NOW,
      );
      seen.push(
        ...page.items.map((i) => `${i.status}:${i.inquiryId.slice(-1)}`),
      );
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([
      "received:2",
      "received:5",
      "in_progress:4",
      "resolved:1",
      "rejected:3",
    ]);
  });

  it("저장된 모양이 틀린 문의는 조용히 빼지 않고 던진다", async () => {
    const index = new FakeIndex([inquiry(1, "received", { version: "1" })]);
    await expect(
      listInquiries(index as never, "Inquiry", { limit: 20 }, NOW),
    ).rejects.toThrow("모양");
  });
});

describe("문의 서버 필터", () => {
  const scope = "a".repeat(64);

  it("유형·해변·접수 경계·본문 검색을 모두 적용하고 본문 앞부분만 반환한다", async () => {
    const from = "2026-11-03T05:55:00.000Z";
    const to = "2026-11-03T05:59:00.000Z";
    const message = `  검색
  ${"🌊".repeat(45)} 끝  `;
    const index = new FakeIndex([
      inquiry(1, "received", { beachId: "b0001", message }),
      inquiry(2, "received", { beachId: "b0002", message }),
      inquiry(3, "received", {
        beachId: "b0001",
        inquiryType: "beach_request",
        message,
      }),
      inquiry(4, "received", { beachId: "b0001" }),
      inquiry(5, "received", { beachId: "b0001", message }),
      inquiry(6, "received", { beachId: "b0001", message }),
    ]);
    const page = await listFilteredInquiries(
      index as never,
      "Inquiry",
      { status: "received", limit: 50 },
      {
        q: "검색",
        type: "data_error",
        beachId: "b0001",
        from,
        to,
        preview: true,
      },
      scope,
      "editor",
      NOW,
      () => false,
    );
    expect(index.queries).toHaveLength(1);
    expect(index.queries[0]).toMatchObject({
      KeyConditionExpression: "#s = :s AND #received BETWEEN :from AND :to",
      ExpressionAttributeValues: { ":from": from, ":to": to },
      Limit: 4,
    });
    expect(index.gets).toHaveLength(2);
    expect(index.gets.every((get) => get.ConsistentRead === true)).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      messagePreview: `검색 ${"🌊".repeat(39)}…`,
    });
    expect(page.items[0]).not.toHaveProperty("message");
    const next = await listFilteredInquiries(
      index as never,
      "Inquiry",
      {
        status: "received",
        limit: 50,
        cursor: decodeCursor(page.nextCursor!)!,
      },
      {
        q: "검색",
        type: "data_error",
        beachId: "b0001",
        from,
        to,
        preview: true,
      },
      scope,
      "editor",
      NOW,
      () => false,
    );
    expect(next.items.map((item) => item.receivedAt)).toEqual([from]);
    expect(next.nextCursor).toBeNull();
  });

  it("빈 페이지를 건너뛰어 인덱스 및 상태 cursor를 순서대로 끝까지 잇는다", async () => {
    const index = new FakeIndex([
      ...Array.from({ length: 8 }, (_, n) => inquiry(n + 1, "received")),
      inquiry(9, "received", { beachId: "b0001" }),
      inquiry(10, "in_progress", { beachId: "b0001", ttl: NOW_SEC }),
      inquiry(11, "resolved", { beachId: "b0001" }),
      inquiry(12, "rejected", { beachId: "b0001" }),
    ]);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const page = await listFilteredInquiries(
        index as never,
        "Inquiry",
        { limit: 50, ...(cursor ? { cursor: decodeCursor(cursor)! } : {}) },
        { q: "해변", preview: true },
        scope,
        "viewer",
        NOW,
        () => true,
      );
      if (i === 0) {
        expect(page.items).toEqual([]);
        expect(page.nextCursor).not.toBeNull();
      }
      for (const item of page.items) {
        expect(item).not.toHaveProperty("messagePreview");
        seen.push(item.status);
      }
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(["received", "resolved", "rejected"]);
    expect(cursor).toBeNull();
    expect(index.gets).toHaveLength(0);
    expect(index.queries).toHaveLength(5);
  });

  it("본문 조회 실패는 검색 결과 없음으로 처리하지 않는다", async () => {
    const index = new FakeIndex([inquiry(1, "received")]);
    const client = {
      send: (command: Parameters<FakeIndex["send"]>[0]) => {
        if (command.constructor.name === "GetCommand")
          throw new Error("read failed");
        return index.send(command);
      },
    };
    await expect(
      listFilteredInquiries(
        client as never,
        "Inquiry",
        { status: "received", limit: 50 },
        { q: "본문" },
        scope,
        "publisher",
        NOW,
      ),
    ).rejects.toThrow("read failed");
  });
});

describe("상태별 문의 수", () => {
  it("상태마다 세고 보관 기한이 지난 문의는 빼며, 여러 쪽이면 이어서 센다", async () => {
    const index = new FakeIndex(
      [
        inquiry(1, "received"),
        inquiry(2, "received"),
        inquiry(3, "received"),
        inquiry(4, "received", { ttl: NOW_SEC }),
        inquiry(5, "rejected"),
      ],
      2,
    );
    expect(await countInquiries(index as never, "Inquiry", NOW)).toEqual({
      received: 3,
      in_progress: 0,
      resolved: 0,
      rejected: 1,
    });
    expect(index.queries[0]).toMatchObject({
      IndexName: INQUIRY_STATUS_INDEX_NAME,
      Select: "COUNT",
    });
  });

  it("응답에 Count가 없으면 0으로 세지 않고 던진다", async () => {
    const broken = { send: async () => ({}) };
    await expect(
      countInquiries(broken as never, "Inquiry", NOW),
    ).rejects.toThrow("모양");
  });
});

describe("cursor", () => {
  it("되돌려 읽을 수 있다", () => {
    const state = {
      s: "in_progress" as const,
      k: { pk: "INQUIRY#x", inquiryStatus: "in_progress", receivedAt: "t" },
    };
    expect(decodeCursor(encodeCursor(state))).toEqual(state);
  });

  it.each([
    ["base64가 아님", "!!!"],
    ["JSON이 아님", Buffer.from("x").toString("base64url")],
    ["모르는 상태", encodeCursor({ s: "done" as never })],
    [
      "키의 상태가 다름",
      Buffer.from(
        JSON.stringify({
          s: "received",
          k: { pk: "p", inquiryStatus: "rejected", receivedAt: "t" },
        }),
      ).toString("base64url"),
    ],
    [
      "키에 숫자",
      Buffer.from(
        JSON.stringify({
          s: "received",
          k: { pk: 1, inquiryStatus: "received", receivedAt: "t" },
        }),
      ).toString("base64url"),
    ],
  ])("%s이면 null", (_, cursor) => {
    expect(decodeCursor(cursor)).toBeNull();
  });
});

describe("문의 상세", () => {
  const item = inquiry(1, "rejected", {
    memo: "내부 메모",
    rejectReason: "중복",
  });

  it("편집 권한은 본문·메모·반려 이유를 받는다", async () => {
    const detail = await getInquiry(
      new FakeIndex([item]) as never,
      "Inquiry",
      String(item.inquiryId),
      "editor",
      NOW,
    );
    expect(detail).toMatchObject({
      restricted: false,
      message: "본문",
      memo: "내부 메모",
      rejectReason: "중복",
      emailCollected: false,
      photosCollected: false,
    });
  });

  it("보기 권한은 본문·메모·반려 이유를 받지 않는다", async () => {
    const detail = await getInquiry(
      new FakeIndex([item]) as never,
      "Inquiry",
      String(item.inquiryId),
      "viewer",
      NOW,
    );
    expect(detail?.restricted).toBe(true);
    expect(detail).not.toHaveProperty("message");
    expect(detail).not.toHaveProperty("memo");
    expect(detail).not.toHaveProperty("rejectReason");
  });

  it("없거나 보관 기한이 지났거나 문의가 아닌 항목은 null", async () => {
    for (const items of [
      [],
      [inquiry(1, "received", { ttl: NOW_SEC })],
      [inquiry(1, "received", { kind: "inquiry_email" })],
    ]) {
      expect(
        await getInquiry(
          new FakeIndex(items) as never,
          "Inquiry",
          "00000000-0000-4000-8000-000000000001",
          "editor",
          NOW,
        ),
      ).toBeNull();
    }
  });

  it("상태 기록 전 문의는 접수·version 0·이전 문의로 보여 준다", async () => {
    const legacy = inquiry(1, "received", {
      inquiryStatus: undefined,
      version: undefined,
    });
    const detail = await getInquiry(
      new FakeIndex([legacy]) as never,
      "Inquiry",
      String(legacy.inquiryId),
      "editor",
      NOW,
    );
    expect(detail).toMatchObject({
      status: "received",
      version: 0,
      legacy: true,
    });
  });
});

describe("처리 요청 검사", () => {
  it("상태·메모를 받는다", () => {
    expect(
      parseInquiryPatch({ version: 1, status: "in_progress", memo: "확인" }),
    ).toEqual({
      ok: true,
      patch: { version: 1, status: "in_progress", memo: "확인" },
    });
  });

  it("반려는 이유가 필수이고 공백만은 거부하며, 앞뒤 공백은 지운다", () => {
    expect(parseInquiryPatch({ version: 1, status: "rejected" })).toEqual({
      ok: false,
      field: "rejectReason",
    });
    expect(
      parseInquiryPatch({
        version: 1,
        status: "rejected",
        rejectReason: "  \n ",
      }),
    ).toEqual({ ok: false, field: "rejectReason" });
    expect(
      parseInquiryPatch({
        version: 1,
        status: "rejected",
        rejectReason: " 중복 ",
      }),
    ).toEqual({
      ok: true,
      patch: { version: 1, status: "rejected", rejectReason: "중복" },
    });
  });

  it.each([
    ["본문이 객체가 아님", [], "body"],
    ["바꿀 것이 없음", { version: 1 }, "body"],
    ["모르는 칸", { version: 1, status: "received", owner: "x" }, "owner"],
    ["version 없음", { status: "received" }, "version"],
    ["음수 version", { version: -1, status: "received" }, "version"],
    ["모르는 상태", { version: 1, status: "done" }, "status"],
    ["메모가 문자열이 아님", { version: 1, memo: 3 }, "memo"],
    ["메모가 너무 김", { version: 1, memo: "가".repeat(MEMO_MAX + 1) }, "memo"],
    [
      "반려 이유가 너무 김",
      {
        version: 1,
        status: "rejected",
        rejectReason: "가".repeat(REJECT_REASON_MAX + 1),
      },
      "rejectReason",
    ],
    [
      "반려가 아닌데 반려 이유를 보냄",
      { version: 1, status: "resolved", rejectReason: "x" },
      "rejectReason",
    ],
  ])("%s이면 거부(%s)", (_, body, field) => {
    expect(parseInquiryPatch(body)).toEqual({ ok: false, field });
  });

  it("메모를 null로 보내면 지운다", () => {
    expect(parseInquiryPatch({ version: 2, memo: null })).toEqual({
      ok: true,
      patch: { version: 2, memo: null },
    });
  });
});

describe("저장 속성", () => {
  it("반려가 아닌 상태로 바꾸면 반려 이유를 지운다", () => {
    expect(inquiryPatchFields({ version: 1, status: "resolved" })).toEqual({
      inquiryStatus: "resolved",
      rejectReason: null,
    });
    expect(
      inquiryPatchFields({
        version: 1,
        status: "rejected",
        rejectReason: "중복",
      }),
    ).toEqual({ inquiryStatus: "rejected", rejectReason: "중복" });
    expect(inquiryPatchFields({ version: 1, memo: "m" })).toEqual({
      memo: "m",
    });
  });
});

describe("개인정보 가리기", () => {
  it("범위를 앞에서부터 겹치지 않게 받는다", () => {
    expect(
      parseInquiryPatch({
        version: 1,
        redactions: [
          { start: 0, end: 2, text: "ab" },
          { start: 2, end: 3, text: "c" },
        ],
      }),
    ).toMatchObject({ ok: true });
  });

  it.each([
    ["빈 배열", []],
    [
      "너무 많음",
      Array.from({ length: 21 }, (_, i) => ({
        start: i,
        end: i + 1,
        text: "x",
      })),
    ],
    [
      "겹침",
      [
        { start: 0, end: 3, text: "abc" },
        { start: 2, end: 4, text: "cd" },
      ],
    ],
    ["빈 범위", [{ start: 2, end: 2, text: "" }]],
    ["글 길이가 범위와 다름", [{ start: 0, end: 3, text: "ab" }]],
    ["모르는 칸", [{ start: 0, end: 1, text: "a", note: "x" }]],
    ["정수 아님", [{ start: 0.5, end: 1, text: "a" }]],
  ])("%s이면 거부", (_, redactions) => {
    expect(parseInquiryPatch({ version: 1, redactions })).toEqual({
      ok: false,
      field: "redactions",
    });
  });

  it("고른 부분을 표시로 바꾸고, 본문과 다르거나 글자를 자르면 null", () => {
    const message = "이름 홍길동, 번호 010-0000-0000";
    expect(
      applyRedactions(message, [
        { start: 3, end: 6, text: "홍길동" },
        { start: 11, end: 24, text: "010-0000-0000" },
      ]),
    ).toBe("이름 [가림], 번호 [가림]");
    expect(
      applyRedactions(message, [{ start: 0, end: 2, text: "홍길" }]),
    ).toBeNull();
    expect(
      applyRedactions(message, [{ start: 2, end: 3, text: " " }]),
    ).toBeNull();
    expect(
      applyRedactions("ab", [{ start: 1, end: 3, text: "b?" }]),
    ).toBeNull();
    // 이모지(서로게이트 쌍) 가운데를 자르지 않음
    expect(
      applyRedactions("a😀b", [{ start: 1, end: 2, text: "\ud83d" }]),
    ).toBeNull();
    expect(applyRedactions("a😀b", [{ start: 1, end: 3, text: "😀" }])).toBe(
      "a[가림]b",
    );
  });
});

describe("모르는 처리 상태 (#521, 아키텍처 18.3)", () => {
  const scope = "a".repeat(64);
  afterEach(() => vi.restoreAllMocks());

  function logged(
    log: { mock: { calls: unknown[][] } },
    event: string,
  ): Item[] {
    return log.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Item)
      .filter((entry) => entry.event === event);
  }

  it("Scan 한 번으로 4종 밖·보관 기한 안의 문의를 최근 접수 순으로 모두 읽는다", async () => {
    const index = new FakeIndex([
      inquiry(1, "received"),
      inquiry(5, "archived"),
      inquiry(3, "on_hold", { ttl: NOW_SEC }),
      inquiry(2, "on_hold"),
    ]);
    const unknown = await readUnknownStatuses(index as never, "Inquiry", NOW);
    expect(unknown.ok).toBe(true);
    expect(
      unknown.ok &&
        unknown.items.map((i) => `${i.status}:${i.inquiryId.slice(-1)}`),
    ).toEqual(["on_hold:2", "archived:5"]);
    expect(index.scans).toHaveLength(1);
    expect(index.scans[0]).toMatchObject({
      IndexName: INQUIRY_STATUS_INDEX_NAME,
    });
    expect(index.scans[0]).not.toHaveProperty("Limit");
    expect(index.queries).toHaveLength(0);
  });

  it("걸러 읽기 Scan이 0건인 쪽을 돌려줘도 LastEvaluatedKey가 이어지면 끝까지 읽는다", async () => {
    const index = new FakeIndex(
      [
        ...Array.from({ length: 5 }, (_, n) => inquiry(n + 1, "received")),
        inquiry(6, "archived"),
      ],
      100,
      2,
    );
    const unknown = await readUnknownStatuses(index as never, "Inquiry", NOW);
    expect(unknown.ok && unknown.items.map((i) => i.status)).toEqual([
      "archived",
    ]);
    // 2개씩 평가: [1,2](0건) → [3,4](0건) → [5,6](1건)
    expect(index.scans).toHaveLength(3);
    expect(index.scans[1]!.ExclusiveStartKey).toMatchObject({
      pk: inquiry(2, "received").pk,
    });
  });

  it.each([
    ["권한 없음", "AccessDeniedException"],
    ["쓰로틀", "ProvisionedThroughputExceededException"],
  ])(
    "Scan 실패(%s)는 던지지 않고 warn 로그와 '확인 못 함'으로 돌려준다",
    async (_, name) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const client = {
        send: async () => {
          const error = new Error("denied");
          error.name = name;
          throw error;
        },
      };
      expect(
        await readUnknownStatuses(client as never, "Inquiry", NOW),
      ).toEqual({
        ok: false,
      });
      expect(logged(log, "ops_inquiry_unknown_status_unavailable")).toEqual([
        {
          level: "warn",
          event: "ops_inquiry_unknown_status_unavailable",
          error: name,
        },
      ]);
    },
  );

  it("저장된 모양이 틀린 모르는 상태 문의는 '확인 못 함'으로 바꾸지 않고 던진다", async () => {
    const index = new FakeIndex([inquiry(1, "archived", { version: "1" })]);
    await expect(
      readUnknownStatuses(index as never, "Inquiry", NOW),
    ).rejects.toThrow("모양");
  });

  it("전체 목록 첫 쪽은 맨 위에 모르는 상태 문의를 원래 값 그대로 두고 4종을 이어 붙인다", async () => {
    const index = new FakeIndex([
      inquiry(1, "received"),
      inquiry(2, "archived"),
      inquiry(4, "resolved"),
    ]);
    const unknown = await readUnknownStatuses(index as never, "Inquiry", NOW);
    const page = await listInquiries(
      index as never,
      "Inquiry",
      { limit: 20 },
      NOW,
      unknown,
    );
    expect(
      page.items.map((i) => `${i.status}:${i.inquiryId.slice(-1)}`),
    ).toEqual(["archived:2", "received:1", "resolved:4"]);
    expect(page.nextCursor).toBeNull();
    // 4개 탭 수에는 섞이지 않음
    expect(await countInquiries(index as never, "Inquiry", NOW)).toEqual({
      received: 1,
      in_progress: 0,
      resolved: 1,
      rejected: 0,
    });
  });

  it("모르는 상태는 limit에 세지 않아 첫 쪽은 '모르는 상태 전부 + 4종 한 쪽'이고, 4종이 더 없으면 다음 쪽이 없다", async () => {
    const index = new FakeIndex([
      inquiry(1, "received"),
      inquiry(2, "archived"),
      inquiry(3, "on_hold"),
      inquiry(5, "archived"),
    ]);
    const unknown = await readUnknownStatuses(index as never, "Inquiry", NOW);
    const page = await listInquiries(
      index as never,
      "Inquiry",
      { limit: 2 },
      NOW,
      unknown,
    );
    expect(page.items.map((i) => i.status)).toEqual([
      "archived",
      "on_hold",
      "archived",
      "received",
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("4종이 한 쪽보다 많으면 4종 cursor는 지금처럼 이어 가고 다음 쪽에는 모르는 상태를 다시 넣지 않는다", async () => {
    const index = new FakeIndex([
      inquiry(1, "received"),
      inquiry(2, "received"),
      inquiry(3, "received"),
      inquiry(4, "archived"),
    ]);
    const unknown = await readUnknownStatuses(index as never, "Inquiry", NOW);
    const first = await listInquiries(
      index as never,
      "Inquiry",
      { limit: 2 },
      NOW,
      unknown,
    );
    expect(
      first.items.map((i) => `${i.status}:${i.inquiryId.slice(-1)}`),
    ).toEqual(["archived:4", "received:1", "received:2"]);
    const second = await listInquiries(
      index as never,
      "Inquiry",
      { limit: 2, cursor: decodeCursor(first.nextCursor!)! },
      NOW,
      unknown,
    );
    expect(
      second.items.map((i) => `${i.status}:${i.inquiryId.slice(-1)}`),
    ).toEqual(["received:3"]);
  });

  it("상태를 고른 목록·다음 쪽·읽지 못한 경우에는 모르는 상태를 넣지 않는다", async () => {
    const index = new FakeIndex([
      inquiry(1, "received"),
      inquiry(2, "archived"),
    ]);
    const unknown = await readUnknownStatuses(index as never, "Inquiry", NOW);
    const picked = await listInquiries(
      index as never,
      "Inquiry",
      { status: "received", limit: 20 },
      NOW,
      unknown,
    );
    expect(picked.items.map((i) => i.status)).toEqual(["received"]);
    const next = await listInquiries(
      index as never,
      "Inquiry",
      { limit: 20, cursor: { s: "received" } },
      NOW,
      unknown,
    );
    expect(next.items.map((i) => i.status)).toEqual(["received"]);
    const failed = await listInquiries(
      index as never,
      "Inquiry",
      { limit: 20 },
      NOW,
      { ok: false },
    );
    expect(failed.items.map((i) => i.status)).toEqual(["received"]);
  });

  it("서버 필터 전체 목록의 첫 쪽은 모르는 상태 문의를 같은 조건으로 걸러(본문은 상세에서 상태가 그대로일 때만) 맨 앞에 두고 '접수' 첫 묶음을 이어 붙인다", async () => {
    const index = new FakeIndex([
      inquiry(1, "received"),
      inquiry(3, "archived"),
      inquiry(9, "archived"),
    ]);
    const unknown = await readUnknownStatuses(index as never, "Inquiry", NOW);
    const from = "2026-11-03T05:56:00.000Z";
    const page = await listFilteredInquiries(
      index as never,
      "Inquiry",
      { limit: 50 },
      { from, q: "본문" },
      scope,
      "editor",
      NOW,
      () => false,
      unknown,
    );
    // 9번은 접수 경계 밖
    expect(
      page.items.map((i) => `${i.status}:${i.inquiryId.slice(-1)}`),
    ).toEqual(["archived:3", "received:1"]);
    expect(index.gets.map((g) => (g.Key as Item).pk)).toEqual([
      inquiry(3, "archived").pk,
      inquiry(1, "received").pk,
    ]);
    expect(index.queries).toHaveLength(1);
    expect(decodeCursor(page.nextCursor!)).toEqual({
      s: "in_progress",
      f: scope,
    });
    // 읽지 못했으면 4종만 그대로
    const failed = await listFilteredInquiries(
      index as never,
      "Inquiry",
      { limit: 50 },
      { from, q: "본문" },
      scope,
      "editor",
      NOW,
      () => false,
      { ok: false },
    );
    expect(failed.items.map((i) => i.status)).toEqual(["received"]);
  });

  it("Scan이 시간 상한을 넘으면 기다리지 않고 '확인 못 함'으로 돌려준다", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let aborted = false;
    const client = {
      send: (_: unknown, options?: { abortSignal?: AbortSignal }) =>
        new Promise(() => {
          options?.abortSignal?.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    };
    expect(
      await readUnknownStatuses(client as never, "Inquiry", NOW, 10),
    ).toEqual({ ok: false });
    expect(aborted).toBe(true);
    expect(logged(log, "ops_inquiry_unknown_status_unavailable")).toEqual([
      {
        level: "warn",
        event: "ops_inquiry_unknown_status_unavailable",
        error: "TimeoutError",
      },
    ]);
  });

  it("상세는 원래 값 그대로 내려 주고, 읽을 때마다 warn 로그를 남긴다", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const index = new FakeIndex([inquiry(1, "archived")]);
    const detail = await getInquiry(
      index as never,
      "Inquiry",
      inquiry(1, "archived").inquiryId as string,
      "editor",
      NOW,
    );
    expect(detail).toMatchObject({ status: "archived", restricted: false });
    await readUnknownStatuses(index as never, "Inquiry", NOW);
    const warn = {
      level: "warn",
      event: "ops_inquiry_unknown_status",
      inquiryId: inquiry(1, "archived").inquiryId,
      status: "archived",
    };
    expect(logged(log, "ops_inquiry_unknown_status")).toEqual([warn, warn]);
  });

  it("로그의 상태 값은 40자까지만 남기고, 4종은 로그를 남기지 않는다", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const index = new FakeIndex([
      inquiry(1, "x".repeat(100)),
      inquiry(2, "received"),
    ]);
    const unknown = await readUnknownStatuses(index as never, "Inquiry", NOW);
    await listInquiries(index as never, "Inquiry", { limit: 20 }, NOW, unknown);
    expect(
      logged(log, "ops_inquiry_unknown_status").map((w) => w.status),
    ).toEqual(["x".repeat(40)]);
  });

  it("빈 상태 값은 모양이 틀린 문의로 보고 던진다", async () => {
    const index = new FakeIndex([inquiry(1, "")]);
    await expect(
      getInquiry(
        index as never,
        "Inquiry",
        inquiry(1, "").inquiryId as string,
        "editor",
        NOW,
      ),
    ).rejects.toThrow("모양");
  });

  it("Scan 결과는 60초 동안 다시 쓰고, 지나거나 버리면 다시 읽는다", async () => {
    const index = new FakeIndex([inquiry(1, "archived")]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await readUnknownStatuses(index as never, "Inquiry", NOW);
    const again = await readUnknownStatuses(
      index as never,
      "Inquiry",
      new Date(NOW.getTime() + 59_999),
    );
    expect(again).toEqual(first);
    expect(index.scans).toHaveLength(1);
    await readUnknownStatuses(
      index as never,
      "Inquiry",
      new Date(NOW.getTime() + 60_000),
    );
    expect(index.scans).toHaveLength(2);
    forgetUnknownStatuses(index as never);
    await readUnknownStatuses(
      index as never,
      "Inquiry",
      new Date(NOW.getTime() + 60_001),
    );
    expect(index.scans).toHaveLength(3);
  });

  it("읽은 문의의 보관 기한이 60초 안에 끝나면 그 시각까지만 Scan 결과를 다시 쓴다", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const index = new FakeIndex([
      inquiry(1, "archived", { ttl: NOW_SEC + 10 }),
    ]);
    await readUnknownStatuses(index as never, "Inquiry", NOW);
    await readUnknownStatuses(
      index as never,
      "Inquiry",
      new Date((NOW_SEC + 9) * 1000),
    );
    expect(index.scans).toHaveLength(1);
    const later = await readUnknownStatuses(
      index as never,
      "Inquiry",
      new Date((NOW_SEC + 10) * 1000),
    );
    expect(index.scans).toHaveLength(2);
    expect(later).toEqual({ ok: true, items: [] });
  });

  it("다시 쓰는 Scan 결과가 4종으로 바뀐 문의를 아직 모르면 같은 문의를 두 번 싣지 않고 4종 쪽만 남긴다", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const before = new FakeIndex([inquiry(1, "archived")]);
    const unknown = await readUnknownStatuses(before as never, "Inquiry", NOW);
    // 다른 인스턴스가 '접수'로 바꾼 뒤(이 인스턴스의 Scan 결과는 이전 값)
    const after = new FakeIndex([inquiry(1, "received")]);
    const page = await listInquiries(
      after as never,
      "Inquiry",
      { limit: 6 },
      NOW,
      unknown,
    );
    expect(page.items.map((i) => i.status)).toEqual(["received"]);
    const filtered = await listFilteredInquiries(
      after as never,
      "Inquiry",
      { limit: 6 },
      {},
      scope,
      "editor",
      NOW,
      undefined,
      unknown,
    );
    expect(filtered.items.map((i) => i.status)).toEqual(["received"]);
  });

  it("읽지 못한 결과는 다시 쓰지 않아 다음 요청이 바로 다시 읽는다", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let calls = 0;
    const client = {
      send: async () => {
        calls += 1;
        if (calls === 1) {
          const error = new Error("throttled");
          error.name = "ProvisionedThroughputExceededException";
          throw error;
        }
        return { Items: [] };
      },
    };
    expect(await readUnknownStatuses(client as never, "Inquiry", NOW)).toEqual({
      ok: false,
    });
    expect(await readUnknownStatuses(client as never, "Inquiry", NOW)).toEqual({
      ok: true,
      items: [],
    });
    expect(calls).toBe(2);
  });

  it("version이 없는 모르는 상태 문의는 상세와 같게 version 0으로 보여 주고 목록을 500으로 만들지 않는다", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const index = new FakeIndex([
      inquiry(1, "archived", { version: undefined }),
      inquiry(2, "received"),
    ]);
    const unknown = await readUnknownStatuses(index as never, "Inquiry", NOW);
    expect(unknown.ok && unknown.items).toEqual([
      expect.objectContaining({
        status: "archived",
        version: 0,
        legacy: false,
      }),
    ]);
    const detail = await getInquiry(
      index as never,
      "Inquiry",
      inquiry(1, "archived").inquiryId as string,
      "editor",
      NOW,
    );
    expect(detail).toMatchObject({ version: 0, legacy: false });
  });

  it("목록에는 모르는 상태 문의를 최근 접수 순 50건까지만 싣는다(서버 필터 첫 쪽도 같음)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const index = new FakeIndex([
      ...Array.from({ length: 55 }, (_, n) => inquiry(n + 1, "archived")),
      inquiry(100, "received"),
    ]);
    const unknown = await readUnknownStatuses(index as never, "Inquiry", NOW);
    expect(unknown.ok && unknown.items).toHaveLength(55);
    const page = await listInquiries(
      index as never,
      "Inquiry",
      { limit: 1 },
      NOW,
      unknown,
    );
    expect(page.items).toHaveLength(51);
    expect(page.items[0]!.inquiryId).toBe(inquiry(1, "archived").inquiryId);
    expect(page.items[49]!.inquiryId).toBe(inquiry(50, "archived").inquiryId);
    expect(page.items[50]!.status).toBe("received");
    const filtered = await listFilteredInquiries(
      index as never,
      "Inquiry",
      { limit: 50 },
      { type: "data_error" },
      scope,
      "editor",
      NOW,
      () => false,
      unknown,
    );
    expect(filtered.items.filter((i) => i.status === "archived")).toHaveLength(
      50,
    );
  });

  it("서버 필터 첫 쪽에서 모르는 상태 문의의 본문 확인이 시간 상한을 넘으면 빼지 않고 '본문 확인 못 함'으로 둔다", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const index = new FakeIndex([
        inquiry(1, "archived"),
        inquiry(2, "archived"),
        inquiry(3, "archived", { message: "다른 글" }),
        inquiry(4, "received"),
      ]);
      const unknown = await readUnknownStatuses(index as never, "Inquiry", NOW);
      const slow = inquiry(2, "archived").pk;
      let aborted = false;
      const client = {
        send: (
          command: { constructor: { name: string }; input: any },
          options?: { abortSignal?: AbortSignal },
        ) => {
          if (
            command.constructor.name === "GetCommand" &&
            command.input.Key.pk === slow
          ) {
            options?.abortSignal?.addEventListener("abort", () => {
              aborted = true;
            });
            return new Promise(() => {});
          }
          return index.send(command);
        },
      };
      const pending = listFilteredInquiries(
        client as never,
        "Inquiry",
        { limit: 50 },
        { q: "본문", preview: true },
        scope,
        "editor",
        NOW,
        () => false,
        unknown,
      );
      await vi.advanceTimersByTimeAsync(UNKNOWN_STATUS_TIMEOUT_MS);
      const page = await pending;
      expect(aborted).toBe(true);
      // 1: 확인함(맞음) · 2: 시간 초과 · 3: 상한 뒤라 확인 못 함(다른 글이어도 빼지 않음) · 4: 4종(상한 없음)
      expect(
        page.items.map((i) => [
          i.inquiryId.slice(-1),
          i.messagePreviewUnavailableReason ?? i.messagePreview,
        ]),
      ).toEqual([
        ["1", "본문"],
        ["2", "unchecked"],
        ["3", "unchecked"],
        ["4", "본문"],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
