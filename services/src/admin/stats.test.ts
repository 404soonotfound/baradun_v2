import { describe, expect, it, vi } from "vitest";
import {
  createCachedStatsReader,
  createGa4StatsReader,
  extractBeachSlug,
  parseDevicesReport,
  parseLanguagesReport,
  parseMetricInt,
  parseRealtimeReport,
  parseStatsRange,
  parseSummaryReport,
  parseTopBeachesReport,
  unconfiguredStats,
  type StatsReader,
} from "./stats";

describe("이용 통계 기간·경로·숫자 파싱 (#333)", () => {
  it("기간 파라미터를 파싱하고 알 수 없는 값은 null", () => {
    expect(parseStatsRange(undefined)).toBe("7d");
    expect(parseStatsRange("")).toBe("7d");
    expect(parseStatsRange("today")).toBe("today");
    expect(parseStatsRange("7d")).toBe("7d");
    expect(parseStatsRange("28d")).toBe("28d");
    expect(parseStatsRange("60d")).toBe("60d");
    expect(parseStatsRange("90d")).toBeNull();
  });

  it("/spots/[slug]와 /en/spots/[slug]에서 slug를 추출하고 그 외 경로는 null", () => {
    expect(extractBeachSlug("/spots/haeundae")).toBe("haeundae");
    expect(extractBeachSlug("/en/spots/gwangalli/")).toBe("gwangalli");
    expect(extractBeachSlug("/spots/gyeongpo?tab=wave")).toBe("gyeongpo");
    expect(extractBeachSlug("/")).toBeNull();
    expect(extractBeachSlug("/about/data")).toBeNull();
  });

  it("빈칸·누락 숫자는 0으로 바꾸지 않고 null로 유지함(E8)", () => {
    expect(parseMetricInt(undefined)).toBeNull();
    expect(parseMetricInt("")).toBeNull();
    expect(parseMetricInt("  ")).toBeNull();
    expect(parseMetricInt("0")).toBe(0);
    expect(parseMetricInt("42")).toBe(42);
  });
});

describe("GA4 응답 및 metadata 제한 파싱 (E8)", () => {
  it("실시간·기간 리포트에서 빈 칸은 null로 두고, metadata 제한 플래그만 정확히 추출함", () => {
    expect(parseRealtimeReport({})).toEqual({
      status: "ok",
      activeUsers: null,
      pageViews: null,
    });

    const summary = parseSummaryReport({
      rows: [{ metricValues: [{ value: "120" }, { value: "" }] }],
      metadata: { subjectToThresholding: true },
    });
    expect(summary).toEqual({
      activeUsers: 120,
      pageViews: null,
      metadata: {
        thresholding: true,
        sampling: false,
        otherRowLoss: false,
      },
    });

    const beaches = parseTopBeachesReport({
      rows: [
        {
          dimensionValues: [{ value: "/spots/haeundae" }],
          metricValues: [{ value: "88" }],
        },
        {
          dimensionValues: [{ value: "/spots/unknown-slug" }],
          metricValues: [{ value: "" }],
        },
      ],
      metadata: {
        samplingMetadatas: [{ samplesReadCount: "1000" }],
      },
    });
    expect(beaches.rows).toEqual([
      { path: "/spots/haeundae", slug: "haeundae", pageViews: 88 },
      { path: "/spots/unknown-slug", slug: "unknown-slug", pageViews: null },
    ]);
    expect(beaches.metadata).toEqual({
      thresholding: false,
      sampling: true,
      otherRowLoss: false,
    });

    const devices = parseDevicesReport({
      rows: [{ dimensionValues: [{ value: "mobile" }], metricValues: [{ value: "90" }] }],
      metadata: { dataLossFromOtherRow: true },
    });
    expect(devices.metadata.otherRowLoss).toBe(true);

    const languages = parseLanguagesReport({
      rows: [{ dimensionValues: [{ value: "ko" }], metricValues: [{ value: "100" }] }],
    });
    expect(languages.metadata).toEqual({
      thresholding: false,
      sampling: false,
      otherRowLoss: false,
    });
  });
});

describe("캐시 및 실패 경로", () => {
  it("TTL 안에서는 캐시된 응답(cached: true)을 돌려주어 호출량을 절약하고 만료 후 다시 부름", async () => {
    let ms = 1_700_000_000_000;
    const now = () => new Date(ms);
    const read = vi.fn<StatsReader["read"]>(async (range) => ({
      ...unconfiguredStats(range, now()),
      configured: true,
      realtime: { status: "ok", activeUsers: 5, pageViews: 10 },
    }));
    const cached = createCachedStatsReader({ read }, now, 60_000);

    const first = await cached.read("7d");
    expect(first.cached).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);

    ms += 30_000;
    const second = await cached.read("7d");
    expect(second.cached).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);

    ms += 31_000;
    const third = await cached.read("7d");
    expect(third.cached).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("실시간·기간이 모두 실패한 응답은 캐시하지 않고 재시도함", async () => {
    let ms = 1_700_000_000_000;
    const now = () => new Date(ms);
    const read = vi.fn<StatsReader["read"]>(async (range) => ({
      ...unconfiguredStats(range, now()),
      configured: true,
    }));
    const cached = createCachedStatsReader({ read }, now, 60_000);

    await cached.read("today");
    ms += 5_000;
    await cached.read("today");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("SSM 키 로딩이 실패해도 예외를 던지지 않고 unavailable 상태를 반환함", async () => {
    const reader = createGa4StatsReader({
      propertyId: "12345",
      serviceAccountParam: "/baradun/v2/ga4/key",
      region: "ap-northeast-2",
      now: () => new Date("2026-11-13T00:00:00.000Z"),
      loadKeyJson: async () => {
        throw new Error("ParameterNotFound");
      },
    });
    const res = await reader.read("7d");
    expect(res.configured).toBe(true);
    expect(res.realtime.status).toBe("unavailable");
    expect(res.period.status).toBe("unavailable");
    expect(res.events[0]).toEqual({ name: "page_view", status: "collecting" });
  });
});
