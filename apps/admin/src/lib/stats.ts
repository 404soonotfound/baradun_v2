import { opsFetch, type OpsResult } from "./auth/ops-fetch";
import type { BeachSlugName } from "./beach-names";

export const STATS_RANGES = ["today", "7d", "28d", "60d"] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

export interface StatsMetadata {
  readonly thresholding: boolean;
  readonly sampling: boolean;
  readonly otherRowLoss: boolean;
}

export interface StatsRealtime {
  readonly status: "ok" | "unavailable";
  readonly activeUsers: number | null;
  readonly pageViews: number | null;
}

export interface StatsBeachRow {
  readonly path: string;
  readonly slug: string | null;
  readonly pageViews: number | null;
}

export interface StatsDeviceRow {
  readonly category: string;
  readonly activeUsers: number | null;
}

export interface StatsLanguageRow {
  readonly language: string;
  readonly activeUsers: number | null;
}

export interface StatsPeriod {
  readonly status: "ok" | "unavailable";
  readonly activeUsers: number | null;
  readonly pageViews: number | null;
  readonly topBeaches: readonly StatsBeachRow[] | null;
  readonly devices: readonly StatsDeviceRow[] | null;
  readonly languages: readonly StatsLanguageRow[] | null;
  readonly metadata: StatsMetadata;
}

export interface StatsEventStatus {
  readonly name: string;
  readonly status: "collecting" | "not_collecting";
}

export interface StatsResponse {
  readonly configured: boolean;
  readonly sample?: boolean;
  readonly fetchedAt: string;
  readonly cached: boolean;
  readonly range: StatsRange;
  readonly realtime: StatsRealtime;
  readonly period: StatsPeriod;
  readonly events: readonly StatsEventStatus[];
}

export function fetchStats(
  range: StatsRange,
  getAccessToken: () => Promise<string | null>,
): Promise<OpsResult<StatsResponse>> {
  return opsFetch<StatsResponse>(
    `/ops/stats?range=${encodeURIComponent(range)}`,
    getAccessToken,
    { method: "GET" },
  );
}

// 빈 값·합계 0이면 비율을 추정하지 않고 null('–') 반환
export function sharePercent(
  count: number | null,
  total: number | null,
): number | null {
  if (count === null || total === null || total <= 0) return null;
  return Math.round((count / total) * 100);
}

export function sumMetric(
  values: readonly (number | null)[],
): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) {
    if (v === null) return null;
    sum += v;
  }
  return sum;
}

export function metadataReasons(
  metadata: StatsMetadata,
): readonly ("thresholding" | "sampling" | "otherRowLoss")[] {
  const out: ("thresholding" | "sampling" | "otherRowLoss")[] = [];
  if (metadata.thresholding) out.push("thresholding");
  if (metadata.sampling) out.push("sampling");
  if (metadata.otherRowLoss) out.push("otherRowLoss");
  return out;
}

export function beachLabel(
  row: StatsBeachRow,
  bySlug: Record<string, BeachSlugName>,
): { title: string; region: string | null } {
  if (row.slug && bySlug[row.slug]) {
    const info = bySlug[row.slug]!;
    return { title: info.name, region: info.region };
  }
  return { title: row.slug ?? row.path, region: null };
}
