import { describe, expect, it } from "vitest";
import {
  exposeProblems,
  fromKstInput,
  graphemeLength,
  sameContent,
  saveProblems,
  toKstInput,
  type NoticeContent,
} from "./notices";

const content = (overrides: Partial<NoticeContent> = {}): NoticeContent => ({
  kind: "general",
  title: { ko: "제목", en: "Title" },
  body: { ko: "내용", en: "Body" },
  startsAt: "2030-01-01T00:00:00.000Z",
  endsAt: "2030-01-02T00:00:00.000Z",
  ...overrides,
});
const NOW = Date.parse("2029-12-31T00:00:00Z");

describe("공지 시각(KST 입력 ↔ UTC 저장)", () => {
  it("KST 벽시계로 보여 주고 UTC로 되돌린다", () => {
    expect(toKstInput("2030-01-01T15:30:00Z")).toBe("2030-01-02T00:30");
    expect(fromKstInput("2030-01-02T00:30")).toBe("2030-01-01T15:30:00.000Z");
  });

  it("틀린 값은 null", () => {
    expect(fromKstInput("")).toBeNull();
    expect(fromKstInput("2030-13-40T99:99")).toBeNull();
  });
});

describe("저장·확정 전 확인", () => {
  it("저장은 시각이 틀리거나 기간이 거꾸로일 때만 막는다", () => {
    expect(saveProblems("2030-01-01T00:00:00.000Z", null)).toEqual([]);
    expect(saveProblems(null, null)).toEqual([
      { field: "startsAt", reason: "invalid" },
    ]);
    expect(
      saveProblems("2030-01-02T00:00:00.000Z", "2030-01-01T00:00:00.000Z"),
    ).toEqual([{ field: "endsAt", reason: "order" }]);
  });

  it("확정은 한·영 빈칸·글자 수(grapheme)·끝 시각을 본다", () => {
    expect(exposeProblems(content(), NOW)).toEqual([]);
    expect(
      exposeProblems(content({ title: { ko: "제목", en: " " } }), NOW),
    ).toEqual([{ field: "title.en", reason: "required" }]);
    expect(
      exposeProblems(content({ title: { ko: "가".repeat(41), en: "T" } }), NOW),
    ).toEqual([{ field: "title.ko", reason: "too_long" }]);
    // 이모지 하나(여러 code point)는 한 글자
    expect(graphemeLength("👨‍👩‍👧")).toBe(1);
    expect(
      exposeProblems(content(), Date.parse("2030-01-03T00:00:00Z")),
    ).toEqual([{ field: "endsAt", reason: "order" }]);
  });

  it("같은 시각을 다르게 쓴 값도 같은 문구로 본다", () => {
    expect(
      sameContent(content(), content({ startsAt: "2030-01-01T00:00:00Z" })),
    ).toBe(true);
    expect(sameContent(content(), content({ endsAt: null }))).toBe(false);
  });
});
