import { formatUtcIso, parseUtcIso } from "../warnings/time";
import { parseNow, type ObservationRow } from "./freshness";

// 파고 24시간 이력 (결정 기록 11장 B2·10/23 BRD-61 ①, BRD-94 2026-10-26 사용자 결정)
// 저장: 측정기별 원래 측정값 [관측 시각(epoch초), 파고(m)]. 버킷으로 묶지 않음 → 점 규칙을 바꿔도 저장 형식 그대로
// 게시: 정시 점 t마다 t − 60분 < 관측 시각 ≤ t 안의 마지막 측정, 없으면 null
// 평균·보간·이전 값 이어 쓰기는 하지 않음. 점의 시각은 버킷 시각(정시)이라 실제 관측 시각과 최대 59분 차이

const HOUR_MS = 60 * 60 * 1000;
export const HISTORY_POINTS = 25; // 최근 24시간, 양 끝 포함(계약 maxItems 25)

// [관측 시각(epoch초), 파고(m)]. 관측 시각 오름차순, 같은 시각은 하나만
export type HistoryEntry = readonly [number, number];
export type WaveHistory = Readonly<Record<string, readonly HistoryEntry[]>>;

// 첫 점 시각(epoch ms). 마지막 점 = 기준 시각을 정시로 내린 시각, 그로부터 1시간씩 24번 앞
function firstPointMs(nowMs: number): number {
  return Math.floor(nowMs / HOUR_MS) * HOUR_MS - (HISTORY_POINTS - 1) * HOUR_MS;
}

// 첫 점의 구간 시작(이 시각 이하는 어느 점에도 들어가지 않음 → 버림)
function cutoffMs(nowMs: number): number {
  return firstPointMs(nowMs) - HOUR_MS;
}

// 이전 이력에 새 줄의 파고를 더하고 24시간 범위 밖 값을 버림
// 무효 값(null)·미래 관측은 넣지 않음. 같은 관측 시각이면 이전 값 유지(mergeReadings와 같은 기준)
// 이전 기록의 미래 시각 값도 버림(시계가 어긋났던 값이 그 시각 점을 차지하지 않게 함)
export function mergeWaveHistory(
  previous: WaveHistory,
  rows: readonly ObservationRow[],
  now: string,
): WaveHistory {
  const nowMs = parseNow(now);
  const cutoff = cutoffMs(nowMs);
  const keep = (sec: number) => sec * 1000 > cutoff && sec * 1000 <= nowMs;
  const byStation = new Map<string, Map<number, number>>();
  for (const [stationId, entries] of Object.entries(previous)) {
    const times = new Map<number, number>();
    for (const [sec, value] of entries) {
      if (keep(sec) && !times.has(sec)) times.set(sec, value);
    }
    byStation.set(stationId, times);
  }
  for (const row of rows) {
    const value = row.waveHeight;
    const observedMs = parseUtcIso(row.observedAt);
    if (value === undefined || value === null || observedMs === null) continue;
    const sec = Math.floor(observedMs / 1000);
    if (!keep(sec)) continue;
    const times = byStation.get(row.stationId) ?? new Map<number, number>();
    if (!times.has(sec)) times.set(sec, value);
    byStation.set(row.stationId, times);
  }
  const next: Record<string, HistoryEntry[]> = {};
  for (const [stationId, times] of [...byStation].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (times.size === 0) continue;
    next[stationId] = [...times].sort(([a], [b]) => a - b);
  }
  return next;
}

// 저장된 값 → 이력. 모양이 틀린 측정 하나는 그 측정만 버림(그 점은 null로 남음, 값을 지어내지 않음)
// 이력은 분류에 쓰지 않으므로 기록이 없거나 깨져도 게시를 멈추지 않음
// onDropped: 버린 수(깨진 기록·측정기 칸은 1로 셈). 기록 없음(null)은 버린 것이 아님 → 부르지 않음
export function readWaveHistory(
  value: unknown,
  onDropped?: (count: number) => void,
): WaveHistory {
  if (value === null) return {};
  const stations =
    typeof value === "object" && !Array.isArray(value)
      ? (value as { stations?: unknown }).stations
      : undefined;
  if (
    typeof stations !== "object" ||
    stations === null ||
    Array.isArray(stations)
  ) {
    onDropped?.(1);
    return {};
  }
  const history: Record<string, HistoryEntry[]> = {};
  let dropped = 0;
  for (const [stationId, entries] of Object.entries(stations)) {
    if (!Array.isArray(entries)) {
      dropped += 1;
      continue;
    }
    const valid = entries.filter(
      (entry): entry is [number, number] =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        Number.isInteger(entry[0]) &&
        typeof entry[1] === "number" &&
        Number.isFinite(entry[1]) &&
        entry[1] >= 0,
    );
    dropped += entries.length - valid.length;
    if (valid.length > 0) history[stationId] = valid;
  }
  if (dropped > 0) onDropped?.(dropped);
  return history;
}

// 게시 한 번에 쓰는 점 시각 틀. 측정소마다 같으므로 한 번만 만들어 넘김
export interface HistoryFrame {
  readonly firstMs: number;
  readonly times: readonly string[]; // 25개 점의 t(UTC ISO)
}

export function historyFrame(now: string): HistoryFrame {
  const firstMs = firstPointMs(parseNow(now));
  return {
    firstMs,
    times: Array.from({ length: HISTORY_POINTS }, (_, i) =>
      formatUtcIso(firstMs + i * HOUR_MS),
    ),
  };
}

// 측정기 하나의 25개 점. 점마다 구간 (t − 60분, t] 안의 마지막 측정
// 측정마다 들어갈 점 = 관측 시각을 정시로 올린 시각(정시 측정은 그 정시 점) → 한 번 훑어 점마다 가장 늦은 측정만 남김
export function historyPoints(
  entries: readonly HistoryEntry[],
  frame: HistoryFrame,
): { t: string; v: number | null }[] {
  const { firstMs } = frame;
  const latest: { sec: number; v: number }[] = [];
  for (const [sec, value] of entries) {
    const index =
      (Math.ceil((sec * 1000) / HOUR_MS) * HOUR_MS - firstMs) / HOUR_MS;
    if (index < 0 || index >= HISTORY_POINTS) continue;
    const current = latest[index];
    if (current === undefined || sec > current.sec) {
      latest[index] = { sec, v: value };
    }
  }
  return frame.times.map((t, i) => ({ t, v: latest[i]?.v ?? null }));
}
