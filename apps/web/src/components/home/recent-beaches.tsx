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
import { kstStamp } from "@/lib/snapshot/clock";
import { joinMeta } from "@/lib/meta-join";
import { useRecentVisits, viewedTime } from "@/lib/recent-visits";

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
  const tRoot = useTranslations(); // home.near.clearScope · activity.*
  const visits = useRecentVisits(); // 본 시각·그때 고른 활동(기기에만)
  const snapshot = useSnapshot(); // Vue: mapState
  const { confirmedUntilText } = useBadgeText();
  const toast = useToast();

  // [2] 배열 구조 분해: 첫 칸과 나머지. noUncheckedIndexedAccess라 first는 undefined일 수 있음
  const [first, ...rest] = beaches;
  if (!first) return null;
  const view = deriveBeachView({ id: first.id, hidden: false }, snapshot);

  // 보조 문구. '특보 없음'은 범위·기관·시각이 함께 있어야 함(가까운 바다 카드와 같은 규칙)
  // 만료·오프라인(B5): "14:05 확인 · 이후 확인 못 함" / 특보 없음: 지역 + 범위·기관·시각 / 그 밖: 지역
  const time =
    view.kind === "ready" ? kstStamp(view.confirmedAt, snapshot.nowMs) : null;
  // 본 시각(Figma 171:454 '어제 18:40에 봤어요 · 지금 다시 확인했어요', #105 결정 4). 시각이 없는 예전 기록이면 지역
  // '지금 다시 확인했어요'는 이번에 새로 받은 정보로 판단이 나왔을 때만(오래된 값을 지금처럼 말하지 않게)
  const visit = visits[first.id];
  const viewed = visit ? viewedTime(visit.at, snapshot.nowMs) : null;
  const viewedText =
    viewed === null
      ? null
      : viewed.day === "today"
        ? t("viewedToday", { time: viewed.time })
        : viewed.day === "yesterday"
          ? t("viewedYesterday", { time: viewed.time })
          : t("viewedOn", {
              month: viewed.month,
              date: viewed.date,
              time: viewed.time,
            });
  const checkedNow =
    view.kind === "ready" && !view.stale && snapshot.live
      ? t("checkedNow")
      : null;
  const caption =
    view.kind === "ready" && view.stale
      ? confirmedUntilText(view.confirmedAt, snapshot.nowMs)
      : viewedText
        ? joinMeta([viewedText, checkedNow])
        : first.region;
  // 제목 '양양 인구해변 · 수영': 그때 고른 활동을 기록했을 때만
  const title = visit?.activity
    ? t("titleWithActivity", {
        name: first.name,
        activity: tRoot(`activity.${visit.activity}`),
      })
    : first.name;
  const isClear =
    view.kind === "ready" && !view.stale && view.badge.kind === "clear";
  const scope =
    isClear && time ? tRoot("home.near.clearScope", { time }) : null;

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
        href={localizedPath(locale, "/favorites/?tab=recent")}
        linkText={t("all")}
      />
      <Link
        href={localizedPath(locale, `/spots/${first.slug}/`)}
        className="flex items-center justify-between gap-3 rounded-card bg-bg-surface px-3.5 py-[13px] shadow-card"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-title-s text-text-default">
            {title}
          </span>
          <span className="text-caption text-text-muted">{caption}</span>
          {scope && (
            <span className="text-caption text-text-muted">{scope}</span>
          )}
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
                tone="plain"
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
