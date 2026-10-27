import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Skeleton } from "@/components/ui/skeleton";
import { badgeTone, type VerdictTone } from "@/lib/badge-tone";
import { kstStamp } from "@/lib/snapshot/clock";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import type { StatusCount } from "@/lib/status-count";

// 지역 해변 상태별 개수 카드 (노션 2장 HOME 8, Figma S_M01_04 171:818) — 위치 없이 지역을 고른 뒤만
// "강원 해변 5곳 지금 상태" + 칸마다 큰 숫자(상태 글자색) + 실제 사유. 카드 전체가 탐색으로 가는 링크
// 개수는 lib/status-count.ts가 게시된 분류·사유 그대로 셈(G1)

// [1] 숫자 색. Tailwind는 클래스 이름을 글자 그대로 찾아서 `text-status-${tone}-fg`처럼 이어 붙이면 안 됨
const NUMBER_COLOR: Record<VerdictTone, string> = {
  clear: "text-status-clear-fg",
  blocked: "text-status-blocked-fg",
  unknown: "text-status-unknown-fg",
  stale: "text-status-stale-fg",
};

// Vue: props: { href, title, counts, clearCheckedAt, nowMs }
export function RegionCountCard({
  href,
  title,
  counts,
  clearCheckedAt,
  nowMs,
}: {
  href: string;
  title: string; // "강원 해변 5곳 지금 상태"
  counts: StatusCount[] | null; // null = 아직 불러오는 중
  clearCheckedAt: string | null; // '특보 없음' 해변들의 가장 이른 확인 시각(lib/status-count.ts)
  nowMs: number;
}) {
  const t = useTranslations("home.region");
  const tRoot = useTranslations();
  const { badgeText } = useBadgeText();
  // '특보 없음' 칸이 있으면 범위·기관·확인 시각과 현장 우선 문구를 함께(가까운 바다 카드와 같은 규칙)
  const hasClear =
    counts !== null && counts.some((item) => item.label.kind === "clear");
  const time = kstStamp(clearCheckedAt, nowMs);
  return (
    <Link
      href={href}
      className="flex flex-col gap-3 rounded-card bg-bg-surface p-4 shadow-card"
    >
      <span className="flex items-center justify-between gap-3 text-title-s text-text-default">
        {title}
        <ChevronRight aria-hidden="true" size={18} className="shrink-0" />
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
        <span className="flex">
          {counts.map((item) => {
            const text = badgeText(item.label);
            return (
              <span
                key={`${item.category}|${text}`}
                className="flex flex-1 flex-col items-center gap-0.5 text-center"
              >
                <span
                  className={`text-num-m font-bold ${NUMBER_COLOR[badgeTone(item.label)]}`}
                >
                  {item.count}
                </span>
                <span className="text-caption text-text-body">{text}</span>
              </span>
            );
          })}
        </span>
      )}
      {hasClear && (
        <span className="flex flex-col gap-0.5 text-caption text-text-muted">
          <span>
            {time ? t("countScope", { time }) : t("countScopeNoTime")}
          </span>
          <span>{tRoot("safety.finalCall")}</span>
        </span>
      )}
    </Link>
  );
}
