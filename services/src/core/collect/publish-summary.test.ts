import { describe, expect, it } from "vitest";
import { PUBLISH_POLICY } from "../../publisher/policy";
import {
  PUBLISH_JOB_RUN_LIMIT_MS,
  PUBLISH_JOB_START_LIMIT_MS,
} from "./publish-job";
import { buildPublishSummary, noticeDigestOf } from "./publish-summary";

// 게시 요약의 '바뀐 것' 칸 (#331, 화면 ADM-PUB 게시 기록)

const NOTICE = {
  id: "n-aaaaaaaaaaaa",
  kind: "general",
  title: { ko: "공지", en: "Notice" },
  body: { ko: "본문", en: "Body" },
  startsAt: "2026-11-12T00:00:00Z",
  endsAt: null,
};

const base = {
  version: "20261112T060000Z",
  previous: null,
  publishedAt: "2026-11-12T06:00:00Z",
  beachCount: 3,
};

describe("buildPublishSummary", () => {
  it("분류별 해변 수를 publisher 분류 그대로 센다", () => {
    const summary = buildPublishSummary({
      ...base,
      status: {
        b1: { category: "clear", reasons: [] },
        b2: { category: "unavailable", reasons: [{ code: "warning" }] },
        b3: {
          category: "undetermined",
          reasons: [{ code: "observation_delayed" }],
        },
      },
    });
    expect(summary.categoryCounts).toEqual({
      clear: 1,
      unavailable: 1,
      undetermined: 1,
    });
    expect(summary.delayedBeachIds).toEqual(["b3"]);
  });

  it("모르는 분류가 섞이면 수를 남기지 않는다(틀린 수를 보이지 않게)", () => {
    const summary = buildPublishSummary({
      ...base,
      status: {
        b1: { category: "clear", reasons: [] },
        b2: { category: "safe", reasons: [] },
      },
    });
    expect(summary).not.toHaveProperty("categoryCounts");
  });

  it("공지를 주면 요약값을, 작업 ID를 주면 그대로 남기고 공지 문구는 남기지 않는다", () => {
    const summary = buildPublishSummary({
      ...base,
      status: {},
      notices: [NOTICE],
      jobId: "j-0123456789ab",
    });
    expect(summary.noticeDigest).toBe(noticeDigestOf([NOTICE]));
    expect(summary.jobId).toBe("j-0123456789ab");
    expect(JSON.stringify(summary)).not.toContain("본문");
  });
});

describe("noticeDigestOf", () => {
  it("칸 순서가 달라도 같은 공지면 같은 값, 내용이 다르면 다른 값", () => {
    const reordered = {
      endsAt: null,
      startsAt: NOTICE.startsAt,
      body: { en: "Body", ko: "본문" },
      title: { en: "Notice", ko: "공지" },
      kind: "general",
      id: NOTICE.id,
    };
    expect(noticeDigestOf([reordered])).toBe(noticeDigestOf([NOTICE]));
    expect(
      noticeDigestOf([{ ...NOTICE, body: { ko: "바뀐 본문", en: "Body" } }]),
    ).not.toBe(noticeDigestOf([NOTICE]));
    expect(noticeDigestOf([])).not.toBe(noticeDigestOf([NOTICE]));
    expect(noticeDigestOf([NOTICE])).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("게시 작업 시간 제한", () => {
  it("시작·실행 제한은 게시 잠금 TTL과 같다(D16-C4 '기존 게시 잠금 2분 TTL')", () => {
    expect(PUBLISH_JOB_START_LIMIT_MS).toBe(PUBLISH_POLICY.lockTtlMs);
    expect(PUBLISH_JOB_RUN_LIMIT_MS).toBe(PUBLISH_POLICY.lockTtlMs);
  });
});
