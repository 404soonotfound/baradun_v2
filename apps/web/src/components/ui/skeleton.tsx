import { cn } from "@/lib/cn";

// 스켈레톤 (BRD-81 · 컴포넌트 명세 Skeleton, Figma S_M02_03 173:846)
// 실제 레이아웃 모양의 회색 상자 + 아래 한 줄 문구. 1.1초 흐름(animate-skeleton), 동작 줄이기면 멈춤(globals.css)

// 회색 상자 하나. 크기·모서리는 className으로 받음
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        // 가운데만 밝은 띠를 200% 폭으로 깔고 옆으로 흘려 보냄(keyframes skeleton)
        "block animate-skeleton rounded-[6px] bg-[linear-gradient(90deg,var(--color-bg-subtle)_25%,var(--color-bg-page)_50%,var(--color-bg-subtle)_75%)] bg-[length:200%_100%]",
        className,
      )}
    />
  );
}

// 해변 행 모양 스켈레톤 목록. 해변 행(BeachRow)과 같은 높이·간격
export function BeachRowSkeleton({
  rows = 4,
  label,
}: {
  rows?: number;
  // 아래 한 줄 문구(예: "해변 정보를 불러오고 있어요"). 화면 읽기 프로그램에도 이 글자만 읽힘
  label: string;
}) {
  return (
    // role="status" = 불러오는 중이라는 안내를 조용히 읽어 줌
    <div role="status">
      <ul className="overflow-hidden rounded-card bg-bg-surface shadow-card">
        {/* Array.from({ length: n }) = 길이 n짜리 빈 배열. map의 두 번째 값(i)이 0, 1, 2 … */}
        {Array.from({ length: rows }, (_, i) => (
          <li
            key={i}
            className="flex items-center gap-3 border-t border-border-default py-[13px] pr-3 pl-3.5 first:border-t-0"
          >
            <Skeleton className="size-[54px] rounded-[12px]" />
            <span className="flex flex-1 flex-col gap-[3px]">
              <Skeleton className="h-3.5 w-[60%]" />
              <Skeleton className="h-[11px] w-[85%]" />
              <Skeleton className="h-5 w-[42%]" />
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-center text-caption text-text-muted">{label}</p>
    </div>
  );
}

// 처음 불러올 때 화면 가운데 로더 (10/22 사용자 결정 · 노션 3장 Skeleton '첫 로딩 변형')
// 맨 아래에 새 행이 톡 생기고(상자가 커지고 막대가 왼쪽부터 늘어남) 위의 행들을 한 칸씩 밀어 올림
// 위로 갈수록 작고 옅어지다 맨 위 다음 칸에서 사라짐. 색은 브랜드 파랑(brand-default) + 투명도
// 동작 줄이기면 멈춘 그림(각 행의 style 값)으로 보임. keyframes는 globals.css

// 한 칸 올라가는 데 걸리는 시간. 행 4개가 이만큼씩 어긋나서 출발(한 바퀴 = 4칸 = 4160ms)
const STEP_MS = 1040;

// 행 4개의 멈춘 자리(동작 줄이기용)와 막대 2개 너비(px, 가장 큰 크기 기준)
const RISE_ROWS = [
  // 맨 아래(가장 큼·진함)
  { bars: [98, 120], rest: "translateY(0) scale(1)", opacity: 0.5 },
  // 가운데
  { bars: [110, 72], rest: "translateY(-86px) scale(0.8)", opacity: 0.3 },
  // 맨 위(가장 작음·옅음)
  { bars: [86, 130], rest: "translateY(-148px) scale(0.58)", opacity: 0.12 },
  // 숨은 행: 다음 차례에 맨 아래에서 새로 생김
  { bars: [104, 92], rest: "translateY(0) scale(1)", opacity: 0 },
];

export function RisingSkeleton({ label }: { label: string }) {
  return (
    <div role="status" className="flex flex-col items-center gap-8">
      {/* 행들이 겹쳐 놓이는 무대. 모든 행이 맨 아래 자리에서 출발해 위로 이동 */}
      <div aria-hidden="true" className="relative h-[230px] w-[220px]">
        {RISE_ROWS.map((row, i) => {
          // 음수 지연 = 이미 그만큼 진행된 상태로 시작. 행마다 한 칸씩 어긋남
          const delay = `${-i * STEP_MS}ms`;
          return (
            <div
              key={i}
              className="absolute inset-x-0 bottom-0 mx-auto flex w-fit animate-[skeleton-rise_4160ms_var(--ease-standard)_infinite] items-center gap-3 motion-reduce:animate-none"
              // 애니메이션이 돌 때는 keyframes가 이 값을 덮어씀. 멈추면 이 값 그대로
              style={{
                animationDelay: delay,
                transform: row.rest,
                opacity: row.opacity,
              }}
            >
              {/* 왼쪽 상자: 작게 시작해 톡 커짐 */}
              <span
                className="size-[60px] animate-[skeleton-pop_4160ms_var(--ease-standard)_infinite] rounded-[10px] bg-brand-default motion-reduce:animate-none"
                style={{ animationDelay: delay }}
              />
              <span className="flex flex-col gap-[7px]">
                {row.bars.map((w, j) => (
                  // 막대: 왼쪽 끝을 기준으로 0에서 살짝 넘치게 늘어났다 제자리. 두 번째 막대가 조금 늦게
                  <span
                    key={j}
                    className={cn(
                      "h-[17px] origin-left rounded-[4px] bg-brand-default/60 motion-reduce:animate-none",
                      j === 0
                        ? "animate-[skeleton-grow-a_4160ms_var(--ease-standard)_infinite]"
                        : "animate-[skeleton-grow-b_4160ms_var(--ease-standard)_infinite]",
                    )}
                    style={{ width: w, animationDelay: delay }}
                  />
                ))}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-caption text-text-muted">{label}</p>
    </div>
  );
}
