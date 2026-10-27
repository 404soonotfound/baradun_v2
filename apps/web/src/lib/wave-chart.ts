import { CLOCK_TOLERANCE_MS, isTime } from "@/lib/snapshot/clock";

// 24시간 파고 차트 계산 (노션 3장 WaveChart · 결정 기록 11장 10/27 '화면 잔여 결정', BRD-32)
// 이웃 점 간격이 90분을 넘으면 선을 잇지 않고 끊긴 구간(빗금)으로 둠. null = 측정값 없음(빗금).
// 값을 지어내지 않음: 사이를 채우거나 0으로 그리지 않음. 그릴 값이 하나도 없으면 'empty'

export const CHART_SPAN_MS = 24 * 60 * 60_000;
export const CHART_GAP_MS = 90 * 60_000;

export type ChartPoint = { t: number; v: number };
export type ChartRange = { from: number; to: number };

export type WaveChart =
  | { kind: "empty" } // 그릴 측정값이 없음 → '측정값이 없어 그리지 않아요'
  | {
      kind: "ready";
      from: number; // 가로축 시작(지금 - 24시간)
      to: number; // 가로축 끝(지금)
      maxV: number;
      // 선으로 이을 점 묶음. 점 하나짜리 묶음은 점으로만
      runs: ChartPoint[][];
      // 빗금 구간: 측정값 없음·간격 90분 초과
      gaps: ChartRange[];
      // 현재값(점·라벨). 가장 최근 점이 결측이거나 마지막 값이 90분보다 오래되면 null(지난 값을 '지금'으로 보이지 않게)
      current: ChartPoint | null;
    };

// 받은 점 → 차트. 읽을 수 없는 시각·미래 시각·24시간 밖 점은 버림
export function waveChart(
  points: readonly { t: unknown; v: unknown }[],
  nowMs: number,
): WaveChart {
  if (!Number.isFinite(nowMs)) return { kind: "empty" };
  const from = nowMs - CHART_SPAN_MS;
  // 시각을 읽을 수 있고 24시간 안인 점만. 값이 null·읽을 수 없는 수·음수면 결측(v: null)으로 남김
  // (계약: null = 측정값 없음 → 빗금. 버리면 끝의 결측이 사라져 지난 값이 '지금'처럼 보임)
  const placed = points
    .flatMap((point) => {
      if (!isTime(point.t)) return [];
      const t = Date.parse(point.t);
      if (t < from || t > nowMs + CLOCK_TOLERANCE_MS) return [];
      const v =
        typeof point.v === "number" && Number.isFinite(point.v) && point.v >= 0
          ? point.v
          : null;
      return [{ t, v }];
    })
    .sort((a, b) => a.t - b.t);
  const valid = placed.filter((point): point is ChartPoint => point.v !== null);
  if (valid.length === 0) return { kind: "empty" };

  // 선은 결측 점에서 끊고, 이웃 값 간격이 90분을 넘어도 끊음
  const runs: ChartPoint[][] = [];
  let broken = true;
  for (const point of placed) {
    if (point.v === null) {
      broken = true;
      continue;
    }
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (!broken && run && last && point.t - last.t <= CHART_GAP_MS) {
      run.push({ t: point.t, v: point.v });
    } else {
      runs.push([{ t: point.t, v: point.v }]);
    }
    broken = false;
  }

  const gaps: ChartRange[] = [];
  const first = valid[0]!;
  const end = valid.at(-1)!;
  // 앞쪽: 첫 값 전에 결측 점이 있거나 24시간 시작에서 90분 넘게 비면 빗금
  if (placed[0]!.v === null || first.t - from > CHART_GAP_MS) {
    gaps.push({ from, to: first.t });
  }
  for (let i = 1; i < runs.length; i += 1) {
    gaps.push({ from: runs[i - 1]!.at(-1)!.t, to: runs[i]![0]!.t });
  }
  // 끝쪽: 가장 최근 점이 결측이거나 마지막 값이 90분보다 오래됐으면 지금까지 빗금, 현재값 없음
  const latestMissing = placed.at(-1)!.v === null;
  const trailing = latestMissing || nowMs - end.t > CHART_GAP_MS;
  if (trailing) gaps.push({ from: end.t, to: nowMs });

  return {
    kind: "ready",
    from,
    to: nowMs,
    maxV: Math.max(...valid.map((point) => point.v)),
    runs,
    gaps,
    current: trailing ? null : end,
  };
}
