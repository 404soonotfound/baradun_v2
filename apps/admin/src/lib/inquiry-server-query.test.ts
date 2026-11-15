import { describe, expect, it } from "vitest";
import { localOps } from "./auth/local-dev";
import {
  BEACH_NONE,
  EMPTY_INQUIRY_FILTER,
  INQUIRY_SEARCH_MAX,
  inquiryServerQuery,
  isReceivedFilterActive,
  isReceivedRangeInvalid,
  receivedRangeMs,
  receivedRangeProblem,
} from "./inquiries";

// 문의 화면 조건 → 서버 필터 요청 (#502, 서버 #491)
// 2026-11-15 17:30 KST
const NOW = new Date("2026-11-15T08:30:00.000Z");

describe("receivedRangeMs", () => {
  it("오늘은 KST 자정부터 다음 날 자정 직전까지", () => {
    const { fromMs, toMs } = receivedRangeMs({ preset: "today" }, NOW)!;
    expect(new Date(fromMs!).toISOString()).toBe("2026-11-14T15:00:00.000Z");
    expect(new Date(toMs!).toISOString()).toBe("2026-11-15T14:59:59.999Z");
  });

  it("KST 자정을 막 넘긴 때도 그 KST 날을 오늘로 봄", () => {
    // 2026-11-16 00:10 KST
    const { fromMs } = receivedRangeMs(
      { preset: "today" },
      new Date("2026-11-15T15:10:00.000Z"),
    )!;
    expect(new Date(fromMs!).toISOString()).toBe("2026-11-15T15:00:00.000Z");
  });

  it("7일·30일은 now 기준, 직접 입력은 KST 입력값을 UTC로", () => {
    expect(receivedRangeMs({ preset: "7d" }, NOW)).toEqual({
      fromMs: NOW.getTime() - 7 * 86_400_000,
      toMs: NOW.getTime(),
    });
    const custom = receivedRangeMs(
      { preset: "custom", from: "2026-11-02T13:00", to: "2026-11-03" },
      NOW,
    )!;
    expect(new Date(custom.fromMs!).toISOString()).toBe(
      "2026-11-02T04:00:00.000Z",
    );
    // 날짜만 입력한 끝은 그날 KST 자정 직전까지
    expect(new Date(custom.toMs!).toISOString()).toBe(
      "2026-11-03T14:59:59.999Z",
    );
    expect(
      receivedRangeProblem({
        preset: "custom",
        from: "2026-11-03T10:00",
        to: "2026-11-03T09:00",
      }),
    ).toBe("order");
    expect(receivedRangeMs({ preset: "custom", from: " " }, NOW)).toEqual({
      fromMs: null,
      toMs: null,
    });
    // 초까지 입력한 끝은 그 초 끝까지
    expect(
      receivedRangeMs({ preset: "custom", to: "2026-11-03T09:00:30" }, NOW)!
        .toMs,
    ).toBe(Date.parse("2026-11-03T00:00:30.999Z"));
    // 소수 초(datetime-local 값 형식)는 그 밀리초까지
    expect(
      receivedRangeMs(
        {
          preset: "custom",
          from: "2026-11-03T09:00:00.5",
          to: "2026-11-03T09:00:00.250",
        },
        NOW,
      ),
    ).toEqual({
      fromMs: Date.parse("2026-11-03T00:00:00.500Z"),
      toMs: Date.parse("2026-11-03T00:00:00.250Z"),
    });
  });

  it.each([
    ["5자리 연도", "20260-11-03T10:00"],
    ["1000년 미만(입력 도중 값)", "0002-11-15T10:00"],
    ["소수 초 4자리", "2026-11-03T09:00:00.1234"],
    ["없는 달", "2026-13-01"],
    ["달력에 없는 날(다음 달로 넘기지 않음)", "2026-02-31"],
    ["없는 시각", "2026-11-03T24:00"],
    ["시간대가 붙은 형식(실행 환경 시간대 해석 방지)", "2026-11-03T09:00:00Z"],
    ["날짜가 아닌 글", "어제"],
  ])(
    "형식이 틀린 직접 입력은 경계를 버리지 않고 틀린 조건(null): %s",
    (_, bad) => {
      expect(receivedRangeMs({ preset: "custom", from: bad }, NOW)).toBeNull();
      expect(
        receivedRangeMs({ preset: "custom", from: "2026-11-01", to: bad }, NOW),
      ).toBeNull();
      expect(isReceivedRangeInvalid({ preset: "custom", from: bad })).toBe(
        true,
      );
      // 화면이 '시작이 끝보다 늦음'이 아닌 형식 안내를 고를 수 있게 이유를 나눔
      expect(receivedRangeProblem({ preset: "custom", from: bad })).toBe(
        "format",
      );
      // 조건 없음이 되지 않고 켜진 조건으로 남아 안내가 보임
      expect(isReceivedFilterActive({ preset: "custom", from: bad })).toBe(
        true,
      );
      expect(
        inquiryServerQuery(
          { ...EMPTY_INQUIRY_FILTER, received: { preset: "custom", to: bad } },
          NOW,
        ),
      ).toEqual({ ok: false, invalid: "received" });
    },
  );
});

describe("inquiryServerQuery", () => {
  it("조건이 없으면 빈 요청", () => {
    expect(inquiryServerQuery(EMPTY_INQUIRY_FILTER, NOW)).toEqual({
      ok: true,
      query: {},
    });
  });

  it("검색어·유형·해변(해변 없음 포함)·받은 시각을 서버 이름과 UTC ISO로 바꿈", () => {
    expect(
      inquiryServerQuery(
        {
          query: "  경포  ",
          type: "data_error",
          beach: BEACH_NONE,
          received: { preset: "today" },
        },
        NOW,
      ),
    ).toEqual({
      ok: true,
      query: {
        q: "경포",
        type: "data_error",
        beachId: "__none__",
        from: "2026-11-14T15:00:00.000Z",
        to: "2026-11-15T14:59:59.999Z",
      },
    });
  });

  it("한쪽 경계만 있으면 그쪽만 보내고, 분까지 입력한 끝은 그 분 끝까지 포함", () => {
    const result = inquiryServerQuery(
      {
        ...EMPTY_INQUIRY_FILTER,
        received: { preset: "custom", to: "2026-11-03T09:00" },
      },
      NOW,
    );
    // 09:00까지 → 09:00:59.999 KST(09:00:30에 받은 문의도 들어감)
    expect(result).toEqual({
      ok: true,
      query: { to: "2026-11-03T00:00:59.999Z" },
    });
  });

  it("유형·해변이 서버 형식 밖이면 보내지 않고 이유를 돌려줌", () => {
    expect(
      inquiryServerQuery({ ...EMPTY_INQUIRY_FILTER, type: "Data-Error" }, NOW),
    ).toEqual({ ok: false, invalid: "type" });
    expect(
      inquiryServerQuery({ ...EMPTY_INQUIRY_FILTER, beach: "경포" }, NOW),
    ).toEqual({ ok: false, invalid: "beach" });
    expect(
      inquiryServerQuery({ ...EMPTY_INQUIRY_FILTER, beach: "b0001" }, NOW),
    ).toEqual({ ok: true, query: { beachId: "b0001" } });
  });

  it("서버가 거절할 값은 잘라 보내지 않고 이유를 돌려줌", () => {
    expect(
      inquiryServerQuery(
        {
          ...EMPTY_INQUIRY_FILTER,
          query: "가".repeat(INQUIRY_SEARCH_MAX + 1),
        },
        NOW,
      ),
    ).toEqual({ ok: false, invalid: "query" });
    // 이모지 하나는 코드 포인트 하나로 셈(서버와 같음)
    expect(
      inquiryServerQuery(
        { ...EMPTY_INQUIRY_FILTER, query: "🌊".repeat(INQUIRY_SEARCH_MAX) },
        NOW,
      ).ok,
    ).toBe(true);
    expect(
      inquiryServerQuery(
        {
          ...EMPTY_INQUIRY_FILTER,
          received: {
            preset: "custom",
            from: "2026-11-03T10:00",
            to: "2026-11-03T09:00",
          },
        },
        NOW,
      ),
    ).toEqual({ ok: false, invalid: "received" });
    // 서버는 4자리 연도만 받음(연도가 5자리 이상인 시각)
    expect(
      inquiryServerQuery(
        {
          ...EMPTY_INQUIRY_FILTER,
          received: { preset: "custom", from: "+020260-11-03T00:00:00Z" },
        },
        NOW,
      ),
    ).toEqual({ ok: false, invalid: "received" });
  });

  it("날짜만 입력한 끝은 그날 끝까지로 보고 같은 날 시작 시각보다 앞선다고 하지 않음", () => {
    const received = {
      preset: "custom",
      from: "2026-11-03T10:00",
      to: "2026-11-03",
    } as const;
    expect(isReceivedRangeInvalid(received)).toBe(false);
    expect(
      inquiryServerQuery({ ...EMPTY_INQUIRY_FILTER, received }, NOW),
    ).toEqual({
      ok: true,
      query: {
        from: "2026-11-03T01:00:00.000Z",
        to: "2026-11-03T14:59:59.999Z",
      },
    });
  });
});

describe("로컬 예시 문의 서버 필터 (#502)", () => {
  type Page = {
    items: {
      inquiryId: string;
      type: string;
      beachId?: string;
      messagePreview?: string;
      messagePreviewUnavailableReason?: string;
    }[];
    nextCursor: string | null;
    counts?: unknown;
  };
  const page = (query: string) => {
    const result = localOps<Page>(`/ops/inquiries?${query}`, "operator", {});
    if (!result.ok) throw new Error("로컬 문의 조회 실패");
    return result.body;
  };

  it("유형·해변 없음으로 거르고, 조건이 있으면 상태별 수를 주지 않음", () => {
    const typed = page("limit=50&type=data_error");
    expect(typed.items.length).toBeGreaterThan(0);
    expect(typed.items.every((i) => i.type === "data_error")).toBe(true);
    expect(typed.counts).toBeUndefined();
    const none = page("limit=50&beachId=__none__");
    expect(none.items.length).toBeGreaterThan(0);
    expect(none.items.every((i) => i.beachId === undefined)).toBe(true);
  });

  it("미리보기는 본문 앞부분이고, 본문이 비면 empty 사유", () => {
    const items = page("limit=50&preview=true").items;
    expect(items.some((i) => i.messagePreview?.startsWith("(로컬 예시"))).toBe(
      true,
    );
    expect(
      items.some((i) => i.messagePreviewUnavailableReason === "empty"),
    ).toBe(true);
    expect(
      items.every(
        (i) =>
          (i.messagePreview === undefined) !==
          (i.messagePreviewUnavailableReason === undefined),
      ),
    ).toBe(true);
    expect(page("limit=50").items.every((i) => !("messagePreview" in i))).toBe(
      true,
    );
  });

  it("본문 검색과 받은 시각 범위", () => {
    expect(
      page("limit=50&q=" + encodeURIComponent("김바다")).items.length,
    ).toBe(7);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(page(`limit=50&from=${future}`).items).toEqual([]);
  });
});
