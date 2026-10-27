"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { SectionHead } from "@/components/home/section-head";
import { ReasonBadge } from "@/components/reason-badge";
import { RemovableChip } from "@/components/ui/chip";
import { Skeleton } from "@/components/ui/skeleton";
import { Toast, useToast } from "@/components/ui/toast";
import type { BeachSummary } from "@/lib/beach-summary";
import { removeRecent } from "@/lib/favorites";
import { localizedPath, type Locale } from "@/lib/i18n";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { deriveBeachView } from "@/lib/snapshot/view";

// 최근 본 해변 (노션 2장 HOME 5, Figma S_M01_01) — 재방문만. 첫 방문이면 FirstVisitCard
// 대표 1곳 카드(상태 배지) + 나머지 칩(✕로 확인 없이 지우고 토스트 '되돌리기')

// [1] Vue: props: { locale, beaches }. beaches = 최근 본 순서로 이미 고른 목록
export function RecentBeaches({
  locale,
  beaches,
}: {
  locale: Locale;
  beaches: BeachSummary[];
}) {
  const t = useTranslations("home.recent");
  const snapshot = useSnapshot(); // Vue: mapState
  const { confirmedUntilText } = useBadgeText();
  const toast = useToast();

  // [2] 배열 구조 분해: 첫 칸과 나머지. noUncheckedIndexedAccess라 first는 undefined일 수 있음
  const [first, ...rest] = beaches;
  if (!first) return null;
  const view = deriveBeachView({ id: first.id, hidden: false }, snapshot);

  // [3] ✕ 누름 → 지우고 토스트
  function remove(beach: BeachSummary) {
    const undo = removeRecent(beach.id);
    toast.show({
      text: t("removed"),
      // 되돌리면 지우기 전 순서 그대로(대표 카드가 바뀌지 않게)
      action: { label: t("undo"), onClick: undo },
    });
  }

  return (
    <section aria-labelledby="home-recent" className="flex flex-col gap-2.5">
      <SectionHead
        id="home-recent"
        title={t("title")}
        href={localizedPath(locale, "/favorites/")}
        linkText={t("all")}
      />
      <Link
        href={localizedPath(locale, `/spots/${first.slug}/`)}
        className="flex items-center justify-between gap-3 rounded-card bg-bg-surface px-4 py-3.5 shadow-card"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-title-s text-text-default">
            {first.name}
          </span>
          <span className="text-caption text-text-muted">
            {view.kind === "ready" && view.stale
              ? confirmedUntilText(view.confirmedAt, snapshot.nowMs)
              : first.region}
          </span>
        </span>
        {view.kind === "ready" ? (
          <ReasonBadge label={view.badge} />
        ) : (
          <Skeleton className="h-badge w-20 rounded-badge" />
        )}
      </Link>
      {rest.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {/* Vue: v-for="beach in rest" :key="beach.id" */}
          {rest.map((beach) => (
            <li key={beach.id}>
              <RemovableChip
                removeLabel={t("remove", { name: beach.name })}
                onRemove={() => remove(beach)}
              >
                <Link href={localizedPath(locale, `/spots/${beach.slug}/`)}>
                  {beach.name}
                </Link>
              </RemovableChip>
            </li>
          ))}
        </ul>
      )}
      <Toast message={toast.message} onHold={toast.hold} />
    </section>
  );
}
