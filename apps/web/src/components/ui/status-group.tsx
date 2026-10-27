import { CircleCheck, CircleQuestionMark, TriangleAlert } from "lucide-react";
import { useId, type ReactNode } from "react";

import type { VerdictTone } from "@/lib/badge-tone";
import { cn } from "@/lib/cn";

// 상태별 묶음 (BRD-29 · 컴포넌트 명세 StatusGroup)
// 제목 줄(아이콘 26px + "이용불가 1곳" + 오른쪽 "가장 가까운 곳 19.6km") → 사유별 개수 → 카드 안 BeachRow들 → 안내 줄
// 행 안에는 배지 상자를 두지 않음. 문구는 부르는 쪽이 만들어 넘김(언어·계산을 이 부품이 모름)

const TONE: Record<
  Extract<VerdictTone, "clear" | "blocked" | "unknown">,
  { text: string; box: string; icon: ReactNode }
> = {
  clear: {
    text: "text-status-clear-fg",
    box: "bg-status-clear-bg text-status-clear-fg",
    icon: <CircleCheck size={15} />,
  },
  blocked: {
    text: "text-status-blocked-fg",
    box: "bg-status-blocked-bg text-status-blocked-fg",
    icon: <TriangleAlert size={15} />,
  },
  unknown: {
    text: "text-status-unknown-fg",
    box: "bg-status-unknown-bg text-status-unknown-fg",
    icon: <CircleQuestionMark size={15} />,
  },
};

export function StatusGroup({
  tone,
  title,
  aside,
  summary,
  notes = [],
  children,
}: {
  tone: keyof typeof TONE;
  title: string; // "이용불가 1곳"
  aside?: string | null; // "가장 가까운 곳 19.6km". 위치가 없으면 null
  summary?: string | null; // 사유가 섞일 때 "특보 확인 못 함 1 · 관측 지연 1"
  notes?: readonly string[]; // 목록 아래 안내 줄(범위·기관·시각, 현장 우선 문구)
  children: ReactNode; // <li>로 감싼 BeachRow들
}) {
  const titleId = useId();
  const style = TONE[tone];
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-[26px] shrink-0 items-center justify-center rounded-full",
            style.box,
          )}
        >
          {style.icon}
        </span>
        <h2 id={titleId} className={cn("text-title-s", style.text)}>
          {title}
        </h2>
        {aside && (
          <span className="ml-auto text-caption text-text-muted">{aside}</span>
        )}
      </div>
      {summary && <p className="text-caption text-text-muted">{summary}</p>}
      <ul className="divide-y divide-border-default overflow-hidden rounded-card bg-bg-surface shadow-card">
        {children}
      </ul>
      {notes.length > 0 && (
        <div className="flex flex-col gap-0.5 text-caption text-text-muted">
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      )}
    </section>
  );
}
