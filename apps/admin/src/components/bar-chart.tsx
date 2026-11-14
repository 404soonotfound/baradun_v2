import { messages } from "@/lib/messages";

// notYet: 아직 지나지 않은 시간(오늘 범위 시간대별 reportedDays 0). 결측이 아니라 막대·빈칸 모두 그리지 않음
export type ChartRow = {
  key: string;
  label: string;
  value: number | null;
  notYet?: boolean;
};

// 세로 막대 그래프(이용 통계 일별·시간대별, 운영 홈 이용 칸 일별). 막대 높이는 SVG 속성(CSP)
// 값이 없는(null) 날·시각은 막대 대신 옅은 빈칸 기둥(0과 구분, 0으로 그리지 않음). 범례 문구는 쓰는 쪽이 hasNull로 붙임
// 화면 읽기용으로 같은 값을 숨은 표로 둠(null은 '–')
export function BarChart({
  rows,
  bars,
  head,
  valueHead,
  format = (n) => n.toLocaleString("ko-KR"),
}: {
  rows: readonly ChartRow[];
  // 막대 영역 높이(아래 날짜 줄 24px은 따로)
  bars: string;
  head: string;
  valueHead: string;
  // 숨은 표의 값 표기(시간대별 평균은 소수 첫째 자리)
  format?: ((n: number) => string) | undefined;
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
          if (row.notYet) return null;
          if (row.value === null) {
            return (
              <rect
                key={row.key}
                x={i + 0.15}
                width={0.7}
                y={0}
                height={100}
                data-empty=""
                className="fill-border-subtle"
              />
            );
          }
          if (max <= 0) return null;
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
              <td>
                {row.notYet
                  ? messages.stats.hourNotYet
                  : row.value === null
                    ? messages.stats.emptyValue
                    : format(row.value)}
              </td>
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

export const hasNull = (rows: readonly ChartRow[] | null): boolean =>
  rows !== null && rows.some((r) => r.value === null && !r.notYet);
