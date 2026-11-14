import {
  extractMetadataFlags,
  parseMetricInt,
  type Ga4ReportBody,
  type Ga4Row,
  type StatsMetadata,
  type StatsRange,
} from "./stats";

export const STATS_TIME_ZONE = "Asia/Seoul";
const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;
const RANGE_DAYS = { today: 1, "7d": 7, "28d": 28, "60d": 60 } as const;

export interface StatsDates {
  readonly startDate: string;
  readonly endDate: string;
}
interface UsageCounts {
  readonly activeUsers: number | null;
  readonly pageViews: number | null;
}
interface StatsList<T> {
  readonly rows: readonly T[];
  readonly metadata: StatsMetadata;
}
export interface StatsTrends extends StatsDates {
  readonly ga4TimeZone: string | null;
  readonly timeZoneMismatch: boolean | null;
  readonly daily: StatsList<UsageCounts & { date: string }> | null;
  readonly hourly: StatsList<{
    hour: number;
    averageActiveUsers: number | null;
    reportedDays: number;
  }> | null;
  readonly previous:
    (StatsDates & UsageCounts & { metadata: StatsMetadata }) | null;
  readonly newUsers: number | null;
  readonly newUsersMetadata: StatsMetadata | null;
  readonly topScreens: StatsList<{
    path: string;
    pageViews: number | null;
    other: boolean;
  }> | null;
  readonly referrers: StatsList<{
    channel: string;
    sessions: number | null;
    other: boolean;
  }> | null;
}

export function kstDate(now: Date): string {
  return new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function statsDates(range: StatsRange, now: Date) {
  const end = Date.parse(kstDate(now));
  const days = RANGE_DAYS[range];
  const date = (daysAgo: number) =>
    new Date(end - daysAgo * DAY_MS).toISOString().slice(0, 10);
  return {
    current: { startDate: date(days - 1), endDate: date(0) },
    previous: { startDate: date(days * 2 - 1), endDate: date(days) },
  };
}

const usageMetrics = [{ name: "activeUsers" }, { name: "screenPageViews" }];
const metric = (row: Ga4Row | undefined, index = 0) =>
  parseMetricInt(row?.metricValues?.[index]?.value);
const dimension = (row: Ga4Row) => row.dimensionValues?.[0]?.value ?? "";
const counts = (row: Ga4Row | undefined): UsageCounts => ({
  activeUsers: metric(row),
  pageViews: metric(row, 1),
});

export function trendRequests(
  dates: ReturnType<typeof statsDates>,
  listLimit: number,
) {
  const dateRanges = [dates.current];
  return [
    {
      dateRanges: [
        { ...dates.current, name: "current" },
        { ...dates.previous, name: "previous" },
      ],
      metrics: [...usageMetrics, { name: "newUsers" }],
    },
    {
      dateRanges,
      dimensions: [{ name: "date" }],
      metrics: usageMetrics,
      orderBys: [{ dimension: { dimensionName: "date" } }],
    },
    {
      dateRanges,
      dimensions: [{ name: "dateHour" }],
      metrics: [{ name: "activeUsers" }],
      limit: 60 * 24,
    },
    {
      dateRanges,
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: listLimit,
    },
    {
      dateRanges,
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: listLimit,
    },
  ];
}

function list<T>(
  report: Ga4ReportBody | undefined,
  map: (row: Ga4Row) => T | null,
): StatsList<T> | null {
  if (report?.metadata?.timeZone !== STATS_TIME_ZONE) return null;
  return {
    rows: (report.rows ?? []).flatMap((row) => {
      const value = map(row);
      return value === null ? [] : [value];
    }),
    metadata: extractMetadataFlags(report.metadata),
  };
}

export function parseTrends(
  dates: ReturnType<typeof statsDates>,
  reports: readonly (Ga4ReportBody | undefined)[],
  legacyTimeZone: string | undefined,
): StatsTrends {
  const [totals, daily, hourly, screens, referrers] = reports;
  const ga4TimeZone =
    totals?.metadata?.timeZone ??
    reports.find((report) => report?.metadata?.timeZone)?.metadata?.timeZone ??
    legacyTimeZone ??
    null;
  const comparison =
    totals?.metadata?.timeZone === STATS_TIME_ZONE ? totals : undefined;
  const comparisonRows = comparison?.rows ?? [];
  const current = comparisonRows.find((row) => dimension(row) === "current");
  const previous = comparisonRows.find((row) => dimension(row) === "previous");
  const hours = list(hourly, (row) => {
    const label = dimension(row);
    if (!/^\d{8}(?:[01]\d|2[0-3])$/.test(label)) return null;
    return {
      date: label.slice(0, 8),
      hour: Number(label.slice(8)),
      users: metric(row),
    };
  });
  return {
    ...dates.current,
    ga4TimeZone,
    timeZoneMismatch:
      ga4TimeZone === null ? null : ga4TimeZone !== STATS_TIME_ZONE,
    daily: list(daily, (row) => {
      const label = dimension(row);
      if (!/^\d{8}$/.test(label)) return null;
      const date = `${label.slice(0, 4)}-${label.slice(4, 6)}-${label.slice(6)}`;
      return { date, ...counts(row) };
    }),
    hourly: hours && {
      metadata: hours.metadata,
      rows: Array.from({ length: 24 }, (_, hour) => {
        const reported = hours.rows.filter((row) => row.hour === hour);
        const byDate = new Map<string, number | null>();
        for (const row of reported) {
          byDate.set(row.date, byDate.has(row.date) ? null : row.users);
        }
        const values = [...byDate.values()].filter((users) => users !== null);
        return {
          hour,
          averageActiveUsers: values.length
            ? values.reduce((total, users) => total + users, 0) / values.length
            : null,
          reportedDays: values.length,
        };
      }),
    },
    previous:
      comparison && previous
        ? {
            ...dates.previous,
            ...counts(previous),
            metadata: extractMetadataFlags(comparison.metadata),
          }
        : null,
    newUsers: metric(current, 2),
    newUsersMetadata: comparison
      ? extractMetadataFlags(comparison.metadata)
      : null,
    topScreens: list(screens, (row) => {
      const path = dimension(row);
      return path
        ? { path, pageViews: metric(row), other: path === "(other)" }
        : null;
    }),
    referrers: list(referrers, (row) => {
      const channel = dimension(row);
      return channel
        ? { channel, sessions: metric(row), other: channel === "(other)" }
        : null;
    }),
  };
}
