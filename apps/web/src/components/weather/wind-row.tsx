// 바람 줄 (BRD-185 · 결정 기록 18장 D18-2, 노션 3장 WeatherCard '바람' 줄, 시안 ActR_D_WXM)
// 칸마다 불어가는 쪽 화살표 + 풍속 숫자 + 아래 옅은 면 그래프. 한 가지 색(좋음·나쁨 색 없음)
// 홈 스쿠버다이빙 '앞으로 바람' 줄(D18-5)도 같은 부품을 씀
// 그림 줄이라 aria-hidden: 읽는 글은 부르는 쪽 목록(칸별 '바람 5m/s')이 맡음
// 값이 없는 칸은 화살표 없이 '–', 그래프는 그 칸에서 끊음(0으로 그리지 않음)

export const WEATHER_COLUMN = 36; // 칸 너비(px, 시안 36)
const GRAPH_H = 22;

export interface WindCell {
  windTo: number | null; // 불어가는 쪽(도)
  windSpeed: number | null; // m/s
}

// 값이 이어진 구간마다 면 그래프 한 조각
function segments(cells: readonly WindCell[], max: number) {
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
      y: GRAPH_H - (cell.windSpeed / max) * (GRAPH_H - 3),
    });
  });
  if (run.length) out.push(run);
  return out;
}

export function WindRow({ cells }: { cells: readonly WindCell[] }) {
  const width = cells.length * WEATHER_COLUMN;
  const max = Math.max(1, ...cells.map((c) => c.windSpeed ?? 0));
  return (
    <div aria-hidden="true">
      <div className="mt-1 flex text-text-body">
        {cells.map((cell, i) => (
          <span
            key={i}
            className="flex flex-col items-center gap-0.5"
            style={{ width: WEATHER_COLUMN }}
          >
            {cell.windTo === null || cell.windSpeed === null ? (
              <span className="h-[11px]" />
            ) : (
              <svg
                width="11"
                height="11"
                viewBox="0 0 12 12"
                className="shrink-0"
                style={{ transform: `rotate(${Math.round(cell.windTo)}deg)` }}
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
            )}
            <span className="text-[11.5px] leading-none font-bold text-text-default tabular-nums">
              {cell.windSpeed === null ? "–" : Math.round(cell.windSpeed)}
            </span>
          </span>
        ))}
      </div>
      <svg width={width} height={GRAPH_H} className="mt-0.5 block">
        {segments(cells, max).map((run, i) => {
          const line = run
            .map((p, j) => `${j ? "L" : "M"}${p.x},${p.y.toFixed(1)}`)
            .join(" ");
          const area = `${line} L${run.at(-1)!.x},${GRAPH_H} L${run[0]!.x},${GRAPH_H} Z`;
          return (
            <g key={i}>
              <path d={area} className="fill-chart" fillOpacity={0.14} />
              <path
                d={line}
                fill="none"
                className="stroke-chart"
                strokeWidth={1.6}
                strokeLinejoin="round"
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
