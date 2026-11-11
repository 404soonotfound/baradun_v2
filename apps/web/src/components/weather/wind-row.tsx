// 바람 줄 (BRD-185 · 결정 기록 18장 D18-2, 노션 3장 WeatherCard '바람' 줄, 시안 ActR_D_WXM)
// 칸마다 불어가는 쪽 화살표 + 풍속 숫자 + 아래 옅은 면 그래프. 한 가지 색(좋음·나쁨 색 없음)
// 홈 스쿠버다이빙 '앞으로 바람' 줄(D18-5)도 같은 부품을 씀(hours로 시각 줄을 얹고 columns로 카드 폭을 나눔)
// 그림 줄이라 aria-hidden: 읽는 글은 부르는 쪽 목록(칸별 '바람 5m/s')이 맡음
// 값이 없는 칸은 화살표 없이 '–', 그래프는 그 칸에서 끊음(0으로 그리지 않음)

import { cn } from "@/lib/cn";

export const WEATHER_COLUMN = 36; // 칸 너비(px, 시안 36)
const GRAPH_H = 22;
const CARD_GRAPH_H = 20; // 홈 카드 그래프 높이(h-5, 기존 홈과 같음)

export interface WindCell {
  windTo: number | null; // 불어가는 쪽(도)
  windSpeed: number | null; // m/s
}

// 값이 이어진 구간마다 면 그래프 한 조각
function segments(cells: readonly WindCell[], max: number, h: number) {
  const out: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  cells.forEach((cell, i) => {
    if (cell.windSpeed === null) {
      if (run.length) out.push(run);
      run = [];
      return;
    }
    run.push({
      x: i * WEATHER_COLUMN + WEATHER_COLUMN / 2,
      y: h - (cell.windSpeed / max) * (h - 3),
    });
  });
  if (run.length) out.push(run);
  return out;
}

// 칸의 화살표. 풍향·풍속 중 하나라도 없으면 같은 크기의 빈 자리
function arrowOf(cell: WindCell) {
  return cell.windTo === null || cell.windSpeed === null ? (
    <span className="block size-[11px]" />
  ) : (
    <WindArrow windTo={cell.windTo} />
  );
}

// 불어가는 쪽 화살표 하나(11px)
function WindArrow({ windTo }: { windTo: number }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 12 12"
      className="shrink-0"
      style={{ transform: `rotate(${Math.round(windTo)}deg)` }}
    >
      <path
        d="M6 10.5V1.8M2.6 5.1 6 1.6l3.4 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WindRow({
  cells,
  hours,
  columns,
}: {
  cells: readonly WindCell[];
  hours?: readonly string[]; // 홈 '앞으로 바람'의 칸별 시각 글자('15시')
  // 주면 카드 폭을 이 칸 수로 나눔(홈 카드, 칸이 모자라면 오른쪽이 빔. 숫자 크기·간격은 기존 홈 그대로)
  // 안 주면 칸마다 36px 고정(상세 카드)
  columns?: number;
}) {
  const fit = columns !== undefined;
  const slots = columns ?? cells.length;
  const width = slots * WEATHER_COLUMN;
  const graphH = fit ? CARD_GRAPH_H : GRAPH_H;
  const max = Math.max(1, ...cells.map((c) => c.windSpeed ?? 0));
  return (
    <span aria-hidden="true" className="block">
      <span className={cn("flex text-text-body", fit ? "w-full" : "mt-1")}>
        {cells.map((cell, i) => (
          <span
            key={i}
            className="flex flex-col items-center gap-0.5"
            style={{ width: fit ? `${100 / slots}%` : WEATHER_COLUMN }}
          >
            {hours?.[i] !== undefined && (
              <span className="text-[10px] leading-none text-text-muted tabular-nums">
                {hours[i]}
              </span>
            )}
            {fit ? (
              // 홈은 예전처럼 줄 높이를 따르는 칸에 둠(화살표 줄 높이가 바뀌지 않게)
              <span>{arrowOf(cell)}</span>
            ) : (
              arrowOf(cell)
            )}
            <span
              className={cn(
                "leading-none font-bold text-text-default tabular-nums",
                fit ? "text-label-s" : "text-[11.5px]",
              )}
            >
              {cell.windSpeed === null ? "–" : Math.round(cell.windSpeed)}
            </span>
          </span>
        ))}
      </span>
      <svg
        width={fit ? undefined : width}
        height={fit ? undefined : graphH}
        viewBox={`0 0 ${width} ${graphH}`}
        preserveAspectRatio={fit ? "none" : undefined}
        className={cn("block", fit ? "mt-1 h-5 w-full" : "mt-0.5")}
      >
        {segments(cells, max, graphH).map((run, i) => {
          const line = run
            .map((p, j) => `${j ? "L" : "M"}${p.x},${p.y.toFixed(1)}`)
            .join(" ");
          const area = `${line} L${run.at(-1)!.x},${graphH} L${run[0]!.x},${graphH} Z`;
          return (
            <g key={i}>
              <path d={area} className="fill-chart" fillOpacity={0.14} />
              <path
                d={line}
                fill="none"
                className="stroke-chart"
                strokeWidth={1.6}
                strokeLinejoin="round"
                vectorEffect={fit ? "non-scaling-stroke" : undefined}
              />
            </g>
          );
        })}
      </svg>
    </span>
  );
}
