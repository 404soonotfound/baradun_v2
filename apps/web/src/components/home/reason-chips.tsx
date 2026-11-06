"use client";

import { useTranslations } from "next-intl";

import { Skeleton } from "@/components/ui/skeleton";
import { badgeTone, type VerdictTone } from "@/lib/badge-tone";
import { cn } from "@/lib/cn";
import { kstStamp } from "@/lib/snapshot/clock";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import type { StatusCount } from "@/lib/status-count";

// PC 해변 묶음 패널 머리의 사유별 개수 (11/5 홈 v3 시안 ActR_P_V3*, 이슈 #362 '목록 제목 + 상태별 개수 줄')
// '특보 없음 17곳 · 풍랑주의보 1곳 · 관측 지연 1곳' — 실제 사유 글자(배지와 같은 말)와 색 + 글자로 구분(색만으로 구분하지 않음)
// 개수는 lib/status-count.ts가 게시된 분류·사유 그대로 셈(G1). '특보 없음'이 있으면 범위·기관·확인 시각을 늘 함께
const CHIP: Record<VerdictTone, string> = {
  clear: "bg-status-clear-bg text-status-clear-fg",
  blocked: "bg-status-blocked-bg text-status-blocked-fg",
  unknown: "bg-status-unknown-bg text-status-unknown-fg",
  stale: "bg-status-stale-bg text-status-stale-fg",
};

export function ReasonChips({
  counts,
  clearCheckedAt,
  staleChecked,
  nowMs,
}: {
  counts: StatusCount[] | null; // null = 아직 불러오는 중
  clearCheckedAt: string | null;
  staleChecked: { confirmedAt: string | null } | null;
  nowMs: number;
}) {
  const t = useTranslations();
  const { badgeText, confirmedUntilText } = useBadgeText();
  if (counts === null) {
    return (
      <span role="status" className="flex flex-col items-end gap-1">
        <Skeleton className="h-7 w-56 rounded-[10px]" />
        <span className="text-caption text-text-muted">
          {t("home.region.countLoading")}
        </span>
      </span>
    );
  }
  const hasClear = counts.some((item) => item.label.kind === "clear");
  const time = kstStamp(clearCheckedAt, nowMs);
  return (
    <span className="flex flex-col items-end gap-1">
      <ul className="flex flex-wrap justify-end gap-1.5">
        {counts.map((item) => {
          const text = badgeText(item.label);
          return (
            <li
              key={`${item.category}|${text}`}
              className={cn(
                "rounded-[10px] px-2.5 py-1 text-label-s font-bold",
                CHIP[badgeTone(item.label)],
              )}
            >
              {text} {t("home.hero.count", { count: item.count })}
            </li>
          );
        })}
      </ul>
      {hasClear && (
        <span className="text-caption text-text-muted">
          {time
            ? t("home.region.countScope", { time })
            : t("home.region.countScopeNoTime")}
        </span>
      )}
      {staleChecked !== null && (
        <span className="text-caption text-text-muted">
          {confirmedUntilText(staleChecked.confirmedAt, nowMs)}
        </span>
      )}
    </span>
  );
}
