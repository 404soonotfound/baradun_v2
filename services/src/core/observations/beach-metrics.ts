import type { Beach, BeachStatus } from "@baradun/contracts";
import {
  METRIC_KEYS,
  METRIC_UNIT,
  toMetric,
  type StationReadings,
} from "./freshness";
import type { MetricKey } from "./values";

// 해변별 관측 조립 (결정 기록 11장 B2·B4, 9장 분류 규칙)
// 측정소 배정은 data/beaches의 stations(같은 해상 특보구역 20km 안, 72시간 미수신 측정기 제외를 거친 결과)를 그대로 씀
// 여기서 거리·구역을 다시 따지지 않음

export type BeachStations = Beach["stations"];
export type BeachMetrics = BeachStatus["observation"]["metrics"];

// 배정된 측정소가 없으면(null) none → 화면은 값 자리에 '가까운 관측 없음', 분류 영향 없음
// 있으면 그 측정소의 마지막 정상값으로 fresh·delayed(정상값이 없어도 none으로 바꾸지 않음)
export function buildBeachMetrics(
  stations: BeachStations,
  readings: StationReadings,
  now: string,
): BeachMetrics {
  // 아래 반복문이 다섯 지표를 모두 채움
  const metrics = {} as Record<MetricKey, BeachMetrics[MetricKey]>;
  for (const key of METRIC_KEYS) {
    const station = stations[key];
    metrics[key] = station
      ? toMetric(key, readings[station.id]?.[key], now)
      : {
          value: null,
          unit: METRIC_UNIT[key],
          observedAt: null,
          state: "none",
          nextExpectedAt: null,
          expiresAt: null,
        };
  }
  return metrics;
}

// 분류에 쓰는 관측 지연은 파고뿐(B4). 다른 지표가 늦어도 false
// 측정소 없음(none)도 분류에 영향 없음 → false
export function isWaveHeightDelayed(metrics: BeachMetrics): boolean {
  return metrics.waveHeight.state === "delayed";
}
