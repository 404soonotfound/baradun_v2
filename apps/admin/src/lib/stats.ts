import { opsFetch, type OpsResult } from "./auth/ops-fetch";
import type { BeachSlugName } from "./beach-names";
import { fill, messages } from "./messages";

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

// 기간 추이(서버 services/src/admin/stats-trends.ts StatsTrends, GH-477). 시간대가 KST로 확인될 때만 목록을 줌
// - trends가 없거나(이전 서버·GA4 미연결) 목록 칸이 응답에 없으면(undefined) 화면에서 그 칸을 숨김
// - 목록이 null이면 그 리포트를 못 받음(조회 실패·시간대 불일치, 칸은 두고 '불러오지 못함')
// - 행 안의 수치가 null이면 그 값만 '확인 못 함'(0으로 그리지 않음)
export interface StatsList<T> {
  readonly rows: readonly T[];
  readonly metadata: StatsMetadata;
}

export interface StatsDailyRow {
  readonly date: string; // KST 날짜 YYYY-MM-DD
  readonly activeUsers: number | null;
  readonly pageViews: number | null;
}

export interface StatsHourlyRow {
  readonly hour: number; // KST 0~23시
  // 그 시간이 끝난 날짜(reportedDays)로 나눈 평균(소수). 셀 수 없으면 null
  readonly averageActiveUsers: number | null;
  readonly reportedDays: number;
}

export interface StatsScreenRow {
  readonly path: string; // GA pagePath. '(other)'는 other: true
  readonly pageViews: number | null;
  readonly other: boolean;
}

export interface StatsReferrerRow {
  readonly channel: string; // GA sessionDefaultChannelGroup(영어 기본 채널 이름)
  readonly sessions: number | null;
  readonly other: boolean;
}

export interface StatsPrevious {
  readonly startDate: string;
  readonly endDate: string;
  readonly activeUsers: number | null;
  readonly pageViews: number | null;
  readonly metadata: StatsMetadata;
}

export interface StatsTrends {
  readonly startDate: string; // KST, 양 끝 포함
  readonly endDate: string;
  readonly ga4TimeZone: string | null;
  readonly timeZoneMismatch: boolean | null;
  readonly daily?: StatsList<StatsDailyRow> | null;
  readonly hourly?: StatsList<StatsHourlyRow> | null;
  // 오늘 범위·조회 실패·행 없음이면 null(비교 배지 숨김)
  readonly previous?: StatsPrevious | null;
  readonly newUsers?: number | null;
  readonly newUsersMetadata?: StatsMetadata | null;
  readonly topScreens?: StatsList<StatsScreenRow> | null;
  readonly referrers?: StatsList<StatsReferrerRow> | null;
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
  readonly trends?: StatsTrends;
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

const isDate = (v: unknown) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

const isMetadata = (v: unknown) =>
  isRecord(v) &&
  typeof v.thresholding === "boolean" &&
  typeof v.sampling === "boolean" &&
  typeof v.otherRowLoss === "boolean";

// { rows, metadata } 또는 null(리포트 못 받음)
const isList = (row: (r: Record<string, unknown>) => boolean) => (v: unknown) =>
  v === null ||
  (isRecord(v) &&
    isMetadata(v.metadata) &&
    Array.isArray(v.rows) &&
    v.rows.every((r) => isRecord(r) && row(r)));

const isDaily = isList(
  (r) => isDate(r.date) && isCount(r.activeUsers) && isCount(r.pageViews),
);

const isHourly = isList(
  (r) =>
    Number.isInteger(r.hour) &&
    (r.hour as number) >= 0 &&
    (r.hour as number) <= 23 &&
    isCount(r.averageActiveUsers) &&
    Number.isInteger(r.reportedDays) &&
    (r.reportedDays as number) >= 0,
);

const isScreens = isList(
  (r) =>
    typeof r.path === "string" &&
    isCount(r.pageViews) &&
    typeof r.other === "boolean",
);

const isReferrers = isList(
  (r) =>
    typeof r.channel === "string" &&
    isCount(r.sessions) &&
    typeof r.other === "boolean",
);

const isPrevious = (v: unknown) =>
  v === null ||
  (isRecord(v) &&
    isDate(v.startDate) &&
    isDate(v.endDate) &&
    isCount(v.activeUsers) &&
    isCount(v.pageViews) &&
    isMetadata(v.metadata));

// 기간 추이 모양 검사. 틀리면 응답 전체를 불러오기 실패로 봄(다른 칸과 같은 기준)
const isTrends = (v: unknown) =>
  isRecord(v) &&
  isDate(v.startDate) &&
  isDate(v.endDate) &&
  (v.ga4TimeZone === null || typeof v.ga4TimeZone === "string") &&
  (v.timeZoneMismatch === null || typeof v.timeZoneMismatch === "boolean") &&
  optional(v.daily, isDaily) &&
  optional(v.hourly, isHourly) &&
  optional(v.previous, isPrevious) &&
  optional(v.newUsers, isCount) &&
  optional(v.newUsersMetadata, (m) => m === null || isMetadata(m)) &&
  optional(v.topScreens, isScreens) &&
  optional(v.referrers, isReferrers);

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
    isMetadata(period.metadata) &&
    optional(v.trends, isTrends)
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

// 응답에 trends가 없음(이전 서버·GA4 미연결): 추이 칸을 모두 숨김
export const SHAPE_NONE: StatsShape = {
  daily: false,
  hourly: false,
  newUsers: false,
  previous: false,
  topScreens: false,
  referrers: false,
};

// 아직 받은 응답이 없을 때: 지금 서버(GH-477 뒤)가 주는 칸이 모두 있다고 봄(자리표시도 그 칸 크기로)
export const SHAPE_ALL: StatsShape = {
  daily: true,
  hourly: true,
  newUsers: true,
  previous: true,
  topScreens: true,
  referrers: true,
};

export function statsShape(trends: StatsTrends | null | undefined): StatsShape {
  if (!trends) return SHAPE_NONE;
  return {
    daily: trends.daily !== undefined,
    hourly: trends.hourly !== undefined,
    newUsers: trends.newUsers !== undefined,
    previous: trends.previous !== undefined,
    topScreens: trends.topScreens !== undefined,
    referrers: trends.referrers !== undefined,
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

// 숫자 숨김 안내 사유: 기간 통계 + 화면에 보이는 추이 목록의 metadata를 모두 합침(하나라도 있으면 안내)
export function trendMetadata(
  period: StatsPeriod | null,
  trends: StatsTrends | null | undefined,
): StatsMetadata {
  const list: StatsMetadata[] = [];
  if (period) list.push(period.metadata);
  if (trends) {
    for (const m of [
      trends.daily?.metadata,
      trends.hourly?.metadata,
      trends.previous?.metadata,
      trends.newUsersMetadata,
      trends.topScreens?.metadata,
      trends.referrers?.metadata,
    ]) {
      if (m) list.push(m);
    }
  }
  return {
    thresholding: list.some((m) => m.thresholding),
    sampling: list.some((m) => m.sampling),
    otherRowLoss: list.some((m) => m.otherRowLoss),
  };
}

// 많이 본 화면 경로 → 화면 이름표 키(공개 웹 apps/web 페이지, /en/ 경로도 같은 키)
export const SCREEN_PATHS = {
  "/": "home",
  "/explore/": "explore",
  "/search/": "search",
  "/favorites/": "favorites",
  "/settings/": "settings",
  "/settings/inquiry/": "inquiry",
  "/guide/": "guide",
  "/about/data/": "dataSources",
  "/terms/": "terms",
} as const;

export type ScreenKey = (typeof SCREEN_PATHS)[keyof typeof SCREEN_PATHS];

export type ScreenLabel =
  // /spots/<slug>: 공개 해변 데이터 이름. 이름표에 없으면 name null('이름 확인 못 함', slug를 이름처럼 쓰지 않음)
  | { readonly kind: "beach"; readonly name: string | null; readonly english: boolean }
  | { readonly kind: "screen"; readonly key: ScreenKey; readonly english: boolean }
  // GA (other) 행: '기타'
  | { readonly kind: "other" }
  // 모르는 경로: 화면은 경로 그대로 작은 글씨
  | { readonly kind: "unknown"; readonly path: string };

export function screenLabel(
  row: Pick<StatsScreenRow, "path" | "other">,
  bySlug: Readonly<Record<string, BeachSlugName>>,
): ScreenLabel {
  if (row.other) return { kind: "other" };
  const pathOnly = row.path.split(/[?#]/, 1)[0] ?? "";
  const english = pathOnly === "/en" || pathOnly.startsWith("/en/");
  const rest = english ? pathOnly.slice(3) || "/" : pathOnly;
  const spot = /^\/spots\/([^/]+)\/?$/.exec(rest);
  if (spot) {
    let slug = spot[1]!;
    try {
      slug = decodeURIComponent(slug);
    } catch {
      // 깨진 인코딩은 그대로 찾음(못 찾으면 이름 없음)
    }
    const info = Object.hasOwn(bySlug, slug) ? bySlug[slug] : undefined;
    return { kind: "beach", name: info?.name ?? null, english };
  }
  const normalized = rest.endsWith("/") ? rest : `${rest}/`;
  if (Object.hasOwn(SCREEN_PATHS, normalized)) {
    return {
      kind: "screen",
      key: SCREEN_PATHS[normalized as keyof typeof SCREEN_PATHS],
      english,
    };
  }
  return { kind: "unknown", path: row.path };
}

// 들어온 경로: GA4 기본 채널 이름(영어) → 우리말 표시표. 표에 없는 값은 원문
export function channelName(
  channel: string,
  table: Readonly<Record<string, string>>,
): string {
  return Object.hasOwn(table, channel) ? table[channel]! : channel;
}

// 시간대별 평균(소수) → 소수 첫째 자리까지. null은 그대로(0으로 바꾸지 않음)
export function roundAverage(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

// 기간 표시 'M월 D일 – M월 D일'(KST 날짜 문자열 그대로, 시간대 변환 없음)
export function dateRangeParts(
  startDate: string,
  endDate: string,
): { start: { month: number; day: number }; end: { month: number; day: number } } {
  const part = (d: string) => ({
    month: Number(d.slice(5, 7)),
    day: Number(d.slice(8, 10)),
  });
  return { start: part(startDate), end: part(endDate) };
}

// 기간 표시 글(이용 통계 머리·운영 홈 이용 칸 공통): 'M월 D일 – M월 D일' + 앞 기간이 있으면 '앞 N일과 비교'
// 추이가 없으면 기간 이름(최근 28일 등)은 쓰는 쪽이 정함 → null
export function trendRangeText(
  trends: StatsTrends | null,
  range: StatsRange,
  separator: string,
): string | null {
  if (!trends) return null;
  const { start, end } = dateRangeParts(trends.startDate, trends.endDate);
  const dates = fill(messages.stats.dateRange, {
    startMonth: start.month,
    startDay: start.day,
    endMonth: end.month,
    endDay: end.day,
  });
  return trends.previous
    ? `${dates}${separator}${fill(messages.stats.compareWith, { previous: messages.stats.previousLabel[range] })}`
    : dates;
}

// 목록을 못 받은(null) 칸 문구: GA4 속성 시간대가 서울과 다르면 서버가 목록을 주지 않으므로 그 사유
export function trendUnavailable(trends: StatsTrends | null): string {
  return trends?.timeZoneMismatch === true
    ? messages.stats.timeZoneBlocked
    : messages.stats.subReportUnavailable;
}
