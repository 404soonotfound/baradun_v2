import type { StatsRange, StatsResponse } from "../stats";
import type { OpsResult } from "./ops-fetch";

const MULTIPLIER: Record<StatsRange, number> = {
  today: 1,
  "7d": 6,
  "28d": 22,
  "60d": 44,
};

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
      metadata: {
        thresholding: false,
        sampling: false,
        otherRowLoss: false,
      },
    },
    events: [
      { name: "page_view", status: "collecting" },
      { name: "select_activity", status: "collecting" },
      { name: "search_no_result", status: "collecting" },
      { name: "select_search_result", status: "collecting" },
      { name: "inquiry_sent", status: "collecting" },
      { name: "toggle_explore_view", status: "collecting" },
      { name: "toggle_favorite", status: "collecting" },
      { name: "share_spot", status: "collecting" },
      { name: "complete_onboarding_notice", status: "collecting" },
      { name: "respond_location_prompt", status: "collecting" },
      { name: "change_setting", status: "collecting" },
      { name: "open_warning_sheet", status: "not_collecting" },
      { name: "open_weather_detail", status: "not_collecting" },
      { name: "select_alternative_beach", status: "not_collecting" },
      { name: "open_offline_fallback", status: "not_collecting" },
    ],
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
