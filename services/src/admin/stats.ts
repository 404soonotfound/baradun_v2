import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GoogleAuth } from "google-auth-library";
import { errorName, safeLog } from "./http";

// 이용 통계 (BRD-154, ADM-STATS, 결정 기록 D15-8 · D13-7 · D16-E8, 아키텍처 18.5)
// - 출시 수집은 page_view만. 다른 이벤트는 '수집 안 함(후속)'으로 표시
// - GA Data API 호출은 운영 API만. 서비스 계정 키는 SSM Parameter Store SecureString에서 읽음
// - 응답은 인메모리 TTL 캐시로 잠시 저장해 호출량 절약
// - 숫자 제한 안내는 GA 응답의 thresholding·sampling·other-row 손실 metadata가 있을 때만 표시(E8)
// - 숨긴 숫자는 추정하지 않으며 빈칸·미수신은 null(0으로 바꾸지 않음)

export const STATS_RANGES = ["today", "7d", "28d", "60d"] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

export const STATS_CACHE_TTL_MS = 5 * 60_000;
export const SSM_TIMEOUT_MS = 1_500;
export const TOKEN_TIMEOUT_MS = 1_500;
export const GA4_TIMEOUT_MS = 3_500;
export const TOP_LIST_LIMIT = 10;
export const GA4_TOP_BEACHES_FETCH_LIMIT = 250;
export const GA4_LANGUAGES_FETCH_LIMIT = 50;
const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

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

export const STATS_EVENTS: readonly StatsEventStatus[] = [
  { name: "page_view", status: "collecting" },
  { name: "select_activity", status: "not_collecting" },
  { name: "search_no_result", status: "not_collecting" },
  { name: "inquiry_sent", status: "not_collecting" },
];

export interface StatsReader {
  read(range: StatsRange): Promise<StatsResponse>;
}

export function parseStatsRange(raw: string | undefined): StatsRange | null {
  if (raw === undefined || raw === "") return "7d";
  return (STATS_RANGES as readonly string[]).includes(raw)
    ? (raw as StatsRange)
    : null;
}

export function extractBeachSlug(rawPath: string): string | null {
  const pathOnly = rawPath.split(/[?#]/, 1)[0] ?? "";
  const m = /^(?:\/en)?\/spots\/([^/]+)\/?$/.exec(pathOnly);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

export function parseMetricInt(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export interface Ga4Row {
  readonly dimensionValues?: readonly { readonly value?: string }[];
  readonly metricValues?: readonly { readonly value?: string }[];
}

export interface Ga4ReportBody {
  readonly rows?: readonly Ga4Row[];
  readonly metadata?: {
    readonly subjectToThresholding?: boolean;
    readonly dataLossFromOtherRow?: boolean;
    readonly samplingMetadatas?: readonly unknown[];
  };
}

export function extractMetadataFlags(
  metadata: Ga4ReportBody["metadata"] | undefined,
): StatsMetadata {
  return {
    thresholding: metadata?.subjectToThresholding === true,
    sampling:
      Array.isArray(metadata?.samplingMetadatas) &&
      metadata.samplingMetadatas.length > 0,
    otherRowLoss: metadata?.dataLossFromOtherRow === true,
  };
}

export function mergeMetadataFlags(
  list: readonly StatsMetadata[],
): StatsMetadata {
  return {
    thresholding: list.some((m) => m.thresholding),
    sampling: list.some((m) => m.sampling),
    otherRowLoss: list.some((m) => m.otherRowLoss),
  };
}

export function parseRealtimeReport(body: Ga4ReportBody): StatsRealtime {
  const row = body.rows?.[0];
  return {
    status: "ok",
    activeUsers: parseMetricInt(row?.metricValues?.[0]?.value),
    pageViews: parseMetricInt(row?.metricValues?.[1]?.value),
  };
}

export function parseSummaryReport(body: Ga4ReportBody): {
  activeUsers: number | null;
  pageViews: number | null;
  metadata: StatsMetadata;
} {
  const row = body.rows?.[0];
  return {
    activeUsers: parseMetricInt(row?.metricValues?.[0]?.value),
    pageViews: parseMetricInt(row?.metricValues?.[1]?.value),
    metadata: extractMetadataFlags(body.metadata),
  };
}

function mergeMetricCount(
  prev: number | null,
  next: number | null,
): number | null {
  if (prev === null || next === null) return null;
  return prev + next;
}

function compareMetricDesc(a: number | null, b: number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

export function parseTopBeachesReport(body: Ga4ReportBody): {
  rows: readonly StatsBeachRow[];
  metadata: StatsMetadata;
} {
  const bySlug = new Map<string, StatsBeachRow>();
  for (const r of body.rows ?? []) {
    const path = r.dimensionValues?.[0]?.value ?? "";
    const slug = extractBeachSlug(path);
    if (!slug) continue;
    const pageViews = parseMetricInt(r.metricValues?.[0]?.value);
    const prev = bySlug.get(slug);
    if (!prev) {
      bySlug.set(slug, {
        path: `/spots/${slug}`,
        slug,
        pageViews,
      });
    } else {
      bySlug.set(slug, {
        path: prev.path,
        slug,
        pageViews: mergeMetricCount(prev.pageViews, pageViews),
      });
    }
  }
  const rows = [...bySlug.values()]
    .sort((a, b) => compareMetricDesc(a.pageViews, b.pageViews))
    .slice(0, TOP_LIST_LIMIT);
  return { rows, metadata: extractMetadataFlags(body.metadata) };
}

export function parseDevicesReport(body: Ga4ReportBody): {
  rows: readonly StatsDeviceRow[];
  metadata: StatsMetadata;
} {
  const rows = (body.rows ?? [])
    .map((r) => ({
      category: r.dimensionValues?.[0]?.value ?? "",
      activeUsers: parseMetricInt(r.metricValues?.[0]?.value),
    }))
    .filter((r) => r.category !== "");
  return { rows, metadata: extractMetadataFlags(body.metadata) };
}

export function parseLanguagesReport(body: Ga4ReportBody): {
  rows: readonly StatsLanguageRow[];
  metadata: StatsMetadata;
} {
  const byLang = new Map<string, number | null>();
  for (const r of body.rows ?? []) {
    const raw = (r.dimensionValues?.[0]?.value ?? "").trim().toLowerCase();
    if (!raw || raw === "(not set)") continue;
    const primary = raw.split(/[-_]/, 1)[0] ?? "";
    if (!primary) continue;
    const activeUsers = parseMetricInt(r.metricValues?.[0]?.value);
    if (!byLang.has(primary)) {
      byLang.set(primary, activeUsers);
    } else {
      byLang.set(
        primary,
        mergeMetricCount(byLang.get(primary) ?? null, activeUsers),
      );
    }
  }
  const rows: StatsLanguageRow[] = [...byLang.entries()]
    .map(([language, activeUsers]) => ({ language, activeUsers }))
    .sort((a, b) => compareMetricDesc(a.activeUsers, b.activeUsers))
    .slice(0, TOP_LIST_LIMIT);
  return { rows, metadata: extractMetadataFlags(body.metadata) };
}

export function dateRangeFor(range: StatsRange): {
  startDate: string;
  endDate: string;
} {
  switch (range) {
    case "today":
      return { startDate: "today", endDate: "today" };
    case "7d":
      return { startDate: "6daysAgo", endDate: "today" };
    case "28d":
      return { startDate: "27daysAgo", endDate: "today" };
    case "60d":
      return { startDate: "59daysAgo", endDate: "today" };
  }
}

export function unconfiguredStats(
  range: StatsRange,
  now: Date,
): StatsResponse {
  return {
    configured: false,
    fetchedAt: now.toISOString(),
    cached: false,
    range,
    realtime: { status: "unavailable", activeUsers: null, pageViews: null },
    period: {
      status: "unavailable",
      activeUsers: null,
      pageViews: null,
      topBeaches: null,
      devices: null,
      languages: null,
      metadata: { thresholding: false, sampling: false, otherRowLoss: false },
    },
    events: STATS_EVENTS,
  };
}

export function createCachedStatsReader(
  inner: StatsReader,
  now: () => Date,
  ttlMs = STATS_CACHE_TTL_MS,
): StatsReader {
  const cache = new Map<
    StatsRange,
    { readonly expiresAtMs: number; readonly value: StatsResponse }
  >();
  return {
    async read(range) {
      const currentMs = now().getTime();
      const hit = cache.get(range);
      if (hit && currentMs < hit.expiresAtMs) {
        return { ...hit.value, cached: true };
      }
      const fresh = await inner.read(range);
      // 실시간·기간·세부 리포트 중 하나라도 실패하면 캐시하지 않아 다음 새로고침이 바로 재시도함
      if (
        fresh.configured &&
        fresh.realtime.status === "ok" &&
        fresh.period.status === "ok" &&
        fresh.period.topBeaches !== null &&
        fresh.period.devices !== null &&
        fresh.period.languages !== null
      ) {
        cache.set(range, { expiresAtMs: currentMs + ttlMs, value: fresh });
      }
      return fresh;
    },
  };
}

export interface Ga4StatsConfig {
  readonly propertyId: string;
  readonly serviceAccountParam: string;
  readonly region: string;
  readonly now: () => Date;
  readonly loadKeyJson?: (paramName: string) => Promise<string | null>;
  readonly fetchFn?: typeof fetch;
}

async function defaultLoadKeyJson(
  region: string,
  paramName: string,
): Promise<string | null> {
  const ssm = new SSMClient({ region });
  const out = await ssm.send(
    new GetParameterCommand({ Name: paramName, WithDecryption: true }),
    { abortSignal: AbortSignal.timeout(SSM_TIMEOUT_MS) },
  );
  return out.Parameter?.Value ?? null;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function createGa4StatsReader(config: Ga4StatsConfig): StatsReader {
  let cachedClient: Awaited<ReturnType<GoogleAuth["getClient"]>> | null = null;
  const fetchImpl = config.fetchFn ?? fetch;

  async function getAccessToken(): Promise<string> {
    if (!cachedClient) {
      const raw = config.loadKeyJson
        ? await withTimeout(
            config.loadKeyJson(config.serviceAccountParam),
            SSM_TIMEOUT_MS,
            "SSM",
          )
        : await defaultLoadKeyJson(config.region, config.serviceAccountParam);
      if (!raw) throw new Error("GA4 서비스 계정 키 파라미터 비어 있음");
      const credentials = JSON.parse(raw) as Record<string, unknown>;
      const auth = new GoogleAuth({
        credentials,
        scopes: [GA4_SCOPE],
      });
      cachedClient = await auth.getClient();
    }
    const token = await withTimeout(
      cachedClient.getAccessToken(),
      TOKEN_TIMEOUT_MS,
      "GA4 token",
    );
    if (!token.token) throw new Error("GA4 액세스 토큰 발급 실패");
    return token.token;
  }

  async function postGa4(
    endpoint: "runRealtimeReport" | "runReport",
    token: string,
    payload: unknown,
  ): Promise<Ga4ReportBody> {
    const url = `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(config.propertyId)}:${endpoint}`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GA4_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`GA4 ${endpoint} HTTP ${res.status}`);
    }
    return (await res.json()) as Ga4ReportBody;
  }

  return {
    async read(range) {
      const now = config.now();
      let token: string;
      try {
        token = await getAccessToken();
      } catch (error) {
        safeLog("warn", "stats_auth_failed", { error: errorName(error) });
        return { ...unconfiguredStats(range, now), configured: true };
      }

      const dateRange = dateRangeFor(range);
      const [realtimeRes, summaryRes, beachesRes, devicesRes, languagesRes] =
        await Promise.allSettled([
          postGa4("runRealtimeReport", token, {
            metrics: [{ name: "activeUsers" }, { name: "screenPageViews" }],
            minuteRanges: [{ startMinutesAgo: 29, endMinutesAgo: 0 }],
          }),
          postGa4("runReport", token, {
            dateRanges: [dateRange],
            metrics: [{ name: "activeUsers" }, { name: "screenPageViews" }],
          }),
          postGa4("runReport", token, {
            dateRanges: [dateRange],
            dimensions: [{ name: "pagePath" }],
            metrics: [{ name: "screenPageViews" }],
            dimensionFilter: {
              filter: {
                fieldName: "pagePath",
                stringFilter: { matchType: "CONTAINS", value: "/spots/" },
              },
            },
            orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
            limit: GA4_TOP_BEACHES_FETCH_LIMIT,
          }),
          postGa4("runReport", token, {
            dateRanges: [dateRange],
            dimensions: [{ name: "deviceCategory" }],
            metrics: [{ name: "activeUsers" }],
            orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
            limit: TOP_LIST_LIMIT,
          }),
          postGa4("runReport", token, {
            dateRanges: [dateRange],
            dimensions: [{ name: "languageCode" }],
            metrics: [{ name: "activeUsers" }],
            orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
            limit: GA4_LANGUAGES_FETCH_LIMIT,
          }),
        ]);

      let realtime: StatsRealtime = {
        status: "unavailable",
        activeUsers: null,
        pageViews: null,
      };
      if (realtimeRes.status === "fulfilled") {
        realtime = parseRealtimeReport(realtimeRes.value);
      } else {
        safeLog("warn", "stats_realtime_failed", {
          error: errorName(realtimeRes.reason),
        });
      }

      let period: StatsPeriod = {
        status: "unavailable",
        activeUsers: null,
        pageViews: null,
        topBeaches: null,
        devices: null,
        languages: null,
        metadata: { thresholding: false, sampling: false, otherRowLoss: false },
      };

      if (summaryRes.status === "fulfilled") {
        const summary = parseSummaryReport(summaryRes.value);
        const beaches =
          beachesRes.status === "fulfilled"
            ? parseTopBeachesReport(beachesRes.value)
            : null;
        if (!beaches && beachesRes.status === "rejected") {
          safeLog("warn", "stats_beaches_failed", {
            error: errorName(beachesRes.reason),
          });
        }
        const devices =
          devicesRes.status === "fulfilled"
            ? parseDevicesReport(devicesRes.value)
            : null;
        if (!devices && devicesRes.status === "rejected") {
          safeLog("warn", "stats_devices_failed", {
            error: errorName(devicesRes.reason),
          });
        }
        const languages =
          languagesRes.status === "fulfilled"
            ? parseLanguagesReport(languagesRes.value)
            : null;
        if (!languages && languagesRes.status === "rejected") {
          safeLog("warn", "stats_languages_failed", {
            error: errorName(languagesRes.reason),
          });
        }
        period = {
          status: "ok",
          activeUsers: summary.activeUsers,
          pageViews: summary.pageViews,
          topBeaches: beaches ? beaches.rows : null,
          devices: devices ? devices.rows : null,
          languages: languages ? languages.rows : null,
          metadata: mergeMetadataFlags([
            summary.metadata,
            ...(beaches ? [beaches.metadata] : []),
            ...(devices ? [devices.metadata] : []),
            ...(languages ? [languages.metadata] : []),
          ]),
        };
      } else {
        safeLog("warn", "stats_period_failed", {
          error: errorName(summaryRes.reason),
        });
      }

      return {
        configured: true,
        fetchedAt: now.toISOString(),
        cached: false,
        range,
        realtime,
        period,
        events: STATS_EVENTS,
      };
    },
  };
}
