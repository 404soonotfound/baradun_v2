import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBeachNames } from "./beach-names";
import {
  BEACH_NONE,
  EMPTY_INQUIRY_FILTER,
  filterInquiries,
  hasActiveInquiryFilter,
  INQUIRY_PAGE_MAX,
  isKstToday,
  isReceivedRangeInvalid,
  kstDateTime,
  linesNormalized,
  PAGE_SIZE,
  previewText,
  redactionOf,
  retentionDate,
  shortId,
  type InquirySummary,
} from "./inquiries";
import { pageRows, pageWindow } from "./paging";

// 운영자 문의 화면 도우미 (BRD-153)

describe("시각 표시", () => {
  it("UTC로 저장된 시각을 KST 월/일 시:분으로 보여 준다", () => {
    expect(kstDateTime("2026-11-02T04:12:00Z")).toBe("11/2 13:12");
    // UTC 날짜가 하루 앞서도 KST 날짜로
    expect(kstDateTime("2026-11-02T16:05:00Z")).toBe("11/3 01:05");
  });

  it("보관 기한은 받은 시각 + 90일의 KST 날짜", () => {
    expect(retentionDate("2026-11-02T04:12:00Z")).toBe("1/31");
  });

  it("접수 ID는 앞 4·뒤 2자로 줄인다", () => {
    expect(shortId("3f2a0000-0000-4000-8000-00000000009c")).toBe("3f2a…9c");
  });
});

describe("해변 이름표", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const write = (file: string, value: unknown) =>
    writeFileSync(path.join(dir, file), JSON.stringify(value));

  it("이름·지역·비노출 여부만 꺼낸다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "beaches-"));
    write("b0001.json", {
      id: "b0001",
      name: { ko: "강문해수욕장", en: "Gangmun" },
      region: { sido: { ko: "강원" }, sigungu: { ko: "강릉시" } },
      hidden: false,
    });
    write("b0002.json", {
      id: "b0002",
      name: { ko: "숨은해변" },
      region: { sido: { ko: "강원" }, sigungu: { ko: "양양군" } },
      hidden: true,
    });
    write("README.md", "x");
    expect(loadBeachNames(dir)).toEqual({
      b0001: { name: "강문해수욕장", region: "강원 강릉시", hidden: false },
      b0002: { name: "숨은해변", region: "강원 양양군", hidden: true },
    });
  });

  it("모양이 틀린 파일은 조용히 빼지 않고 멈춘다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "beaches-"));
    write("b0001.json", { id: "b0001", name: {} });
    expect(() => loadBeachNames(dir)).toThrow("b0001.json");
  });

  it("해변 관리 정적 페이지와 같은 규칙: b+숫자 4자리 파일만 읽고, 파일 이름과 ID가 다르면 멈춘다", () => {
    dir = mkdtempSync(path.join(tmpdir(), "beaches-"));
    const beach = (id: string) => ({
      id,
      name: { ko: "강문해수욕장" },
      region: { sido: { ko: "강원" }, sigungu: { ko: "강릉시" } },
    });
    write("b0001.json", beach("b0001"));
    write("b10000.json", beach("b10000"));
    expect(Object.keys(loadBeachNames(dir))).toEqual(["b0001"]);
    write("b0005.json", beach("b0500"));
    expect(() => loadBeachNames(dir)).toThrow("b0005.json");
  });

  it("저장소의 실제 해변 데이터를 모두 읽는다", () => {
    const names = loadBeachNames(
      path.join(__dirname, "../../../../data/beaches"),
    );
    expect(Object.keys(names).length).toBeGreaterThan(100);
    expect(names.b0001?.name).toBe("강문해수욕장");
  });
});

describe("개인정보 가리기 범위", () => {
  it("화면(줄바꿈 \\n)에서 고른 위치를 원래 본문(\\r\\n) 위치로 되돌린다", () => {
    const message = "첫 줄\r\n이름 김바다\r\n끝";
    const shown = linesNormalized(message);
    const at = shown.indexOf("김바다");
    expect(redactionOf(message, at, at + 3)).toEqual({
      start: message.indexOf("김바다"),
      end: message.indexOf("김바다") + 3,
      text: "김바다",
    });
  });

  it("앞뒤 공백은 빼고, 공백만 고르면 없음", () => {
    expect(redactionOf("a 010 b", 1, 6)).toEqual({
      start: 2,
      end: 5,
      text: "010",
    });
    expect(redactionOf("a   b", 1, 4)).toBeNull();
    expect(redactionOf("abc", 2, 2)).toBeNull();
  });
});

describe("내용 미리보기 자르기", () => {
  it("줄바꿈과 연속 공백을 한 칸으로 줄이고 빈 값은 null을 돌려준다", () => {
    expect(previewText(undefined)).toBeNull();
    expect(previewText("  \n\t  ")).toBeNull();
    expect(previewText("첫 줄\r\n둘째   줄\n셋째 줄")).toBe(
      "첫 줄 둘째 줄 셋째 줄",
    );
  });

  it("지정한 글자 수를 넘으면 코드 포인트 단위로 자르고 말줄임을 붙인다", () => {
    expect(previewText("가나다라마바사", 7)).toBe("가나다라마바사");
    expect(previewText("가나다라마바사아자차", 5)).toBe("가나다라마…");
    // 서로게이트 쌍(이모지)을 중간에서 자르지 않음
    expect(previewText("🌊🌊🌊🌊🌊🌊", 4)).toBe("🌊🌊🌊🌊…");
  });
});

describe("문의 거르기와 페이징", () => {
  const sample = (
    n: number,
    overrides: Partial<Omit<InquirySummary, "beachId" | "activity">> & {
      beachId?: string | undefined;
      activity?: string | undefined;
    } = {},
  ): InquirySummary => {
    const rest: Partial<Omit<InquirySummary, "beachId" | "activity">> =
      Object.fromEntries(
        Object.entries(overrides).filter(
          ([k]) => k !== "beachId" && k !== "activity",
        ),
      );
    const beachId = "beachId" in overrides ? overrides.beachId : "b0001";
    const activity = "activity" in overrides ? overrides.activity : "swimming";
    return {
      inquiryId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      type: "data_error",
      ...(beachId !== undefined ? { beachId } : {}),
      ...(activity !== undefined ? { activity } : {}),
      receivedAt: "2026-11-02T04:12:00Z", // KST 2026-11-02 13:12
      status: "received",
      version: 1,
      legacy: false,
      ...rest,
    };
  };

  const rows: InquirySummary[] = [
    sample(1),
    sample(2, {
      type: "beach_request",
      beachId: undefined,
      activity: undefined,
      receivedAt: "2026-11-01T09:40:00Z", // KST 2026-11-01 18:40
    }),
    sample(3, {
      type: "data_question",
      beachId: "b0002",
      activity: "surfing",
      receivedAt: "2026-10-20T01:00:00Z", // KST 2026-10-20 10:00
    }),
  ];

  const opts = {
    beachName: (id: string) =>
      id === "b0001" ? "강문해수욕장" : id === "b0002" ? "경포해변" : id,
    typeLabel: (type: string) =>
      type === "data_error"
        ? "정보가 실제와 달라요"
        : type === "beach_request"
          ? "해변을 추가해 주세요"
          : "판단 기준이 궁금해요",
    activityLabel: (a: string) => (a === "swimming" ? "수영" : "서핑"),
    messages: {
      [rows[0]!.inquiryId]: "현장에 입수 금지 깃발이 걸려 있어요.",
    },
    now: new Date("2026-11-02T06:00:00Z"), // KST 2026-11-02 15:00
  };

  it("유형·해변·받은 시각·검색어 조합으로 거른다", () => {
    expect(hasActiveInquiryFilter(EMPTY_INQUIRY_FILTER)).toBe(false);
    expect(filterInquiries(rows, EMPTY_INQUIRY_FILTER, opts)).toHaveLength(3);

    expect(
      filterInquiries(rows, { ...EMPTY_INQUIRY_FILTER, type: "data_error" }, opts),
    ).toEqual([rows[0]]);

    expect(
      filterInquiries(rows, { ...EMPTY_INQUIRY_FILTER, beach: BEACH_NONE }, opts),
    ).toEqual([rows[1]]);

    expect(
      filterInquiries(
        rows,
        { ...EMPTY_INQUIRY_FILTER, received: { preset: "today" } },
        opts,
      ),
    ).toEqual([rows[0]]);

    expect(
      filterInquiries(
        rows,
        { ...EMPTY_INQUIRY_FILTER, received: { preset: "7d" } },
        opts,
      ),
    ).toEqual([rows[0], rows[1]]);

    expect(
      filterInquiries(
        rows,
        {
          ...EMPTY_INQUIRY_FILTER,
          received: {
            preset: "custom",
            from: "2026-11-02T13:00",
            to: "2026-11-02T13:30",
          },
        },
        opts,
      ),
    ).toEqual([rows[0]]);

    expect(
      filterInquiries(rows, { ...EMPTY_INQUIRY_FILTER, query: "입수 금지" }, opts),
    ).toEqual([rows[0]]);

    expect(
      filterInquiries(
        rows,
        { ...EMPTY_INQUIRY_FILTER, query: "경포", type: "data_question" },
        opts,
      ),
    ).toEqual([rows[2]]);
  });

  it("KST 오늘 여부와 시안 V20 기준 6행 페이징을 계산한다", () => {
    expect(
      isKstToday("2026-11-02T04:12:00Z", new Date("2026-11-02T14:59:00Z")),
    ).toBe(true);
    expect(
      isKstToday("2026-11-01T14:59:00Z", new Date("2026-11-02T06:00:00Z")),
    ).toBe(false);
    expect(PAGE_SIZE).toBe(6);
    expect(INQUIRY_PAGE_MAX).toBe(50);

    const eleven = Array.from({ length: 11 }, (_, i) => sample(i + 1));
    expect(pageWindow(eleven.length, 0, PAGE_SIZE)).toEqual({
      page: 0,
      pages: 2,
      from: 1,
      to: 6,
      atStart: true,
      atEnd: false,
    });
    expect(pageRows(eleven, 0, PAGE_SIZE)).toHaveLength(6);
    expect(pageRows(eleven, 1, PAGE_SIZE)).toHaveLength(5);
  });

  it("직접 입력 받은 시각이 비어 있으면 거르지 않고, 시작이 끝보다 늦으면 오류로 판정한다", () => {
    const emptyCustom = {
      ...EMPTY_INQUIRY_FILTER,
      received: { preset: "custom" as const, from: "", to: "   " },
    };
    expect(hasActiveInquiryFilter(emptyCustom)).toBe(false);
    expect(filterInquiries(rows, emptyCustom, opts)).toEqual(rows);
    expect(isReceivedRangeInvalid(emptyCustom.received)).toBe(false);

    expect(
      isReceivedRangeInvalid({
        preset: "custom",
        from: "2026-11-02T14:00",
        to: "2026-11-02T13:00",
      }),
    ).toBe(true);
    expect(
      isReceivedRangeInvalid({
        preset: "custom",
        from: "2026-11-02T13:00",
        to: "2026-11-02T14:00",
      }),
    ).toBe(false);
    expect(
      isReceivedRangeInvalid({
        preset: "custom",
        from: "2026-11-02T13:00",
        to: "",
      }),
    ).toBe(false);
  });
});
