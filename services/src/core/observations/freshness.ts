import type { Metric } from "@baradun/contracts";
import { parseUtcIso } from "../warnings/time";
import { OBSERVATION_POLICY } from "./policy";
import type { MetricKey } from "./values";

// 측정기별 마지막 정상값과 지표 신선도 (결정 기록 11장 B4·10/22 BRD-19)
// 무효 값(null)·미래 관측은 마지막 정상값을 덮어쓰거나 observedAt을 갱신하지 않음
// 측정기 없음(none)은 여기서 만들지 않음 → 해변 조립(부품 4)이 정함

export interface Reading {
  readonly value: number;
  readonly observedAt: string; // UTC ISO
}

// 측정기 번호 → 지표별 마지막 정상값. 저장소 State에 그대로 넣을 수 있는 모양
// Partial: 아직 정상값을 한 번도 못 받은 지표는 칸이 없음
export type StationReadings = Readonly<
  Record<string, Readonly<Partial<Record<MetricKey, Reading>>>>
>;

// sea_obs·kma_buoy 읽기 결과 줄을 함께 받음. 해당 출처가 주지 않는 지표는 칸이 없음
export type ObservationRow = {
  readonly stationId: string;
  readonly observedAt: string;
} & Readonly<Partial<Record<MetricKey, number | null>>>;

const METRIC_KEYS: readonly MetricKey[] = [
  "waveHeight",
  "wavePeriod",
  "waveDirection",
  "waterTemp",
  "wind",
];

const UNIT: Record<MetricKey, Metric["unit"]> = {
  waveHeight: "m",
  wavePeriod: "s",
  waveDirection: "deg",
  waterTemp: "°C",
  wind: "m/s",
};

// 기준 시각은 서버가 정함 → 형식이 틀리면 데이터 문제가 아니라 코드 오류라 멈춤
function parseNow(now: string): number {
  const nowMs = parseUtcIso(now);
  if (nowMs === null) throw new RangeError(`기준 시각 형식 오류: ${now}`);
  return nowMs;
}

// 이전 마지막 정상값에 새 줄을 더함. 지표마다 관측 시각이 더 늦을 때만 바꿈
// 같은 시각이면 이전 값 유지(같은 관측을 두 번 받은 경우)
export function mergeReadings(
  previous: StationReadings,
  rows: readonly ObservationRow[],
  now: string,
): StationReadings {
  const nowMs = parseNow(now);
  // { ...previous }: 이전 객체를 복사(원본은 바꾸지 않음)
  const next: Record<string, Partial<Record<MetricKey, Reading>>> = {
    ...previous,
  };
  for (const row of rows) {
    const observedMs = parseUtcIso(row.observedAt);
    // 서버 시각보다 늦은 관측은 무효(허용 오차 없음, 10/22 ②)
    if (observedMs === null || observedMs > nowMs) continue;
    const station = { ...next[row.stationId] };
    for (const key of METRIC_KEYS) {
      const value = row[key];
      // undefined: 이 출처에 없는 지표, null: 무효 값 → 둘 다 이전 값 유지
      if (value === undefined || value === null) continue;
      const last = station[key];
      if (last && (parseUtcIso(last.observedAt) ?? 0) >= observedMs) continue;
      station[key] = { value, observedAt: row.observedAt };
    }
    next[row.stationId] = station;
  }
  return next;
}

// 배정된 측정기가 있는 지표의 공개 계약 모양
// reading 없음 = 측정기는 있는데 정상값을 아직 못 받음 → none이 아니라 delayed(수집 실패를 '측정기 없음'으로 바꾸지 않음)
// 경계: 90분 00초까지 fresh, 넘으면 delayed. delayed여도 값·시각은 남김(화면이 expiresAt으로 숨김)
export function toMetric(
  key: MetricKey,
  reading: Reading | undefined,
  now: string,
): Metric {
  const nowMs = parseNow(now);
  const base = { unit: UNIT[key], nextExpectedAt: null }; // nextExpectedAt은 출시에서 항상 null(10/22 ①)
  const observedMs = reading ? parseUtcIso(reading.observedAt) : null;
  if (!reading || observedMs === null || observedMs > nowMs) {
    return {
      ...base,
      value: null,
      observedAt: null,
      state: "delayed",
      expiresAt: null,
    };
  }
  const expiresMs = observedMs + OBSERVATION_POLICY.expiryMs[key];
  return {
    ...base,
    value: reading.value,
    observedAt: reading.observedAt,
    state: nowMs > expiresMs ? "delayed" : "fresh",
    expiresAt: new Date(expiresMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
}
