import { describe, expect, it } from "vitest";
import {
  countInquiries,
  decodeCursor,
  encodeCursor,
  getInquiry,
  applyRedactions,
  inquiryPatchFields,
  listInquiries,
  MEMO_MAX,
  parseInquiryPatch,
  REJECT_REASON_MAX,
} from "./inquiries";
import { INQUIRY_STATUS_INDEX_NAME } from "../inquiry/policy";

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
class FakeIndex {
  readonly queries: Item[] = [];
  constructor(
    private readonly items: Item[],
    private readonly pageSize = 100,
  ) {}

  async send(command: { constructor: { name: string }; input: any }) {
    const input = command.input;
    if (command.constructor.name === "GetCommand") {
      return { Item: this.items.find((i) => i.pk === input.Key.pk) };
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
      .filter((i) => i.inquiryStatus === status)
      .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
    const start = input.ExclusiveStartKey
      ? sorted.findIndex((i) => i.pk === input.ExclusiveStartKey.pk) + 1
      : 0;
    const page = sorted.slice(start, start + input.Limit);
    const more = start + input.Limit < sorted.length;
    const last = page.at(-1);
    return {
      Items: page,
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
