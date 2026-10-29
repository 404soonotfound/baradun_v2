"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";

import { KmaSourceNote } from "@/components/source-note";
import { Skeleton } from "@/components/ui/skeleton";
import { kstStamp } from "@/lib/snapshot/clock";
import { useStationHistory } from "@/lib/snapshot/history";
import { type ChartPoint, waveChart } from "@/lib/wave-chart";

// 24시간 파고 (BRD-32 · 노션 3장 WaveChart, 10/27 결정 ⑥)
// 0부터 시작하는 축(0.5m 간격), 선 + 연한 면, 현재값 점과 값 라벨, x축 "24시간 전 · 12시간 전 · 지금".
// 참고 기준선 없음. 결측·간격 90분 초과 구간은 빗금. 값이 없으면 그리지 않음(값을 지어내지 않음)

const W = 322;
const H = 132;
const LEFT = 30;
const RIGHT = 12;
const TOP = 16;
const BOTTOM = 112;

export function WaveChart({
  stationId,
  latest,
  nowMs,
  sourceShown,
}: {
  stationId: string | null; // 파고 측정소 id. 없으면(20km 밖) 기록도 없음
  latest: ChartPoint | null; // 실제 관측 시각으로 검증된 지금 파고. 지연·결측이면 null → 현재값 숨김
  nowMs: number;
  sourceShown: boolean; // 그린 그래프에 기상청 출처 캡션을 둘지(개발용 예시면 false)
}) {
  const t = useTranslations("detail.chart");
  const history = useStationHistory(stationId);
  const hatchId = useId();

  function body() {
    if (history.kind === "loading") {
      return (
        <div role="status" className="flex flex-col gap-2">
          <Skeleton className="h-[112px] w-full" />
          <span className="text-caption text-text-muted">{t("loading")}</span>
        </div>
      );
    }
    if (history.kind === "failed") {
      return <p className="text-body-s text-text-body">{t("failed")}</p>;
    }
    const chart = waveChart(history.history?.points ?? [], nowMs, latest);
    if (chart.kind === "empty") {
      return (
        <p className="flex h-[88px] items-center justify-center rounded-input border border-dashed border-border-strong px-4 text-center text-body-s text-text-muted">
          {t("empty")}
        </p>
      );
    }

    // 세로 축: 0부터 0.5m 간격, 최소 1m
    const topM = Math.max(1, Math.ceil(chart.maxV * 2) / 2);
    const ticks = Array.from({ length: topM * 2 + 1 }, (_, i) => i / 2);
    const x = (ms: number) =>
      LEFT + ((ms - chart.from) / (chart.to - chart.from)) * (W - LEFT - RIGHT);
    const y = (m: number) => BOTTOM - (m / topM) * (BOTTOM - TOP);

    const current = chart.current;
    const trailing = chart.gaps.at(-1);
    const since =
      trailing && trailing.to === chart.to
        ? kstStamp(new Date(trailing.from).toISOString(), nowMs)
        : null;
    const label = current
      ? t("label", { value: current.v, max: chart.maxV })
      : t("labelNoNow", { max: chart.maxV });

    return (
      <>
        <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full max-w-[380px]"
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
          {ticks.map((m) => (
            <g key={m}>
              <line
                x1={LEFT}
                x2={W - RIGHT}
                y1={y(m)}
                y2={y(m)}
                className="stroke-border-default"
              />
              {Number.isInteger(m) && (
                <text
                  x={LEFT - 6}
                  y={y(m) + 4}
                  textAnchor="end"
                  className="fill-text-muted text-[10px]"
                >
                  {m === 0 ? "0" : `${m}m`}
                </text>
              )}
            </g>
          ))}
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
                  r={2.5}
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
                  d={`${line}L${x(end.t).toFixed(1)} ${BOTTOM}L${x(first.t).toFixed(1)} ${BOTTOM}Z`}
                  className="fill-chart opacity-15"
                />
                <path
                  d={line}
                  fill="none"
                  strokeWidth={2}
                  className="stroke-chart"
                />
              </g>
            );
          })}
          {current && (
            <g>
              <circle
                cx={x(current.t)}
                cy={y(current.v)}
                r={4}
                className="fill-chart stroke-bg-surface"
                strokeWidth={2}
              />
              <text
                x={x(current.t) - 6}
                y={y(current.v) - 8}
                textAnchor="end"
                className="fill-text-default text-[11px] font-bold"
              >
                {`${current.v}m`}
              </text>
            </g>
          )}
          {[
            [chart.from, t("dayAgo"), "start"],
            [(chart.from + chart.to) / 2, t("halfDayAgo"), "middle"],
            [chart.to, t("now"), "end"],
          ].map(([ms, text, anchor]) => (
            <text
              key={String(text)}
              x={x(ms as number)}
              y={H - 4}
              textAnchor={anchor as "start" | "middle" | "end"}
              className="fill-text-muted text-[10px]"
            >
              {text}
            </text>
          ))}
        </svg>
        {(since || chart.gaps.length > 0) && (
          <p className="text-caption text-text-muted">
            {since ? t("gapSince", { time: since }) : t("gaps")}
          </p>
        )}
        {/* 그래프 아래 캡션 줄에 출처(BRD-113 · 기상청 출처표시 가이드 '표·그래프는 하단 캡션'). 그린 때만 */}
        {sourceShown && <KmaSourceNote variant="buoy" />}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-caption font-bold text-text-muted">{t("title")}</h3>
      {body()}
    </div>
  );
}
