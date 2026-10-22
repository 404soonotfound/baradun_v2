import { readFileSync } from "node:fs";
import type { Beach } from "@baradun/contracts";
import { describe, expect, it } from "vitest";
import { buildBeachMetrics, isWaveHeightDelayed } from "./beach-metrics";

// 해변별 관측 조립 (BRD-19 부품 4, 결정 기록 11장 B2·B4)
// 측정소 배정은 실제 data/beaches/b0001.json(연곡 파고부이·강릉 해양기상부이)
const beach = JSON.parse(
  readFileSync(
    new URL("../../../../data/beaches/b0001.json", import.meta.url),
    "utf8",
  ),
) as Beach;
const NOW = "2026-10-21T00:00:00Z";

const freshReadings = {
  "22451": {
    waveHeight: { value: 0.6, observedAt: "2026-10-20T23:30:00Z" },
    waterTemp: { value: 19.7, observedAt: "2026-10-20T23:30:00Z" },
  },
  "22520": {
    wind: { value: 3.6, observedAt: "2026-10-20T23:30:00Z" },
    wavePeriod: { value: 8.2, observedAt: "2026-10-20T23:50:00Z" },
    waveDirection: { value: 81, observedAt: "2026-10-20T23:50:00Z" },
  },
};

describe("buildBeachMetrics", () => {
  it("지표마다 배정된 측정소의 값을 붙임", () => {
    const metrics = buildBeachMetrics(beach.stations, freshReadings, NOW);
    expect(metrics.waveHeight).toMatchObject({ value: 0.6, state: "fresh" });
    expect(metrics.wavePeriod).toMatchObject({ value: 8.2, state: "fresh" });
    expect(metrics.wind).toMatchObject({ value: 3.6, state: "fresh" });
    expect(isWaveHeightDelayed(metrics)).toBe(false);
  });

  it("배정된 측정소가 없으면 none(값·시각 모두 null)", () => {
    const stations = { ...beach.stations, wavePeriod: null, waveHeight: null };
    const metrics = buildBeachMetrics(stations, freshReadings, NOW);
    expect(metrics.wavePeriod).toEqual({
      value: null,
      unit: "s",
      observedAt: null,
      state: "none",
      nextExpectedAt: null,
      expiresAt: null,
    });
    // 파고 측정소 없음은 분류에 영향 없음
    expect(isWaveHeightDelayed(metrics)).toBe(false);
  });

  it("측정소는 있는데 값을 못 받으면 none이 아니라 delayed", () => {
    const metrics = buildBeachMetrics(beach.stations, {}, NOW);
    for (const metric of Object.values(metrics)) {
      expect(metric.state).toBe("delayed");
      expect(metric.value).toBeNull();
    }
    expect(isWaveHeightDelayed(metrics)).toBe(true);
  });

  it("파고 외 지표가 늦어도 분류용 관측 지연은 아님", () => {
    // 파고 30분 전, 파주기·파향·바람·수온은 기준을 넘김
    const metrics = buildBeachMetrics(
      beach.stations,
      {
        "22451": {
          waveHeight: { value: 0.6, observedAt: "2026-10-20T23:30:00Z" },
          waterTemp: { value: 19.7, observedAt: "2026-10-20T22:00:00Z" },
        },
        "22520": {
          wind: { value: 3.6, observedAt: "2026-10-20T22:00:00Z" },
          wavePeriod: { value: 8.2, observedAt: "2026-10-20T22:50:00Z" },
          waveDirection: { value: 81, observedAt: "2026-10-20T22:50:00Z" },
        },
      },
      NOW,
    );
    expect(metrics.wavePeriod.state).toBe("delayed");
    expect(metrics.waterTemp.state).toBe("delayed");
    expect(isWaveHeightDelayed(metrics)).toBe(false);
  });

  it("파고가 90분을 넘으면 분류용 관측 지연", () => {
    const metrics = buildBeachMetrics(
      beach.stations,
      {
        ...freshReadings,
        "22451": {
          waveHeight: { value: 0.6, observedAt: "2026-10-20T22:29:00Z" },
        },
      },
      NOW,
    );
    expect(isWaveHeightDelayed(metrics)).toBe(true);
  });
});
