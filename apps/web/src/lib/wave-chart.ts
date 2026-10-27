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
    };

// 받은 점 → 차트. 읽을 수 없는 시각·미래 시각·24시간 밖 점은 버림
export function waveChart(
  points: readonly { t: unknown; v: unknown }[],
  nowMs: number,
): WaveChart {
  if (!Number.isFinite(nowMs)) return { kind: "empty" };
  const from = nowMs - CHART_SPAN_MS;
  const valid = points
    .flatMap((point) => {
      if (!isTime(point.t)) return [];
      const t = Date.parse(point.t);
      if (t < from || t > nowMs + CLOCK_TOLERANCE_MS) return [];
      if (typeof point.v !== "number" || !Number.isFinite(point.v)) return [];
      if (point.v < 0) return [];
      return [{ t, v: point.v }];
    })
    .sort((a, b) => a.t - b.t);
  if (valid.length === 0) return { kind: "empty" };

  // null 점은 위에서 빠져서, 그 자리는 이웃 값 사이 간격이 커지는 것으로 드러남(1시간 간격 → 2시간)
  const runs: ChartPoint[][] = [];
  for (const point of valid) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (run && last && point.t - last.t <= CHART_GAP_MS) run.push(point);
    else runs.push([point]);
  }

  const gaps: ChartRange[] = [];
  const first = valid[0]!;
  const end = valid.at(-1)!;
  if (first.t - from > CHART_GAP_MS) gaps.push({ from, to: first.t });
  for (let i = 1; i < runs.length; i += 1) {
    gaps.push({ from: runs[i - 1]!.at(-1)!.t, to: runs[i]![0]!.t });
  }
  if (nowMs - end.t > CHART_GAP_MS) gaps.push({ from: end.t, to: nowMs });

  return {
    kind: "ready",
    from,
    to: nowMs,
    maxV: Math.max(...valid.map((point) => point.v)),
    runs,
    gaps,
  };
}
