"use client";

import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { deriveBeachView } from "@/lib/snapshot/view";
import { kstStamp } from "@/lib/snapshot/clock";
import { joinMeta } from "@/lib/meta-join";
import { useRecentVisits, viewedTime } from "@/lib/recent-visits";
import { useDesktop } from "@/lib/use-desktop";

// 최근 본 해변 (노션 2장 HOME 5, Figma S_M01_01) — 재방문만. 첫 방문이면 FirstVisitCard
// 대표 1곳 카드(상태 배지) + 나머지 칩(✕로 확인 없이 지우고 토스트 '되돌리기')
// 모바일 칩은 2줄까지, 넘치면 'n곳 더 보기' ↔ '접기'(노션 D18-12). PC는 모두 보임

// [1] Vue: props: { locale, beaches }. beaches = 최근 본 순서로 이미 고른 목록
export function RecentBeaches({
  locale,
  beaches,
}: {
  locale: Locale;
  beaches: BeachSummary[];
}) {
  const t = useTranslations("home.recent");
  const desktop = useDesktop();
  const listId = useId();
  const chipsRef = useRef<HTMLUListElement>(null);
  const [expanded, setExpanded] = useState(false);
  // 접었을 때 보일 칩 수. 칩 목록·폭이 바뀌면 다시 잼(잰 때의 열쇠가 다르면 null = 재는 중, 모두 그린 뒤 그리기 전에 잼)
  const [measured, setMeasured] = useState<{
    key: string;
    limit: number;
  } | null>(null);
  const [widthTick, setWidthTick] = useState(0);
  const chipIds = beaches.map((beach) => beach.id).join(",");
  const measureKey = `${chipIds}|${widthTick}`;
  const limit = measured?.key === measureKey ? measured.limit : null;
  useLayoutEffect(() => {
    if (desktop || expanded || limit !== null) return;
    const el = chipsRef.current;
    if (!el) return;
    const items = [...el.children] as HTMLElement[];
    const rows = [...new Set(items.map((item) => item.offsetTop))].sort(
      (a, b) => a - b,
    );
    setMeasured({
      key: measureKey,
      limit:
        rows.length <= 2
          ? items.length
          : items.filter((item) => item.offsetTop <= rows[1]!).length,
    });
  }, [desktop, expanded, limit, measureKey]);
  // 폭이 바뀌면(회전·창 크기) 다시 잼. 높이 변화는 무시
  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        setWidthTick((tick) => tick + 1);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [chipIds]);
  const tRoot = useTranslations(); // home.near.clearScope · activity.*
  const visits = useRecentVisits(); // 본 시각·그때 고른 활동(기기에만)
  const snapshot = useSnapshot(); // Vue: mapState
  const { confirmedUntilText } = useBadgeText();
  const { zonesText } = useMetaText();
  const toast = useToast();

  // [2] 배열 구조 분해: 첫 칸과 나머지. noUncheckedIndexedAccess라 first는 undefined일 수 있음
  const [first, ...rest] = beaches;
  if (!first) return null;
  // 모바일에서 접혀 있을 때만 잘라 보임
  const collapsed = !desktop && !expanded && limit !== null;
  const visible = limit ?? rest.length;
  const hidden = collapsed ? Math.max(0, rest.length - visible) : 0;
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
    isClear && time
      ? tRoot("home.near.clearScope", {
          zones: zonesText(first.warningZones),
          time,
        })
      : null;

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
        <ul
          id={listId}
          ref={chipsRef}
          aria-label={t("chips", { count: rest.length })}
          className="flex flex-wrap gap-2"
        >
          {/* Vue: v-for="beach in rest" :key="beach.id" */}
          {(collapsed ? rest.slice(0, visible) : rest).map((beach) => (
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
      {/* 칩을 모두 지우면 펼친 상태여도 '접기'를 두지 않음(가리킬 목록이 없음) */}
      {rest.length > 0 && (hidden > 0 || (expanded && !desktop)) && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((open) => !open)}
          className="inline-flex min-h-touch items-center self-start text-label-s font-bold text-text-body"
        >
          {expanded ? t("less") : t("more", { count: hidden })}
        </button>
      )}
      <Toast message={toast.message} onHold={toast.hold} />
    </section>
  );
}

// PC 가운데 열의 최근 본 해변 빈 상태 (BRD-129). Figma PC 배치(해상 특보 / 최근 본 해변 / 안내)를 지키려고
// 첫 방문에도 같은 제목 + 최근 본 카드와 같은 모양의 안내 카드. 모바일 첫 방문은 '처음 오셨네요'(Figma 171:563)
export function RecentEmpty() {
  const t = useTranslations("home.recent");
  return (
    <section aria-labelledby="home-recent" className="flex flex-col gap-2.5">
      <SectionHead id="home-recent" title={t("title")} />
      <div className="flex flex-col gap-0.5 rounded-card bg-bg-surface px-3.5 py-[13px] shadow-card">
        <p className="text-title-s text-text-default">{t("emptyTitle")}</p>
        <p className="text-caption text-text-muted">{t("emptyBody")}</p>
      </div>
    </section>
  );
}
