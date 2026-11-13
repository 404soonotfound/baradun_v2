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

// 아래 칸은 지금 서버 응답(services/src/admin/stats.ts)에 없음. 서버에 생기면 화면이 칸을 다시 보임(GH-453)
// 칸이 없으면(undefined) 화면에서 숨김, null이면 그 리포트를 못 받은 것(칸은 두고 '불러오지 못함')
export interface StatsDailyRow {
  readonly date: string; // KST 날짜 YYYY-MM-DD
  readonly activeUsers: number | null;
  readonly pageViews: number | null;
}

export interface StatsHourlyRow {
  readonly hour: number; // KST 0~23시
  readonly activeUsers: number | null;
}

export interface StatsScreenRow {
  readonly path: string;
  readonly title: string | null; // GA pageTitle. 없으면 화면은 '이름 확인 못 함'
  readonly pageViews: number | null;
}

export interface StatsReferrerRow {
  readonly channel: string; // GA sessionDefaultChannelGroup
  readonly sessions: number | null;
}

export interface StatsPrevious {
  readonly activeUsers: number | null;
  readonly pageViews: number | null;
}

export interface StatsPeriod {
  readonly status: "ok" | "unavailable";
  readonly activeUsers: number | null;
  readonly pageViews: number | null;
  readonly topBeaches: readonly StatsBeachRow[] | null;
  readonly devices: readonly StatsDeviceRow[] | null;
  readonly languages: readonly StatsLanguageRow[] | null;
  readonly metadata: StatsMetadata;
  readonly daily?: readonly StatsDailyRow[] | null;
  readonly hourly?: readonly StatsHourlyRow[] | null;
  readonly newUsers?: number | null;
  readonly previous?: StatsPrevious | null;
  readonly topScreens?: readonly StatsScreenRow[] | null;
  readonly referrers?: readonly StatsReferrerRow[] | null;
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

// 없을 수 있는 칸: 없으면(undefined) 통과, 있으면 모양까지 검사
const optional = (v: unknown, check: (v: unknown) => boolean) =>
  v === undefined || check(v);

const isDaily = (v: unknown) =>
  v === null ||
  (Array.isArray(v) &&
    v.every(
      (r) =>
        isRecord(r) &&
        typeof r.date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
        isCount(r.activeUsers) &&
        isCount(r.pageViews),
    ));

const isHourly = (v: unknown) =>
  v === null ||
  (Array.isArray(v) &&
    v.every(
      (r) =>
        isRecord(r) &&
        Number.isInteger(r.hour) &&
        (r.hour as number) >= 0 &&
        (r.hour as number) <= 23 &&
        isCount(r.activeUsers),
    ));

const isScreens = (v: unknown) =>
  isRows(v, "path", "pageViews") &&
  (v === null ||
    (v as Record<string, unknown>[]).every(
      (r) => r.title === null || typeof r.title === "string",
    ));

const isPrevious = (v: unknown) =>
  v === null || (isRecord(v) && isCount(v.activeUsers) && isCount(v.pageViews));

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
    typeof metadata.otherRowLoss === "boolean" &&
    optional(period.daily, isDaily) &&
    optional(period.hourly, isHourly) &&
    optional(period.newUsers, isCount) &&
    optional(period.previous, isPrevious) &&
    optional(period.topScreens, isScreens) &&
    optional(period.referrers, (r) => isRows(r, "channel", "sessions"))
  );
}

// 응답에 칸이 있는지(값이 생기면 화면이 칸을 다시 보임). null(리포트 실패)은 칸이 있는 것으로 봄
export interface StatsShape {
  readonly daily: boolean;
  readonly hourly: boolean;
  readonly newUsers: boolean;
  readonly previous: boolean;
  readonly topScreens: boolean;
  readonly referrers: boolean;
}

// 아직 받은 응답이 없을 때: 지금 서버가 주는 칸만 있다고 봄(자리표시도 그 칸에만)
export const SHAPE_NONE: StatsShape = {
  daily: false,
  hourly: false,
  newUsers: false,
  previous: false,
  topScreens: false,
  referrers: false,
};

export function statsShape(period: StatsPeriod | null): StatsShape {
  if (period === null) return SHAPE_NONE;
  return {
    daily: period.daily !== undefined,
    hourly: period.hourly !== undefined,
    newUsers: period.newUsers !== undefined,
    previous: period.previous !== undefined,
    topScreens: period.topScreens !== undefined,
    referrers: period.referrers !== undefined,
  };
}

export type MissingItem = "dailyHourly" | "daily" | "hourly" | "previous" | "topScreens" | "referrers";

// 기간 표시 아래 한 줄에 넣을 '아직 보여 드릴 수 없는' 항목(순서 고정). 새 사용자 비율 칸은 줄에 넣지 않음
export function missingItems(shape: StatsShape): readonly MissingItem[] {
  const out: MissingItem[] = [];
  if (!shape.daily && !shape.hourly) out.push("dailyHourly");
  else if (!shape.daily) out.push("daily");
  else if (!shape.hourly) out.push("hourly");
  if (!shape.previous) out.push("previous");
  if (!shape.topScreens) out.push("topScreens");
  if (!shape.referrers) out.push("referrers");
  return out;
}

// 앞 기간 대비 변화(%, 소수 1자리). 둘 중 하나라도 없거나 앞 기간이 0이면 null(비교하지 않음)
export function changePercent(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null || previous === null || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
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
