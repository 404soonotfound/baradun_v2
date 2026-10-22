import { describe, expect, it } from "vitest";
import { mergeReadings, toMetric } from "./freshness";

// 마지막 정상값·신선도 (BRD-19 부품 3, 결정 기록 11장 B4·10/22)
const NOW = "2026-10-21T00:00:00Z";

describe("mergeReadings", () => {
  it("측정기·지표마다 가장 늦은 정상값을 남김", () => {
    const { readings: merged } = mergeReadings(
      {},
      [
        {
          stationId: "22523",
          observedAt: "2026-10-20T23:10:00Z",
          wavePeriod: 9.4,
        },
        {
          stationId: "22523",
          observedAt: "2026-10-20T23:50:00Z",
          wavePeriod: 8.2,
        },
        {
          stationId: "22523",
          observedAt: "2026-10-20T23:30:00Z",
          wavePeriod: 7.1,
        },
      ],
      NOW,
    );
    expect(merged).toEqual({
      "22523": {
        wavePeriod: { value: 8.2, observedAt: "2026-10-20T23:50:00Z" },
      },
    });
  });

  it("무효 값(null)은 이전 정상값을 덮어쓰지 않음", () => {
    const previous = {
      "22489": {
        waveHeight: { value: 0.7, observedAt: "2026-10-20T22:00:00Z" },
      },
    };
    const { readings: merged } = mergeReadings(
      previous,
      [
        {
          stationId: "22489",
          observedAt: "2026-10-20T23:00:00Z",
          waveHeight: null,
        },
      ],
      NOW,
    );
    expect(merged).toEqual(previous);
  });

  it("서버 시각보다 늦은 관측은 버리고 셈(허용 오차 없음)", () => {
    const result = mergeReadings(
      {},
      [
        {
          stationId: "22520",
          observedAt: "2026-10-21T00:00:01Z",
          waveHeight: 0.7,
        },
      ],
      NOW,
    );
    expect(result).toEqual({ readings: {}, futureRows: 1 });
  });

  it("출처마다 다른 지표를 같은 측정기에 합침", () => {
    const { readings: merged } = mergeReadings(
      {},
      [
        {
          stationId: "22520",
          observedAt: "2026-10-20T23:00:00Z",
          waveHeight: 0.7,
          wind: 3.6,
        },
        {
          stationId: "22520",
          observedAt: "2026-10-20T23:20:00Z",
          wavePeriod: 6,
          waveDirection: 81,
        },
      ],
      NOW,
    );
    expect(Object.keys(merged["22520"] ?? {}).sort()).toEqual([
      "waveDirection",
      "waveHeight",
      "wavePeriod",
      "wind",
    ]);
  });

  it("이전보다 오래된 관측은 버림", () => {
    const previous = {
      "22520": { wind: { value: 3.6, observedAt: "2026-10-20T23:00:00Z" } },
    };
    const { readings: merged } = mergeReadings(
      previous,
      [{ stationId: "22520", observedAt: "2026-10-20T22:00:00Z", wind: 9.9 }],
      NOW,
    );
    expect(merged).toEqual(previous);
  });

  it("이전 값의 시각이 미래면 믿지 않고 새 정상값으로 바꿈", () => {
    const previous = {
      "22520": { wind: { value: 3.6, observedAt: "2026-10-21T00:30:00Z" } },
    };
    const { readings: merged } = mergeReadings(
      previous,
      [{ stationId: "22520", observedAt: "2026-10-20T23:50:00Z", wind: 4.1 }],
      NOW,
    );
    expect(merged).toEqual({
      "22520": { wind: { value: 4.1, observedAt: "2026-10-20T23:50:00Z" } },
    });
  });
});

describe("toMetric", () => {
  it("파고는 90분 00초까지 fresh, 넘으면 delayed(값은 남김)", () => {
    const reading = { value: 0.8, observedAt: "2026-10-20T22:30:00Z" };
    expect(toMetric("waveHeight", reading, NOW)).toEqual({
      value: 0.8,
      unit: "m",
      observedAt: "2026-10-20T22:30:00Z",
      state: "fresh",
      nextExpectedAt: null,
      expiresAt: "2026-10-21T00:00:00Z",
    });
    expect(
      toMetric("waveHeight", reading, "2026-10-21T00:00:01Z"),
    ).toMatchObject({
      value: 0.8,
      state: "delayed",
    });
  });

  it("파주기·파향은 60분 기준", () => {
    const reading = { value: 6, observedAt: "2026-10-20T23:00:00Z" };
    expect(toMetric("wavePeriod", reading, NOW)).toMatchObject({
      unit: "s",
      state: "fresh",
      expiresAt: "2026-10-21T00:00:00Z",
    });
    expect(
      toMetric("waveDirection", reading, "2026-10-21T00:00:01Z"),
    ).toMatchObject({
      unit: "deg",
      state: "delayed",
    });
  });

  it("측정기는 있는데 정상값이 없으면 none이 아니라 delayed", () => {
    expect(toMetric("waterTemp", undefined, NOW)).toEqual({
      value: null,
      unit: "°C",
      observedAt: null,
      state: "delayed",
      nextExpectedAt: null,
      expiresAt: null,
    });
  });

  it("저장된 값의 관측 시각이 미래면 믿지 않음", () => {
    const reading = { value: 3.1, observedAt: "2026-10-21T00:10:00Z" };
    expect(toMetric("wind", reading, NOW)).toMatchObject({
      value: null,
      state: "delayed",
    });
  });

  it("기준 시각 형식이 틀리면 멈춤", () => {
    expect(() => toMetric("wind", undefined, "2026-10-21 09:00")).toThrow(
      RangeError,
    );
  });

  it("관측 시각에 밀리초가 있어도 state와 expiresAt이 같은 시각을 씀", () => {
    const reading = { value: 0.8, observedAt: "2026-10-20T22:30:00.500Z" };
    expect(
      toMetric("waveHeight", reading, "2026-10-21T00:00:00.300Z"),
    ).toMatchObject({ state: "delayed", expiresAt: "2026-10-21T00:00:00Z" });
  });
});
