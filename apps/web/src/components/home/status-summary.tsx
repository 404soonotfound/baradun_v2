import { Check, Clock, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { kstStamp } from "@/lib/snapshot/clock";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import type { Category } from "@/lib/snapshot/view";
import {
  CATEGORY_ORDER,
  summarizeByCategory,
  type StatusCount,
} from "@/lib/status-count";

// PC 홈 히어로 상태 요약 카드 3장 (Figma S_D07_01 181:819, BRD-129)
// 특보 없음 · 이용불가 · 판단불가 개수 + 아래 줄(특보 없음은 범위·기관·확인 시각, 나머지는 실제 사유별 개수)
// 개수는 게시된 분류·사유 그대로(lib/status-count.ts, G1). 판단불가 카드는 점선 테두리(노션 4장 판단 상태 규칙, 색은 Figma border-note)
// 카드 전체가 탐색으로 가는 링크. 0곳인 분류도 Figma처럼 3장을 늘 같은 자리에 둠(#105 사용자 결정 10/30)
// 0곳 카드는 근거(확인 시각·사유)가 없으니 아래 줄을 비우지 않고 빼서 분류 이름·개수만 보임
// 현장 우선 문구는 바로 아래 가까운 바다 제목 줄에 하나만 둠(#105 결정 5, Figma 181:849)

// 분류마다 아이콘·색. Tailwind가 클래스 이름을 글자 그대로 찾도록 이어 붙이지 않고 다 적음
const LOOK: Record<
  Category,
  { icon: typeof Check; box: string; border: string }
> = {
  clear: {
    icon: Check,
    box: "bg-status-clear-bg text-status-clear-fg",
    border: "border-solid border-border-faint",
  },
  unavailable: {
    icon: TriangleAlert,
    box: "bg-status-blocked-bg text-status-blocked-fg",
    border: "border-solid border-border-faint",
  },
  undetermined: {
    icon: Clock,
    box: "bg-status-stale-bg text-status-stale-fg",
    border: "border-dashed border-border-note",
  },
};

// Vue: props: { href, counts, clearCheckedAt, staleChecked, nowMs }
export function StatusSummary({
  href,
  counts,
  clearCheckedAt,
  staleChecked,
  nowMs,
}: {
  href: string;
  counts: StatusCount[] | null; // null = 아직 불러오는 중
  clearCheckedAt: string | null; // '특보 없음' 해변들의 가장 이른 확인 시각
  staleChecked: { confirmedAt: string | null } | null; // 오래된(오프라인·만료) 해변의 가장 이른 확인 시각
  nowMs: number;
}) {
  const t = useTranslations("home.hero");
  const tRoot = useTranslations(); // home.region.countLoading
  const { badgeText, confirmedUntilText } = useBadgeText();

  // [1] 불러오는 중: 카드 자리만(개수를 미리 보이지 않음)
  if (counts === null) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="grid grid-cols-3 gap-4">
          {CATEGORY_ORDER.map((category) => (
            <Skeleton key={category} className="h-[95px] rounded-tile" />
          ))}
        </span>
        <span className="text-caption text-text-muted">
          {tRoot("home.region.countLoading")}
        </span>
      </div>
    );
  }

  const time = kstStamp(clearCheckedAt, nowMs);
  return (
    <div className="flex flex-col gap-2">
      <ul className="grid grid-cols-3 gap-4">
        {summarizeByCategory(counts).map((item) => {
          const look = LOOK[item.category];
          const Icon = look.icon;
          // [2] 아래 줄. 특보 없음은 범위·기관·확인 시각, 나머지는 실제 사유별 개수
          const caption =
            item.count === 0
              ? null
              : item.category === "clear"
                ? time
                  ? t("clearScope", { time })
                  : t("clearScopeNoTime")
                : item.reasons
                    .map((reason) =>
                      t("reason", {
                        reason: badgeText(reason.label),
                        count: reason.count,
                      }),
                    )
                    .join(" · ");
          return (
            <li key={item.category}>
              <Link
                href={href}
                className={cn(
                  "flex h-full items-center gap-3 rounded-tile border bg-bg-surface px-[17px] py-[15px]",
                  look.border,
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-[38px] shrink-0 items-center justify-center rounded-input",
                    look.box,
                  )}
                >
                  <Icon size={19} />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  {/* data-summary-category: 판단 배지가 아니라 분류 이름(E2E가 '특보 없음' 배지와 구분) */}
                  <span
                    data-summary-category={item.category}
                    className="text-body-s text-text-body"
                  >
                    {t(`category.${item.category}`)}
                  </span>
                  <span className="text-num-s text-text-default">
                    {t("count", { count: item.count })}
                  </span>
                  {/* 범위·기관·확인 시각은 잘리지 않게 줄을 바꿈(긴 영어·좁은 PC에서도 기관·시각이 보이게) */}
                  {caption && (
                    <span className="text-caption text-text-muted">
                      {caption}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {/* 오프라인·만료로 오래된 해변이 있으면 'HH:MM 확인 · 이후 확인 못 함'(B5, 지역 개수 카드와 같은 규칙) */}
      {staleChecked !== null && (
        <p className="text-caption text-text-muted">
          {confirmedUntilText(staleChecked.confirmedAt, nowMs)}
        </p>
      )}
    </div>
  );
}
