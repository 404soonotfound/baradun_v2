import { graphemeLength } from "@baradun/contracts/notice-rules";
import { describe, expect, it } from "vitest";
import {
  exposeProblems,
  filterNotices,
  fromKstInput,
  sameContent,
  saveProblems,
  textChecks,
  toKstInput,
  type NoticeContent,
  type NoticeView,
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

  it("차단 표현은 확정을 막고 칸·맞은 문구·묶음을 알려 준다(D17-8)", () => {
    expect(
      exposeProblems(
        content({ body: { ko: "추천 해변 TOP 3", en: "Body" } }),
        NOW,
      ),
    ).toEqual([
      {
        field: "body.ko",
        reason: "blocked_phrase",
        text: "추천 해변",
        category: "recommend",
      },
      {
        field: "body.ko",
        reason: "blocked_phrase",
        text: "TOP 3",
        category: "score",
      },
    ]);
    // 글자 수 넘침과 차단 표현은 함께 알림
    expect(
      exposeProblems(
        content({ title: { ko: `${"가".repeat(40)} 안전해요`, en: "T" } }),
        NOW,
      ).map((p) => p.reason),
    ).toEqual(["too_long", "blocked_phrase"]);
  });

  it("문구 확인은 시각 없이도 빈칸·차단 표현을 알려 준다", () => {
    expect(
      textChecks({
        title: { ko: "추천 해변", en: "" },
        body: { ko: "본문", en: "Body" },
      }).problems,
    ).toEqual([
      {
        field: "title.ko",
        reason: "blocked_phrase",
        text: "추천 해변",
        category: "recommend",
      },
      { field: "title.en", reason: "required" },
    ]);
  });

  it("문맥 확인 표현은 경고만 하고, 허용 표현은 경고하지 않는다", () => {
    const calm = content({
      title: { ko: "파도가 잔잔해요", en: "Calm sea" },
      body: { ko: "안전요원 안내를 따라 주세요", en: "Ask a lifeguard" },
    });
    expect(exposeProblems(calm, NOW)).toEqual([]);
    expect(textChecks(calm).warnings).toEqual([
      { field: "title.ko", text: "잔잔해요" },
      { field: "title.en", text: "Calm" },
    ]);
  });

  it("같은 시각을 다르게 쓴 값도 같은 문구로 본다", () => {
    expect(
      sameContent(content(), content({ startsAt: "2030-01-01T00:00:00Z" })),
    ).toBe(true);
    expect(sameContent(content(), content({ endsAt: null }))).toBe(false);
  });
});

const view = (
  id: string,
  state: NoticeView["state"],
  overrides: Partial<NoticeContent> = {},
): NoticeView => {
  const c = content(overrides);
  return {
    id,
    version: 1,
    draft: c,
    live: state === "draft" ? null : c,
    exposedAt: null,
    updatedAt: "2030-01-01T00:00:00.000Z",
    state,
    pendingEdit: false,
    hidden: false,
  };
};

describe("공지 목록 거르기", () => {
  const items: NoticeView[] = [
    view("1", "live", {
      kind: "maintenance_notice",
      title: { ko: "새벽 점검 예고", en: "Maintenance" },
      body: { ko: "새벽 2시 점검", en: "At 2am" },
    }),
    view("2", "draft", {
      kind: "general",
      title: { ko: "해변 추가", en: "More beaches" },
      body: { ko: "출처 안내가 바뀌었어요", en: "Updated sources" },
    }),
  ];

  it("상태·종류·제목/문구 검색어로 거른다", () => {
    expect(
      filterNotices(items, { state: "live", kind: null, query: "" }).map(
        (n) => n.id,
      ),
    ).toEqual(["1"]);
    expect(
      filterNotices(items, { state: null, kind: "general", query: "" }).map(
        (n) => n.id,
      ),
    ).toEqual(["2"]);
    expect(
      filterNotices(items, { state: null, kind: null, query: "출처" }).map(
        (n) => n.id,
      ),
    ).toEqual(["2"]);
    expect(
      filterNotices(items, {
        state: null,
        kind: null,
        query: "MAINTENANCE",
      }).map((n) => n.id),
    ).toEqual(["1"]);
  });
});
