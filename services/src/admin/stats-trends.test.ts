import { GoogleAuth } from "google-auth-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCachedStatsReader, createGa4StatsReader } from "./stats";
import { parseTrends, statsDates, STATS_TIME_ZONE } from "./stats-trends";

const now = new Date("2026-11-14T15:00:00Z");
const metadata = { timeZone: STATS_TIME_ZONE };
const row = (label: string, ...metrics: string[]) => ({
  dimensionValues: [{ value: label }],
  metricValues: metrics.map((value) => ({ value })),
});

afterEach(() => vi.restoreAllMocks());

describe("기간 이용 통계", () => {
  it("KST 자정에 날짜가 바뀌고 직전 기간의 길이와 경계가 맞음", () => {
    expect(
      statsDates("today", new Date(now.getTime() - 1)).current.endDate,
    ).toBe("2026-11-14");
    expect(statsDates("7d", now)).toEqual({
      current: { startDate: "2026-11-09", endDate: "2026-11-15" },
      previous: { startDate: "2026-11-02", endDate: "2026-11-08" },
    });
  });

  it("숫자 숨김과 기타 행을 유지하고 보이지 않는 날짜와 시간의 수를 만들지 않음", () => {
    const threshold = {
      ...metadata,
      subjectToThresholding: true,
      dataLossFromOtherRow: true,
    };
    const trends = parseTrends(
      statsDates("7d", now),
      [
        {
          metadata: threshold,
          rows: [row("current", "12", "40", ""), row("previous", "8", "24")],
        },
        { metadata: threshold, rows: [row("20261114", "", "12")] },
        { metadata: threshold, rows: [row("2026111409", "7")] },
        {
          metadata: threshold,
          rows: [row("(other)", "4"), row("/spots/one", "")],
        },
        { metadata, rows: [row("Organic Search", "6")] },
      ],
      undefined,
    );
    expect(trends.daily?.rows).toEqual([
      { date: "2026-11-14", activeUsers: null, pageViews: 12 },
    ]);
    expect(trends.hourly?.rows[9]).toEqual({
      hour: 9,
      reportedDays: 1,
      averageActiveUsers: null,
    });
    expect(trends.hourly?.rows[10]?.averageActiveUsers).toBeNull();
    expect(trends.topScreens).toMatchObject({
      rows: [
        { path: "(other)", other: true, pageViews: 4 },
        { other: false, pageViews: null },
      ],
      metadata: { thresholding: true, otherRowLoss: true },
    });
    expect(trends.previous).toMatchObject({ activeUsers: 8, pageViews: 24 });
    expect(trends.newUsers).toBeNull();
    expect(trends.referrers?.rows).toEqual([
      { channel: "Organic Search", sessions: 6, other: false },
    ]);
  });

  it("받은 시간별 행만 평균에 쓰고 다른 시간대의 값은 빼 둠", () => {
    const dates = statsDates("7d", now);
    const trends = parseTrends(
      dates,
      [
        undefined,
        {
          metadata: { timeZone: "Etc/UTC" },
          rows: [row("20261114", "1", "2")],
        },
        { metadata, rows: [row("2026111409", "7"), row("2026111509", "10")] },
      ],
      undefined,
    );
    expect(trends.timeZoneMismatch).toBe(true);
    expect(trends.daily).toBeNull();
    expect(trends.hourly?.rows[9]).toEqual({
      hour: 9,
      reportedDays: 2,
      averageActiveUsers: 8.5,
    });
  });

  it("추이 배치가 실패하면 기존 통계를 유지하고 실패한 결과를 캐시하지 않음", async () => {
    vi.spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({
      getAccessToken: async () => ({ token: "stub" }),
    } as Awaited<ReturnType<GoogleAuth["getClient"]>>);
    const fetchFn = vi.fn<typeof fetch>(async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      if (body.requests?.length === 5)
        return new Response(null, { status: 503 });
      const report = { metadata, rows: [row("value", "12", "24")] };
      return Response.json(
        body.requests ? { reports: Array(4).fill(report) } : report,
      );
    });
    const reader = createCachedStatsReader(
      createGa4StatsReader({
        propertyId: "1",
        serviceAccountParam: "/stats",
        region: "test",
        loadKeyJson: async () => "{}",
        fetchFn,
        now: () => now,
      }),
      () => now,
    );
    for (let i = 0; i < 2; i += 1) {
      const response = await reader.read("7d");
      expect(response.period.activeUsers).toBe(12);
      expect(response.trends).toMatchObject({
        daily: null,
        hourly: null,
        previous: null,
      });
      expect(response.cached).toBe(false);
    }
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });
});
