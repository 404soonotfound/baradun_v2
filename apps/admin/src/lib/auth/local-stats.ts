import type { StatsRange, StatsResponse, StatsTrends } from "../stats";
import type { OpsResult } from "./ops-fetch";

const MULTIPLIER: Record<StatsRange, number> = {
  today: 1,
  "7d": 6,
  "28d": 22,
  "60d": 44,
};

const DAYS: Record<StatsRange, number> = { today: 1, "7d": 7, "28d": 28, "60d": 60 };
const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;
const NO_LIMITS = { thresholding: false, sampling: false, otherRowLoss: false };

// 기간 추이 예시(서버 services/src/admin/stats-trends.ts 모양). 날짜는 KST 오늘까지, 값은 예시
function localTrends(range: StatsRange, nowMs: number): StatsTrends {
  const days = DAYS[range];
  const today = Date.parse(
    new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10),
  );
  const date = (daysAgo: number) =>
    new Date(today - daysAgo * DAY_MS).toISOString().slice(0, 10);
  const daily = Array.from({ length: days }, (_, i) => {
    const wave = 1 + 0.25 * Math.sin(i / 2);
    return {
      date: date(days - 1 - i),
      activeUsers: Math.round(180 * wave),
      pageViews: Math.round(420 * wave),
    };
  });
  const m = MULTIPLIER[range];
  const currentHour = new Date(nowMs + KST_OFFSET_MS).getUTCHours();
  return {
    startDate: date(days - 1),
    endDate: date(0),
    ga4TimeZone: "Asia/Seoul",
    timeZoneMismatch: false,
    daily: { rows: daily, metadata: NO_LIMITS },
    hourly: {
      // 오늘 범위는 끝난 시간만 셈(서버와 같이 지금 시각 이후는 셀 날 0·평균 null)
      rows: Array.from({ length: 24 }, (_, hour) => {
        const notYet = range === "today" && hour >= currentHour;
        return {
          hour,
          averageActiveUsers: notYet
            ? null
            : Math.round(
                (2 +
                  10 *
                    Math.max(0, Math.sin(((hour - 5) / 24) * Math.PI * 1.6))) *
                  10,
              ) / 10,
          reportedDays: notYet ? 0 : range === "today" ? 1 : days,
        };
      }),
      metadata: NO_LIMITS,
    },
    previous:
      range === "today"
        ? null
        : {
            startDate: date(days * 2 - 1),
            endDate: date(days),
            activeUsers: 152 * m,
            pageViews: 347 * m,
            metadata: NO_LIMITS,
          },
    newUsers: 112 * m,
    newUsersMetadata: NO_LIMITS,
    topScreens: {
      rows: [
        { path: "/", pageViews: 160 * m, other: false },
        { path: "/spots/haeundae/", pageViews: 85 * m, other: false },
        { path: "/explore/", pageViews: 61 * m, other: false },
        { path: "/guide/", pageViews: 14 * m, other: false },
        { path: "/en/search/", pageViews: 9 * m, other: false },
      ],
      metadata: NO_LIMITS,
    },
    referrers: {
      rows: [
        { channel: "Direct", sessions: 98 * m, other: false },
        { channel: "Organic Search", sessions: 63 * m, other: false },
        { channel: "Organic Social", sessions: 29 * m, other: false },
        { channel: "Referral", sessions: 11 * m, other: false },
      ],
      metadata: NO_LIMITS,
    },
  };
}

export function localStatsView(
  range: StatsRange,
  nowMs = Date.now(),
): StatsResponse {
  const m = MULTIPLIER[range];
  return {
    configured: true,
    fetchedAt: new Date(nowMs).toISOString(),
    cached: false,
    range,
    realtime: {
      status: "ok",
      activeUsers: 14,
      pageViews: 32,
    },
    period: {
      status: "ok",
      activeUsers: 180 * m,
      pageViews: 420 * m,
      topBeaches: [
        { path: "/spots/haeundae", slug: "haeundae", pageViews: 85 * m },
        { path: "/spots/gwangan-ri", slug: "gwangan-ri", pageViews: 64 * m },
        { path: "/spots/gyeongpo", slug: "gyeongpo", pageViews: 47 * m },
      ],
      devices: [
        { category: "mobile", activeUsers: 132 * m },
        { category: "desktop", activeUsers: 43 * m },
        { category: "tablet", activeUsers: 5 * m },
      ],
      languages: [
        { language: "ko", activeUsers: 162 * m },
        { language: "en", activeUsers: 18 * m },
      ],
      metadata: NO_LIMITS,
    },
    trends: localTrends(range, nowMs),
  };
}

export function localStats<T>(
  searchParams: URLSearchParams,
): OpsResult<T> {
  const raw = searchParams.get("range") ?? "7d";
  const range: StatsRange =
    raw === "today" || raw === "7d" || raw === "28d" || raw === "60d"
      ? raw
      : "7d";
  return {
    ok: true,
    status: 200,
    body: localStatsView(range) as T,
  };
}
