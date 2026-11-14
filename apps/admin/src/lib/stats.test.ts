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
  channelName,
  roundAverage,
  screenLabel,
  SCREEN_PATHS,
  SHAPE_ALL,
  SHAPE_NONE,
  trendMetadata,
  trendRangeText,
  trendUnavailable,
} from "./stats";
import { messages } from "./messages";

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

describe("숫자 숨김 안내 사유 합치기", () => {
  const good = localStatsView("28d", Date.parse("2026-11-13T05:00:00Z"));
  const off = { thresholding: false, sampling: false, otherRowLoss: false };

  it("기간 통계와 추이 목록 metadata 중 하나라도 있으면 그 사유", () => {
    expect(trendMetadata(good.period, good.trends)).toEqual(off);
    expect(
      trendMetadata(good.period, {
        ...good.trends!,
        topScreens: { rows: [], metadata: { ...off, otherRowLoss: true } },
        hourly: { rows: [], metadata: { ...off, sampling: true } },
      }),
    ).toEqual({ thresholding: false, sampling: true, otherRowLoss: true });
    expect(
      trendMetadata(null, {
        ...good.trends!,
        newUsersMetadata: { ...off, thresholding: true },
      }).thresholding,
    ).toBe(true);
    // 목록 null(못 받음)은 사유에 넣지 않음
    expect(
      trendMetadata(good.period, { ...good.trends!, daily: null, referrers: null }),
    ).toEqual(off);
  });
});

describe("많이 본 화면 경로 → 이름", () => {
  const bySlug = {
    haeundae: {
      id: "b0091",
      name: "해운대해수욕장",
      region: "부산 해운대구",
      hidden: false,
    },
  };
  const label = (path: string, other = false) =>
    screenLabel({ path, other }, bySlug);

  it("/spots/<slug>는 해변 이름, 못 찾으면 이름 없음(slug를 이름처럼 쓰지 않음)", () => {
    expect(label("/spots/haeundae/")).toEqual({
      kind: "beach",
      name: "해운대해수욕장",
      english: false,
    });
    expect(label("/spots/haeundae")).toEqual({
      kind: "beach",
      name: "해운대해수욕장",
      english: false,
    });
    expect(label("/en/spots/haeundae/?from=share")).toEqual({
      kind: "beach",
      name: "해운대해수욕장",
      english: true,
    });
    expect(label("/spots/gwangalli/")).toEqual({
      kind: "beach",
      name: null,
      english: false,
    });
    expect(label("/spots/constructor/")).toEqual({
      kind: "beach",
      name: null,
      english: false,
    });
  });

  it("화면 경로는 이름표 키, /en/ 경로도 같은 키(영어 표시만 덧붙임)", () => {
    expect(label("/")).toEqual({ kind: "screen", key: "home", english: false });
    expect(label("/en/")).toEqual({ kind: "screen", key: "home", english: true });
    expect(label("/en")).toEqual({ kind: "screen", key: "home", english: true });
    expect(label("/explore")).toEqual({
      kind: "screen",
      key: "explore",
      english: false,
    });
    expect(label("/en/settings/inquiry/")).toEqual({
      kind: "screen",
      key: "inquiry",
      english: true,
    });
    expect(label("/about/data/")).toMatchObject({ key: "dataSources" });
    expect(label("/guide/#tide")).toMatchObject({ key: "guide" });
  });

  it("모르는 경로는 경로 그대로, GA (other) 행은 기타", () => {
    expect(label("/admin-test/")).toEqual({
      kind: "unknown",
      path: "/admin-test/",
    });
    expect(label("/spots/")).toEqual({ kind: "unknown", path: "/spots/" });
    expect(label("/english/")).toEqual({ kind: "unknown", path: "/english/" });
    expect(label("(other)", true)).toEqual({ kind: "other" });
    // 이름표 키마다 화면 이름 문구가 있음
    for (const key of Object.values(SCREEN_PATHS)) {
      expect(messages.stats.screenNames[key]).toBeTruthy();
    }
  });
});

describe("들어온 경로 채널 표시표", () => {
  const table = messages.stats.channelLabels;

  it("GA4 기본 채널 이름을 우리말로, 표에 없는 값은 원문", () => {
    expect(channelName("Organic Search", table)).toBe("검색");
    expect(channelName("Direct", table)).toBe("직접 방문");
    expect(channelName("Referral", table)).toBe("다른 사이트");
    expect(channelName("Organic Social", table)).toBe("소셜");
    expect(channelName("(other)", table)).toBe("기타");
    expect(channelName("Paid Search", table)).toBe("검색 광고");
    expect(channelName("New Channel", table)).toBe("New Channel");
    // 객체 기본 속성 이름을 채널로 집지 않음
    expect(channelName("constructor", table)).toBe("constructor");
  });

  it("시간대별 평균은 소수 첫째 자리, null은 그대로", () => {
    expect(roundAverage(3.571428)).toBe(3.6);
    expect(roundAverage(0)).toBe(0);
    expect(roundAverage(null)).toBeNull();
  });
});

describe("기간 표시·못 받은 목록 문구(두 화면 공통)", () => {
  const good = localStatsView("28d", Date.parse("2026-11-13T05:00:00Z"));

  it("KST 날짜 그대로 'M월 D일 – M월 D일', 앞 기간이 있을 때만 비교 글", () => {
    expect(trendRangeText(good.trends!, "28d", ", ")).toBe(
      "10월 17일 – 11월 13일, 앞 28일과 비교",
    );
    expect(
      trendRangeText({ ...good.trends!, previous: null }, "28d", " · "),
    ).toBe("10월 17일 – 11월 13일");
    expect(trendRangeText(null, "28d", ", ")).toBeNull();
  });

  it("시간대가 달라 목록을 못 받으면 그 사유, 아니면 일반 실패 문구", () => {
    expect(
      trendUnavailable({ ...good.trends!, timeZoneMismatch: true }),
    ).toMatch(/GA4 속성 시간대가 서울과 달라/);
    expect(trendUnavailable(good.trends!)).toMatch(/불러오지 못했어요/);
    expect(trendUnavailable(null)).toMatch(/불러오지 못했어요/);
  });

  it("오늘 범위 예시: 지나지 않은 시간은 셀 날 0·평균 null(결측과 구분)", () => {
    const today = localStatsView("today", Date.parse("2026-11-13T01:30:00Z")); // KST 10:30
    const rows = today.trends!.hourly!.rows;
    expect(rows[9]).toMatchObject({ reportedDays: 1 });
    expect(rows[10]).toEqual({ hour: 10, averageActiveUsers: null, reportedDays: 0 });
  });
});
