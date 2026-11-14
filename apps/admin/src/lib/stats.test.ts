import { describe, expect, it } from "vitest";
import { localStatsView } from "./auth/local-stats";
import {
  beachLabel,
  metadataReasons,
  perUser,
  sharePercent,
  sumMetric,
  validStats,
  statsShape,
  missingItems,
  changePercent,
  SHAPE_ALL,
  SHAPE_NONE,
} from "./stats";

// 응답에서 칸을 뺀 사본(이전 서버 응답처럼 칸이 없음)
const without = <T extends object>(value: T, ...keys: (keyof T)[]) => {
  const copy: Partial<T> = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
};

describe("이용 통계 계산 도우미 (#333)", () => {
  it("빈 값(null)과 합계 0은 0%로 추정하지 않고 null을 유지함", () => {
    expect(sharePercent(null, 100)).toBeNull();
    expect(sharePercent(10, null)).toBeNull();
    expect(sharePercent(10, 0)).toBeNull();
    expect(sharePercent(25, 100)).toBe(25);
    expect(sumMetric([])).toBeNull();
    expect(sumMetric([null, null])).toBeNull();
    expect(sumMetric([10, null, 20])).toBeNull();
    expect(sumMetric([10, 20])).toBe(30);
  });

  it("GA4 metadata 제한 플래그는 true인 항목만 반환함(E8)", () => {
    expect(
      metadataReasons({
        thresholding: false,
        sampling: false,
        otherRowLoss: false,
      }),
    ).toEqual([]);
    expect(
      metadataReasons({
        thresholding: true,
        sampling: false,
        otherRowLoss: true,
      }),
    ).toEqual(["thresholding", "otherRowLoss"]);
  });

  it("해변 slug로 이름·지역을 찾고, 못 찾으면 slug·경로가 아니라 이름 없음(null)", () => {
    const bySlug = {
      haeundae: {
        id: "b0091",
        name: "해운대해수욕장",
        region: "부산 해운대구",
        hidden: false,
      },
    };
    expect(
      beachLabel(
        { path: "/spots/haeundae", slug: "haeundae", pageViews: 10 },
        bySlug,
      ),
    ).toEqual({ name: "해운대해수욕장", region: "부산 해운대구" });
    // 이름표에 없는 slug: slug를 이름처럼 쓰지 않음
    expect(
      beachLabel(
        { path: "/spots/gwangalli", slug: "gwangalli", pageViews: 3 },
        bySlug,
      ),
    ).toEqual({ name: null, region: null });
    // slug를 못 읽은 경로
    expect(
      beachLabel({ path: "/spots/", slug: null, pageViews: 3 }, bySlug),
    ).toEqual({ name: null, region: null });
    // 객체 기본 속성 이름은 이름표가 아님
    expect(
      beachLabel(
        { path: "/spots/constructor", slug: "constructor", pageViews: 1 },
        bySlug,
      ),
    ).toEqual({ name: null, region: null });
  });

  it("사용자당 화면은 받은 두 값으로만 계산하고, 하나라도 없거나 사용자 0이면 null", () => {
    expect(perUser(22580, 4910)).toBe(4.6);
    expect(perUser(null, 4910)).toBeNull();
    expect(perUser(100, null)).toBeNull();
    expect(perUser(100, 0)).toBeNull();
  });

  it("응답 모양 검사: 정상 응답과 세부 리포트 null은 통과, 칸이 빠지거나 숫자가 아니면 실패", () => {
    const good = localStatsView("28d", Date.parse("2026-11-13T05:00:00Z"));
    expect(validStats(good)).toBe(true);
    expect(
      validStats({ ...good, period: { ...good.period, topBeaches: null } }),
    ).toBe(true);
    expect(validStats(null)).toBe(false);
    expect(validStats({ ...good, realtime: undefined })).toBe(false);
    expect(
      validStats({
        ...good,
        period: { ...good.period, activeUsers: "180" },
      }),
    ).toBe(false);
    expect(
      validStats({
        ...good,
        period: {
          ...good.period,
          devices: [{ category: "mobile", activeUsers: "1" }],
        },
      }),
    ).toBe(false);
    expect(
      validStats({ ...good, period: { ...good.period, metadata: {} } }),
    ).toBe(false);
    expect(validStats({ ...good, range: "90d" })).toBe(false);
  });

  it("기간 추이(trends) 모양: 없음·목록 null·행 수치 null은 통과, 모양이 틀리면 실패", () => {
    const good = localStatsView("28d", Date.parse("2026-11-13T05:00:00Z"));
    const trends = good.trends!;
    const withTrends = (extra: Record<string, unknown>) =>
      validStats({ ...good, trends: { ...trends, ...extra } });
    // trends 자체가 없음(이전 서버·GA4 미연결)
    expect(validStats(without(good, "trends"))).toBe(true);
    // 목록 칸이 응답에 없음(undefined)·null(리포트 못 받음)
    expect(
      validStats({ ...good, trends: without(trends, "topScreens", "referrers") }),
    ).toBe(true);
    expect(
      withTrends({
        daily: null,
        hourly: null,
        previous: null,
        topScreens: null,
        referrers: null,
        newUsers: null,
        newUsersMetadata: null,
        ga4TimeZone: null,
        timeZoneMismatch: null,
      }),
    ).toBe(true);
    // 행 안의 수치 null
    expect(
      withTrends({
        daily: {
          rows: [{ date: "2026-11-13", activeUsers: null, pageViews: null }],
          metadata: trends.daily!.metadata,
        },
        hourly: {
          rows: [{ hour: 3, averageActiveUsers: null, reportedDays: 27 }],
          metadata: trends.hourly!.metadata,
        },
      }),
    ).toBe(true);
    // 모양이 틀림: 배열로 옴(예전 가정)·날짜 형식·시각 범위·other 없음·metadata 없음
    expect(
      withTrends({
        daily: [{ date: "2026-11-13", activeUsers: 1, pageViews: 1 }],
      }),
    ).toBe(false);
    expect(
      withTrends({
        daily: {
          rows: [{ date: "11/13", activeUsers: 1, pageViews: 1 }],
          metadata: trends.daily!.metadata,
        },
      }),
    ).toBe(false);
    expect(
      withTrends({
        hourly: {
          rows: [{ hour: 24, averageActiveUsers: 1, reportedDays: 1 }],
          metadata: trends.hourly!.metadata,
        },
      }),
    ).toBe(false);
    expect(
      withTrends({
        topScreens: { rows: [{ path: "/", pageViews: 1 }], metadata: trends.topScreens!.metadata },
      }),
    ).toBe(false);
    expect(withTrends({ referrers: { rows: [] } })).toBe(false);
    expect(withTrends({ newUsers: "12" })).toBe(false);
    expect(withTrends({ startDate: "2026/11/13" })).toBe(false);
    expect(
      withTrends({ previous: { activeUsers: 1, pageViews: 1 } }),
    ).toBe(false);
  });
});

describe("응답 칸 유무와 '아직 보여 드릴 수 없어요' 줄", () => {
  const good = localStatsView("28d", Date.parse("2026-11-13T05:00:00Z"));

  it("trends가 없으면 추이 칸 모두 숨김 → 네 항목 모두 줄에", () => {
    expect(statsShape(undefined)).toEqual(SHAPE_NONE);
    expect(statsShape(null)).toEqual(SHAPE_NONE);
    expect(missingItems(SHAPE_NONE)).toEqual([
      "dailyHourly",
      "previous",
      "topScreens",
      "referrers",
    ]);
    // 지금 서버 모양(목록 모두 있음)은 줄 없음, 첫 응답 전 자리표시도 같은 칸
    expect(statsShape(good.trends)).toEqual(SHAPE_ALL);
    expect(missingItems(SHAPE_ALL)).toEqual([]);
  });

  it("목록이 null이어도 칸은 있음(줄에서 빠짐), 응답에 없는 목록만 줄에", () => {
    const rest = without(good.trends!, "hourly", "previous", "topScreens");
    const shape = statsShape({
      ...(rest as typeof good.trends & object),
      daily: null,
      referrers: null,
    });
    expect(shape.daily).toBe(true);
    expect(shape.referrers).toBe(true);
    expect(missingItems(shape)).toEqual(["hourly", "previous", "topScreens"]);
    expect(missingItems({ ...SHAPE_NONE, hourly: true })).toEqual([
      "daily",
      "previous",
      "topScreens",
      "referrers",
    ]);
  });

  it("앞 기간 대비 변화: 두 값이 있고 앞 기간이 0보다 클 때만(앞 기간 null·0이면 배지 없음)", () => {
    expect(changePercent(118, 100)).toBe(18);
    expect(changePercent(4910, 4147)).toBe(18.4);
    expect(changePercent(90, 100)).toBe(-10);
    expect(changePercent(null, 100)).toBeNull();
    expect(changePercent(10, null)).toBeNull();
    expect(changePercent(10, 0)).toBeNull();
    // 오늘 범위: 서버가 previous를 null로 줌
    expect(localStatsView("today").trends!.previous).toBeNull();
  });
});
