import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Skeleton } from "@/components/ui/skeleton";
import { badgeTone, type VerdictTone } from "@/lib/badge-tone";
import { kstStamp } from "@/lib/snapshot/clock";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import type { StatusCount } from "@/lib/status-count";

// 지역 해변 상태별 개수 카드 (노션 2장 HOME 8, Figma S_M01_04 171:818) — 지역·전국을 볼 때(위치와 관계없이, BRD-127)
// "강원 해변 5곳 지금 상태"·"전국 해변 206곳 지금 상태" + 칸마다 큰 숫자(상태 글자색) + 실제 사유. 카드 전체가 탐색으로 가는 링크
// 개수는 lib/status-count.ts가 게시된 분류·사유 그대로 셈(G1)

// [1] 숫자 색. Tailwind는 클래스 이름을 글자 그대로 찾아서 `text-status-${tone}-fg`처럼 이어 붙이면 안 됨
const NUMBER_COLOR: Record<VerdictTone, string> = {
  clear: "text-status-clear-fg",
  blocked: "text-status-blocked-fg",
  unknown: "text-status-unknown-fg",
  stale: "text-status-stale-fg",
};

// Vue: props: { href, title, counts, clearCheckedAt, staleChecked, nowMs }
export function RegionCountCard({
  href,
  title,
  counts,
  clearCheckedAt,
  staleChecked,
  nowMs,
}: {
  href: string;
  title: string; // "강원 해변 5곳 지금 상태" · "전국 해변 206곳 지금 상태"
  counts: StatusCount[] | null; // null = 아직 불러오는 중
  clearCheckedAt: string | null; // '특보 없음' 해변들의 가장 이른 확인 시각(lib/status-count.ts)
  // 오래된(오프라인·만료) 해변들의 가장 이른 확인 시각. null = 오래된 해변 없음(lib/status-count.ts)
  staleChecked: { confirmedAt: string | null } | null;
  nowMs: number;
}) {
  const t = useTranslations("home.region");
  const { badgeText, confirmedUntilText } = useBadgeText();
  // '특보 없음' 칸이 있으면 범위·기관·확인 시각(가까운 바다 카드와 같은 규칙)
  const hasClear =
    counts !== null && counts.some((item) => item.label.kind === "clear");
  const time = kstStamp(clearCheckedAt, nowMs);
  // 오래된 해변이 하나라도 있으면 'HH:MM 확인 · 이후 확인 못 함'(B5, 노션 결정 기록 11장 10/27 ②)
  const hasStale = counts !== null && staleChecked !== null;
  return (
    <Link
      href={href}
      // Figma 171:901: 안쪽 16·14, 사이 10, 제목 14.5 굵게 + › 16, 칸 사이 4, 숫자 18 굵게, 칸 이름 11.5, 근거 줄 12/18.6 (BRD-129)
      className="flex flex-col gap-2.5 rounded-card bg-bg-surface px-4 py-3.5 shadow-card"
    >
      <span className="flex items-start justify-between gap-3 text-title-count text-text-default">
        {title}
        <ChevronRight aria-hidden="true" size={16} className="shrink-0" />
      </span>
      {counts === null ? (
        <span role="status" className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <span className="text-caption text-text-muted">
            {t("countLoading")}
          </span>
        </span>
      ) : (
        // [2] 칸 수가 지역마다 달라 grid 대신 flex로 나눔
        <span className="flex gap-1">
          {counts.map((item) => {
            const text = badgeText(item.label);
            return (
              <span
                key={`${item.category}|${text}`}
                className="flex flex-1 flex-col items-center text-center"
              >
                <span
                  className={`text-num-count ${NUMBER_COLOR[badgeTone(item.label)]}`}
                >
                  {item.count}
                </span>
                <span className="text-label-xs text-text-body">{text}</span>
              </span>
            );
          })}
        </span>
      )}
      {/* 순서: 특보 없음 범위 → 이후 확인 못 함. 현장 우선 문구는 같은 묶음의 가까운 바다 카드에 하나만(#105 결정 5) */}
      {counts !== null && (
        <span className="flex flex-col text-note text-text-muted">
          {hasClear && (
            <span>
              {time ? t("countScope", { time }) : t("countScopeNoTime")}
            </span>
          )}
          {hasStale && (
            <span>{confirmedUntilText(staleChecked.confirmedAt, nowMs)}</span>
          )}
        </span>
      )}
    </Link>
  );
}
