import { describe, expect, it } from "vitest";
import { NOTICE_PK } from "./keys";
import {
  exposeProblem,
  graphemeLength,
  liveNotices,
  noticeState,
  noticeViews,
  parseNoticeInput,
  parseVersionBody,
  queryNotices,
  type NoticeContent,
  type NoticeRecord,
} from "./notices";

// 공지 저장 모양·노출 검사·목록 상태 (BRD-151, D16-B3·D2·D3·D4)

const NOW = new Date("2026-11-03T06:00:00Z");

const CONTENT: NoticeContent = {
  kind: "general",
  title: { ko: "데이터 점검", en: "Data check" },
  body: { ko: "잠시 늦을 수 있어요", en: "Updates may be late" },
  startsAt: "2026-11-03T05:00:00Z",
  endsAt: "2026-11-03T08:00:00Z",
};

function record(
  id: string,
  overrides: Partial<NoticeRecord> = {},
  live: NoticeContent | null = CONTENT,
): NoticeRecord {
  return {
    id,
    version: 2,
    draft: live ?? CONTENT,
    live,
    exposedAt: live ? "2026-11-03T04:00:00Z" : null,
    updatedAt: "2026-11-03T04:00:00Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("parseNoticeInput", () => {
  it("만들기는 version 없이, 고치기는 version과 함께 받는다", () => {
    expect(parseNoticeInput(CONTENT, "create")).toMatchObject({
      ok: true,
      version: 0,
      content: CONTENT,
    });
    expect(
      parseNoticeInput({ ...CONTENT, version: 3 }, "update"),
    ).toMatchObject({ ok: true, version: 3 });
    expect(parseNoticeInput(CONTENT, "update")).toEqual({
      ok: false,
      field: "version",
    });
    expect(parseNoticeInput({ ...CONTENT, version: 3 }, "create")).toEqual({
      ok: false,
      field: "body",
    });
  });

  it("초안은 한·영 빈칸을 허용한다(노출 때 다시 확인)", () => {
    expect(
      parseNoticeInput(
        { ...CONTENT, title: { ko: "제목만", en: "" } },
        "create",
      ),
    ).toMatchObject({ ok: true });
  });

  it("UTC(Z)가 아닌 시각·모르는 종류·모르는 칸은 받지 않는다", () => {
    expect(
      parseNoticeInput(
        { ...CONTENT, startsAt: "2026-11-03T14:00:00+09:00" },
        "create",
      ),
    ).toEqual({ ok: false, field: "startsAt" });
    expect(
      parseNoticeInput({ ...CONTENT, endsAt: "2026-11-03T14:00:00" }, "create"),
    ).toEqual({ ok: false, field: "endsAt" });
    expect(parseNoticeInput({ ...CONTENT, kind: "urgent" }, "create")).toEqual({
      ok: false,
      field: "kind",
    });
    expect(parseNoticeInput({ ...CONTENT, status: "live" }, "create")).toEqual({
      ok: false,
      field: "body",
    });
    expect(
      parseNoticeInput(
        { ...CONTENT, title: { ko: "제목", en: "t", ja: "x" } },
        "create",
      ),
    ).toEqual({ ok: false, field: "title" });
  });

  it("끝 시각 없음(null)을 받는다", () => {
    expect(
      parseNoticeInput({ ...CONTENT, endsAt: null }, "create"),
    ).toMatchObject({ ok: true, content: { endsAt: null } });
  });

  it("노출·끝내기·지우기 본문은 version만", () => {
    expect(parseVersionBody({ version: 1 })).toEqual({ ok: true, version: 1 });
    expect(parseVersionBody({ version: 0 })).toMatchObject({ ok: false });
    expect(parseVersionBody({ version: 1, force: true })).toMatchObject({
      ok: false,
    });
  });
});

describe("exposeProblem (D16-D1·D2)", () => {
  it("차단 표현이 있는 칸은 노출하지 않고, 경고·허용 표현은 막지 않는다", () => {
    expect(
      exposeProblem(
        { ...CONTENT, title: { ko: "데이터 점검", en: "Top 3 beaches" } },
        NOW,
      ),
    ).toEqual({ field: "title.en", reason: "blocked_phrase" });
    expect(
      exposeProblem(
        { ...CONTENT, body: { ko: "추천 해변 안내", en: "Updates" } },
        NOW,
      ),
    ).toEqual({ field: "body.ko", reason: "blocked_phrase" });
    expect(
      exposeProblem(
        {
          ...CONTENT,
          title: { ko: "02:00 점검", en: "Calm notice" },
          body: { ko: "안전요원 안내를 따라 주세요", en: "Ask a lifeguard" },
        },
        NOW,
      ),
    ).toBeNull();
  });

  it("한·영 중 하나라도 비면 노출하지 않는다", () => {
    expect(
      exposeProblem({ ...CONTENT, body: { ko: "본문", en: "  " } }, NOW),
    ).toEqual({ field: "body.en", reason: "required" });
  });

  it("글자 수는 grapheme으로 세고, 넘으면 잘라 내지 않고 막는다", () => {
    expect(graphemeLength("👨‍👩‍👧")).toBe(1);
    expect(
      exposeProblem(
        { ...CONTENT, title: { ko: "가".repeat(40), en: "t" } },
        NOW,
      ),
    ).toBeNull();
    expect(
      exposeProblem(
        { ...CONTENT, title: { ko: "가".repeat(41), en: "t" } },
        NOW,
      ),
    ).toEqual({ field: "title.ko", reason: "too_long" });
    expect(
      exposeProblem(
        { ...CONTENT, body: { ko: "본문", en: "a".repeat(201) } },
        NOW,
      ),
    ).toEqual({ field: "body.en", reason: "too_long" });
  });

  it("끝이 시작보다 이르거나 이미 지났으면 막는다", () => {
    expect(
      exposeProblem({ ...CONTENT, endsAt: CONTENT.startsAt }, NOW),
    ).toEqual({ field: "endsAt", reason: "order" });
    expect(
      exposeProblem({ ...CONTENT, endsAt: "2026-11-03T05:30:00Z" }, NOW),
    ).toEqual({ field: "endsAt", reason: "order" });
    expect(exposeProblem({ ...CONTENT, endsAt: null }, NOW)).toBeNull();
  });
});

describe("noticeState", () => {
  it("노출본 없음 → 대기, 시작 포함·끝 제외", () => {
    expect(noticeState(record("a", {}, null), NOW)).toBe("draft");
    const at = (iso: string) => new Date(iso);
    const r = record("a");
    expect(noticeState(r, at("2026-11-03T04:59:59Z"))).toBe("scheduled");
    expect(noticeState(r, at("2026-11-03T05:00:00Z"))).toBe("live");
    expect(noticeState(r, at("2026-11-03T07:59:59Z"))).toBe("live");
    expect(noticeState(r, at("2026-11-03T08:00:00Z"))).toBe("ended");
  });
});

describe("noticeViews (D16-D4)", () => {
  it("한 자리 규칙에서 밀린 노출 중 공지는 '가려짐', 지운 공지는 목록에 없다", () => {
    const maint = { ...CONTENT, kind: "maintenance_notice" as const };
    const views = noticeViews(
      [
        record("b-general"),
        record("a-maint", {}, maint),
        record(
          "c-maint-later",
          {},
          { ...maint, startsAt: "2026-11-03T05:30:00Z" },
        ),
        record("d-deleted", { deletedAt: "2026-11-03T05:00:00Z" }),
      ],
      NOW,
    );
    expect(views.map((v) => [v.id, v.state, v.hidden])).toEqual([
      ["c-maint-later", "live", false],
      ["a-maint", "live", true],
      ["b-general", "live", true],
    ]);
    expect(views[0]).not.toHaveProperty("deletedAt");
  });

  it("저장한 문구가 노출본과 다르면 '수정 대기'", () => {
    const [view] = noticeViews(
      [
        record("a", {
          draft: { ...CONTENT, title: { ko: "새 제목", en: "New" } },
        }),
      ],
      NOW,
    );
    expect(view).toMatchObject({ state: "live", pendingEdit: true });
    expect(noticeViews([record("b", {}, null)], NOW)[0]).toMatchObject({
      state: "draft",
      pendingEdit: false,
    });
  });
});

describe("liveNotices", () => {
  it("지우지 않았고 노출본이 있는 공지만 노출본 문구로 돌려준다", () => {
    expect(
      liveNotices([
        record("a", {
          draft: { ...CONTENT, title: { ko: "초안", en: "Draft" } },
        }),
        record("b", {}, null),
        record("c", { deletedAt: "2026-11-03T05:00:00Z" }),
      ]),
    ).toEqual([{ id: "a", ...CONTENT }]);
  });
});

describe("queryNotices", () => {
  const client = (items: Record<string, unknown>[]) => ({
    send: async () => ({ Items: items }),
  });
  const good = {
    pk: NOTICE_PK,
    sk: "n-good",
    id: "n-good",
    version: 1,
    draft: CONTENT,
    live: CONTENT,
    exposedAt: null,
    updatedAt: "2026-11-03T04:00:00Z",
    deletedAt: null,
  };
  const broken = {
    ...good,
    sk: "n-broken",
    id: "n-broken",
    live: { kind: "x" },
  };

  it("모양이 틀린 항목이 있으면 던진다(목록에서 숨기지 않음)", async () => {
    await expect(queryNotices(client([good, broken]), "Ops")).rejects.toThrow();
  });

  it("onInvalid를 주면 그 항목만 빼고 알린다(publisher)", async () => {
    const invalid: string[] = [];
    const records = await queryNotices(client([good, broken]), "Ops", (sk) =>
      invalid.push(sk),
    );
    expect(records.map((r) => r.id)).toEqual(["n-good"]);
    expect(invalid).toEqual(["n-broken"]);
  });
});
