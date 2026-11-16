import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { STATUS } from "@/components/beach-row";
import { RefreshButton } from "@/components/ui/pull-to-refresh";
import { badgeTone } from "@/lib/badge-tone";
import { cn } from "@/lib/cn";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import type { StatusCount } from "@/lib/status-count";

// 탐색 요약 한 줄 (GH-529 · 결정 기록 29장 D29-6, 시안 S_EXPPC·S_EXPMC)
// "전체 19곳 · 특보 없음 17 · 관측 지연 2 · 17:13 업데이트" + 글자 버튼 '새로고침'. 상자 없음
// 사유별 개수는 게시된 상태를 센 값 그대로(countByStatus), 색 + 아이콘 + 글자(색만으로 구분하지 않음)
//   글자색·아이콘은 해변 행 상태 줄과 같은 표(beach-row STATUS)
// 좁은 화면은 '전체'만 화면 읽기에 둠. '업데이트'는 늘 보임: 시각만 있으면 '특보 없음 n'의 확인 시각으로 읽혀서(시안 모바일 '19곳 · … · 17:13'과 다름)

export function ExploreSummary({
  total,
  counts,
  time,
  stale,
  nowMs,
  refreshing,
  onRefresh,
}: {
  total: number | null; // 불러오는 중·결과 없음이면 null(개수를 미리 보이지 않음)
  counts: readonly StatusCount[];
  time: string | null; // 게시 시각 "17:13". 모르면 null
  // 오래된 해변들의 가장 이른 특보 확인 시각(staleCheckedAt). 없으면 null
  stale: { confirmedAt: string | null } | null;
  nowMs: number;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations();
  const { badgeText, confirmedUntilText } = useBadgeText();
  const wide = (chunks: ReactNode) => (
    <span className="max-lg:sr-only">{chunks}</span>
  );
  return (
    // 모바일은 세 줄 높이(58px)를 미리 잡음(GH-218 CLS): 재방문 때 지난 값이 '이후 확인 못 함'과 함께 세 줄로 먼저 보이고
    // 새 값이 오면 두 줄로 줄어 아래 목록이 14px 오르내리던 것을 막음
    <div className="flex min-h-touch items-center gap-x-3 gap-y-1 max-lg:min-h-[58px] max-lg:justify-between lg:min-h-0">
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption text-text-muted">
        {total !== null && (
          <span className="text-body-s font-bold text-text-default lg:text-body">
            {t.rich("explore.summary.count", { count: total, wide })}
          </span>
        )}
        {total !== null &&
          counts.map((item) => {
            const tone = STATUS[badgeTone(item.label)];
            const name = badgeText(item.label);
            return (
              // 칸은 분류 + 사유로 나뉨(countByStatus). 같은 문구가 두 분류에 있어도 key가 겹치지 않게(홈 개수 카드와 같은 key)
              <span
                key={`${item.category}|${name}`}
                className="flex items-center gap-1.5"
              >
                <span aria-hidden="true">·</span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 font-bold",
                    tone.text,
                  )}
                >
                  <span aria-hidden="true">{tone.icon}</span>
                  {name} {item.count}
                </span>
              </span>
            );
          })}
        {time && (
          <span className="flex items-center gap-1.5">
            {total !== null && <span aria-hidden="true">·</span>}
            <span>{t("explore.summary.updated", { time })}</span>
          </span>
        )}
        {/* 오래된 정보(오프라인·만료)를 지금 값처럼 세지 않게: 가장 이른 확인 시각 + '이후 확인 못 함'(홈 개수 카드와 같은 규칙) */}
        {total !== null && stale && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true">·</span>
            <span>{confirmedUntilText(stale.confirmedAt, nowMs)}</span>
          </span>
        )}
      </p>
      <RefreshButton
        variant="text"
        refreshing={refreshing}
        onRefresh={onRefresh}
        className="shrink-0"
      />
    </div>
  );
}
