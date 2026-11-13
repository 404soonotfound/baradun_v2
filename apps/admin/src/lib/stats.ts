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

export interface StatsResponse {
  readonly configured: boolean;
  readonly sample?: boolean;
  readonly fetchedAt: string;
  readonly cached: boolean;
  readonly range: StatsRange;
  readonly realtime: StatsRealtime;
  readonly period: StatsPeriod;
}

// 응답 모양이 틀리면 불러오기 실패로 봄(빈 칸·0으로 채우지 않음). 세부 리포트 null(일부 실패)은 그대로 둠
export async function fetchStats(
  range: StatsRange,
  getAccessToken: () => Promise<string | null>,
): Promise<OpsResult<StatsResponse>> {
  const result = await opsFetch<unknown>(
    `/ops/stats?range=${encodeURIComponent(range)}`,
    getAccessToken,
    { method: "GET" },
  );
  if (!result.ok) return result;
  if (!validStats(result.body)) {
    return { ok: false, status: result.status, code: "format", requestId: null };
  }
  return { ...result, body: result.body };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isCount = (v: unknown) =>
  v === null || (typeof v === "number" && Number.isFinite(v));

const isRows = (v: unknown, key: string, metric: string) =>
  v === null ||
  (Array.isArray(v) &&
    v.every(
      (r) => isRecord(r) && typeof r[key] === "string" && isCount(r[metric]),
    ));

// 화면이 읽는 칸만 검사(서버 계약 services/src/admin/stats.ts StatsResponse)
export function validStats(v: unknown): v is StatsResponse {
  if (!isRecord(v)) return false;
  const { realtime, period } = v;
  if (
    typeof v.configured !== "boolean" ||
    typeof v.fetchedAt !== "string" ||
    Number.isNaN(Date.parse(v.fetchedAt)) ||
    typeof v.cached !== "boolean" ||
    !(STATS_RANGES as readonly unknown[]).includes(v.range) ||
    !isRecord(realtime) ||
    !isRecord(period)
  ) {
    return false;
  }
  const metadata = period.metadata;
  return (
    (realtime.status === "ok" || realtime.status === "unavailable") &&
    isCount(realtime.activeUsers) &&
    isCount(realtime.pageViews) &&
    (period.status === "ok" || period.status === "unavailable") &&
    isCount(period.activeUsers) &&
    isCount(period.pageViews) &&
    isRows(period.topBeaches, "path", "pageViews") &&
    isRows(period.devices, "category", "activeUsers") &&
    isRows(period.languages, "language", "activeUsers") &&
    isRecord(metadata) &&
    typeof metadata.thresholding === "boolean" &&
    typeof metadata.sampling === "boolean" &&
    typeof metadata.otherRowLoss === "boolean"
  );
}

// 사용자당 화면(보드 V8 '화면 조회 ÷ 사용자'). 받은 두 값으로만 계산, 하나라도 없거나 사용자 0이면 null
export function perUser(
  pageViews: number | null,
  users: number | null,
): number | null {
  if (pageViews === null || users === null || users <= 0) return null;
  return Math.round((pageViews / users) * 10) / 10;
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

// 많이 본 해변: /spots/[slug]를 공개 해변 데이터 이름으로. 이름표에 없거나 slug가 없으면 name null
// → 화면은 '이름 확인 못 함'(slug·경로를 이름처럼 보이지 않음)
export function beachLabel(
  row: StatsBeachRow,
  bySlug: Readonly<Record<string, BeachSlugName>>,
): { name: string | null; region: string | null } {
  // 'constructor' 같은 slug가 객체 기본 속성을 집지 않게 자기 키만 봄
  const info =
    row.slug && Object.hasOwn(bySlug, row.slug) ? bySlug[row.slug] : undefined;
  return info
    ? { name: info.name, region: info.region }
    : { name: null, region: null };
}
