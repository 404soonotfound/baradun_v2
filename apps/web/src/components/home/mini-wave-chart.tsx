"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";

import { useStationHistory } from "@/lib/snapshot/history";
import { type ChartPoint, waveChart } from "@/lib/wave-chart";

// PC 가까운 바다 카드의 24시간 파고 미니 그래프 (Figma 181:871 244×40, BRD-129 · #105 결정 2)
// 데이터·규칙은 상세 WaveChart와 같음: 같은 history.json(한 번만 받아 상세·홈이 같이 씀), 90분 넘는 간격·결측은 끊고 빗금
// 축·라벨 없이 선과 연한 면만. 실패·그릴 값 없음이면 그리지 않음(지난 값을 지금처럼 보이지 않게)
const W = 244;
const H = 40;
const TOP = 4;
const BOTTOM = 38;

export function MiniWaveChart({
  stationId,
  latest,
  nowMs,
}: {
  stationId: string | null; // 파고 측정소 id. 없으면(가까운 관측 없음) 그리지 않음
  latest: ChartPoint | null; // 신선한 지금 파고(지연·결측이면 null)
  nowMs: number;
}) {
  const t = useTranslations("detail.chart");
  const history = useStationHistory(stationId);
  const hatchId = useId();
  // 불러오는 중에만 자리를 잡고, 실패·기록 없음·그릴 값 없음이면 자리째 뺌(카드에 빈칸이 남지 않게)
  if (history.kind === "loading")
    return <span aria-hidden="true" className="block h-10" />;
  if (history.kind !== "ready" || history.history === null) return null;
  const chart = waveChart(history.history.points, nowMs, latest);
  if (chart.kind === "empty") return null;

  // 0부터 시작하는 세로축(상세와 같음). 높이가 작아 0.5m 단위로 올림
  const topM = Math.max(1, Math.ceil(chart.maxV * 2) / 2);
  const x = (ms: number) => ((ms - chart.from) / (chart.to - chart.from)) * W;
  const y = (m: number) => BOTTOM - (m / topM) * (BOTTOM - TOP);
  const label = chart.current
    ? t("label", { value: chart.current.v, max: chart.maxV })
    : t("labelNoNow", { max: chart.maxV });

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block h-10 w-full"
    >
      <defs>
        <pattern
          id={hatchId}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line
            x1="0"
            y1="0"
            x2="0"
            y2="6"
            strokeWidth="2"
            className="stroke-border-strong"
          />
        </pattern>
      </defs>
      {chart.gaps.map((gap) => (
        <rect
          key={gap.from}
          x={x(gap.from)}
          y={TOP}
          width={Math.max(2, x(gap.to) - x(gap.from))}
          height={BOTTOM - TOP}
          fill={`url(#${hatchId})`}
          opacity={0.6}
        />
      ))}
      {chart.runs.map((run) => {
        const first = run[0]!;
        const end = run.at(-1)!;
        if (run.length === 1) {
          return (
            <circle
              key={first.t}
              cx={x(first.t)}
              cy={y(first.v)}
              r={2}
              className="fill-chart"
            />
          );
        }
        const line = run
          .map(
            (point, i) =>
              `${i ? "L" : "M"}${x(point.t).toFixed(1)} ${y(point.v).toFixed(1)}`,
          )
          .join("");
        return (
          <g key={first.t}>
            <path
              d={`${line}L${x(end.t).toFixed(1)} ${H}L${x(first.t).toFixed(1)} ${H}Z`}
              className="fill-chart opacity-15"
            />
            <path
              d={line}
              fill="none"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              className="stroke-chart"
            />
          </g>
        );
      })}
    </svg>
  );
}
