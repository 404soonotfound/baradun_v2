import { messages } from "@/lib/messages";

export type ChartRow = { key: string; label: string; value: number | null };

// 세로 막대 그래프(이용 통계 일별·시간대별, 운영 홈 이용 칸 일별). 막대 높이는 SVG 속성(CSP). 값이 없는 날·시각은 막대를 그리지 않음(0으로 그리지 않음)
// 화면 읽기용으로 같은 값을 숨은 표로 둠
export function BarChart({
  rows,
  bars,
  head,
  valueHead,
}: {
  rows: readonly ChartRow[];
  // 막대 영역 높이(아래 날짜 줄 24px은 따로)
  bars: string;
  head: string;
  valueHead: string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value ?? 0));
  return (
    <>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${rows.length} 100`}
        preserveAspectRatio="none"
        className={`block w-full border-b border-border-default ${bars}`}
      >
        {rows.map((row, i) => {
          if (row.value === null || max <= 0) return null;
          const h = (row.value / max) * 100;
          return (
            <rect
              key={row.key}
              x={i + 0.15}
              width={0.7}
              y={100 - h}
              height={h}
              className="fill-chart"
            />
          );
        })}
      </svg>
      <div
        aria-hidden="true"
        className="flex h-6 items-end justify-between text-caption text-text-muted tabular-nums"
      >
        <span>{rows[0]?.label}</span>
        <span>{rows.at(-1)?.label}</span>
      </div>
      <table className="sr-only">
        <thead>
          <tr>
            <th scope="col">{head}</th>
            <th scope="col">{valueHead}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>{row.label}</td>
              <td>{row.value === null ? messages.stats.emptyValue : row.value.toLocaleString("ko-KR")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// 날짜 YYYY-MM-DD → '11/13'
export const shortDate = (date: string): string =>
  `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
