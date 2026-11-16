"use client"; // 기기 저장(즐겨찾기·최근 본·정렬)·위치·바다 정보를 쓰므로 브라우저 부품

import { Clock, Star } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useLayoutEffect, useMemo, useRef } from "react";

import type { FavoriteItem } from "@/components/favorites/favorite-parts";
import { FavoritesList } from "@/components/favorites/favorites-list";
import { FavoritesSummary } from "@/components/favorites/favorites-summary";
import { FavoritesTable } from "@/components/favorites/favorites-table";
import { SampleNote } from "@/components/sample-note";
import { SituationBanner } from "@/components/situation-banner";
import { KmaSourceNote } from "@/components/source-note";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SCREEN_TITLE_CLASS } from "@/components/ui/screen-title";
import { BeachRowSkeleton } from "@/components/ui/skeleton";
import { Toast, useToast } from "@/components/ui/toast";
import { ViewToggle } from "@/components/ui/view-toggle";
import { SOURCE_URL } from "@/lib/agencies";
import type { BeachSummary } from "@/lib/beach-summary";
import { cn } from "@/lib/cn";
import {
  clearRecent,
  RECENT_MAX,
  removeFavorite,
  toggleFavorite,
  useFavorites,
  useRecent,
} from "@/lib/favorites";
import {
  FAVORITES_CATEGORY_ORDER,
  setFavoritesSort,
  sortFavoriteItems,
  useFavoritesSort,
} from "@/lib/favorites-sort";
import { distanceKm, type LatLng } from "@/lib/geo";
import { localizedPath, type Locale } from "@/lib/i18n";
import { showsKmaSource } from "@/lib/kma-source";
import { useUserLocation } from "@/lib/location";
import { useRecentVisits, type Visits } from "@/lib/recent-visits";
import {
  noConfirmedVerdict,
  pickSituation,
  shownDataTime,
} from "@/lib/situation";
import { kstStamp } from "@/lib/snapshot/clock";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import {
  deriveBeachView,
  type BeachView,
  type ViewSource,
} from "@/lib/snapshot/view";
import {
  clearCheckedAt,
  countByStatus,
  staleCheckedAt,
} from "@/lib/status-count";
import { useOnline } from "@/lib/use-online";

// 즐겨찾기 (BRD-35 · GH-530 · 결정 기록 29장 D29-3·D29-6·D29-8, 노션 2장 FAV·D-FAV)
// [즐겨찾기 n | 최근 본] 전환 → 요약 한 줄(개수·사유별 개수·시각 + 정렬/모두 지우기) → PC 비교 표 / 모바일 해변별 덩어리
// 즐겨찾기·최근 본은 기기에만 저장(로그인 없음, D1). 노출 끈 해변은 목록에서 빼고 기기 기록은 지우지 않음(9장)
// 상태는 게시된 분류 그대로(G1). 지난 방문과 비교하는 변경 표시는 V2 출시에서 뺌(12장 결정 11, BRD-101)

type Tab = "favorites" | "recent";

type RawItem = {
  beach: BeachSummary;
  view: BeachView;
  distanceKm: number | null;
  visitedAt: string | null;
};

type PendingFocus = { type: "star"; id: string } | { type: "title" } | null;

function toItems(
  ids: readonly string[],
  byId: ReadonlyMap<string, BeachSummary>,
  source: ViewSource,
  coords: LatLng | null,
  visits: Visits | null,
): RawItem[] {
  return ids.flatMap((id) => {
    const beach = byId.get(id);
    if (!beach) return [];
    return [
      {
        beach,
        view: deriveBeachView({ id, hidden: false }, source),
        distanceKm: coords ? distanceKm(coords, beach.coords) : null,
        visitedAt: visits?.[id]?.at ?? null,
      },
    ];
  });
}

export function FavoritesScreen({
  locale,
  beaches,
  sampleSnapshot,
}: {
  locale: Locale;
  beaches: BeachSummary[];
  sampleSnapshot: boolean; // 개발용 예시 특보·관측값을 보는 중. 배포 빌드는 늘 false
}) {
  const t = useTranslations();
  const params = useSearchParams();
  const snapshot = useSnapshot();
  const online = useOnline();
  const location = useUserLocation();
  const favoriteIds = useFavorites();
  const recentIds = useRecent();
  const visits = useRecentVisits();
  const sort = useFavoritesSort();
  const toast = useToast();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef<PendingFocus>(null);

  // 보는 칸은 주소(?tab=recent)를 따름: 홈 '최근 본 해변 · 전체 보기'로 들어오고, 탭 이동 뒤 돌아와도 그대로
  const tab: Tab = params.get("tab") === "recent" ? "recent" : "favorites";
  function setTab(next: Tab) {
    const path = window.location.pathname;
    window.history.replaceState(
      null,
      "",
      next === "recent" ? `${path}?tab=recent` : path,
    );
  }

  // 거리는 위치 권한이 허용돼 기기가 받은 좌표가 있을 때만 계산(서버로 보내지 않음)
  const coords = location.status === "ready" ? location.coords : null;

  const byId = useMemo(
    () => new Map(beaches.map((beach) => [beach.id, beach])),
    [beaches],
  );
  const favoriteSet = useMemo(() => new Set(favoriteIds), [favoriteIds]);

  const favorites = useMemo(
    () => toItems(favoriteIds, byId, snapshot, coords, null),
    [favoriteIds, byId, snapshot, coords],
  );
  const recent = useMemo(
    () => toItems(recentIds, byId, snapshot, coords, visits),
    [recentIds, byId, snapshot, coords, visits],
  );
  const loading = snapshot.phase === "loading";

  // 확인된 판단 없음은 노출 중인 전체 해변으로 봄(탐색과 같은 규칙, BRD-38)
  const noConfirmed = useMemo(
    () =>
      noConfirmedVerdict(
        beaches.map((beach) =>
          deriveBeachView({ id: beach.id, hidden: false }, snapshot),
        ),
      ),
    [beaches, snapshot],
  );

  // 상황 배너는 하나만(탐색과 같은 범위: 오프라인 → 지원 밖 형식 → 불러오기 실패 → 확인된 판단 없음). 관측 지연은 행 배지가 보여 줌
  const situation = pickSituation<Pick<BeachSummary, "name" | "slug">>({
    phase: snapshot.phase,
    live: snapshot.live,
    failedOnline: snapshot.failedOnline,
    online,
    delayed: [],
    locationOff: false,
    noConfirmed,
    notice: null,
  });

  const rawItems = tab === "favorites" ? favorites : recent;
  const readyItems = useMemo<FavoriteItem[]>(() => {
    const ready = rawItems.flatMap((item) =>
      item.view.kind === "ready"
        ? [{ ...item, view: item.view } satisfies FavoriteItem]
        : [],
    );
    return tab === "favorites" ? sortFavoriteItems(ready, sort) : ready;
  }, [rawItems, tab, sort]);

  // 별 빼기·전체 지우기·빈 상태 전환 뒤 포커스가 사라지지 않게 다음 보이는 별 버튼 또는 목록 머리로 옮김
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending) return;
    pendingFocusRef.current = null;
    if (pending.type === "title") {
      titleRef.current?.focus();
      return;
    }
    const buttons = containerRef.current?.querySelectorAll<HTMLButtonElement>(
      `[data-favorite-star="${CSS.escape(pending.id)}"]`,
    );
    const visible = buttons
      ? [...buttons].find((button) => button.getClientRects().length > 0)
      : null;
    (visible ?? titleRef.current)?.focus();
  });

  function handleStar(item: FavoriteItem, index: number) {
    const id = item.beach.id;
    if (favoriteSet.has(id)) {
      if (tab === "favorites") {
        const nextItem = readyItems[index + 1];
        pendingFocusRef.current = nextItem
          ? { type: "star", id: nextItem.beach.id }
          : { type: "title" };
      }
      const undo = removeFavorite(id);
      toast.show({
        text: t("favorites.removed"),
        action: { label: t("favorites.undo"), onClick: undo },
      });
      return;
    }
    toggleFavorite(id);
  }

  function removeAll() {
    pendingFocusRef.current = { type: "title" };
    const undo = clearRecent();
    toast.show({
      text: t("favorites.recent.cleared"),
      action: { label: t("favorites.recent.undo"), onClick: undo },
    });
  }

  const nowMs = snapshot.nowMs;
  const readyViews = useMemo(
    () => readyItems.map((item) => item.view),
    [readyItems],
  );
  // 요약 줄 개수도 상태 먼저 순서(이용불가 → 판단불가 → 특보 없음). 같은 분류 안은 먼저 나온 사유가 앞
  const reasonCounts = useMemo(
    () =>
      (countByStatus(readyViews) ?? []).sort(
        (a, b) =>
          FAVORITES_CATEGORY_ORDER.indexOf(a.category) -
          FAVORITES_CATEGORY_ORDER.indexOf(b.category),
      ),
    [readyViews],
  );
  const dataTime = shownDataTime(snapshot.manifest?.generatedAt, nowMs);
  const hasClear = readyViews.some(
    (view) => !view.stale && view.badge.kind === "clear",
  );
  const checkedAt = clearCheckedAt(readyViews);
  const clearTime = kstStamp(checkedAt, nowMs);
  const hasAnyPhoto = readyItems.some((item) => item.beach.photo !== null);

  const exploreButton = (
    <Button asChild className="h-[46px]">
      <Link href={localizedPath(locale, "/explore/")}>
        {t("favorites.empty.action")}
      </Link>
    </Button>
  );

  return (
    <div
      ref={containerRef}
      className="flex flex-col gap-3.5 pt-4 lg:mx-auto lg:w-full lg:max-w-[1036px] lg:pt-0"
    >
      {/* 머리(D29-6): 제목 + 오른쪽 [즐겨찾기 n | 최근 본](260px) */}
      <div className="flex flex-col gap-3.5 lg:flex-row lg:items-center lg:justify-between">
        <h1
          ref={titleRef}
          tabIndex={-1}
          className={cn(SCREEN_TITLE_CLASS, "outline-none")}
        >
          {t("pages.favorites")}
        </h1>
        <ViewToggle<Tab>
          label={t("favorites.tabsLabel")}
          options={[
            {
              value: "favorites",
              label: t("favorites.tabFavorites", { count: favorites.length }),
            },
            { value: "recent", label: t("favorites.tabRecent") },
          ]}
          value={tab}
          onChange={setTab}
          className="lg:w-[260px]"
        />
      </div>

      {sampleSnapshot && <SampleNote />}

      <SituationBanner
        locale={locale}
        situation={situation?.kind === "noLocation" ? null : situation}
        snapshot={snapshot}
        onRetrySucceeded={() => titleRef.current?.focus()}
      />

      {rawItems.length === 0 ? (
        <>
          <div className="rounded-card border border-border-default bg-bg-surface shadow-card">
            {tab === "favorites" ? (
              <EmptyState
                icon={<Star size={26} />}
                title={t("favorites.empty.title")}
                description={t("favorites.empty.body")}
                action={
                  <div className="flex flex-wrap items-center justify-center gap-2.5">
                    {exploreButton}
                    {recent.length > 0 && (
                      <Button
                        variant="secondary"
                        className="h-[46px]"
                        onClick={() => {
                          pendingFocusRef.current = { type: "title" };
                          setTab("recent");
                        }}
                      >
                        {/* Button의 gap이 문구 조각 사이에 끼지 않게 한 덩어리로 묶음 */}
                        <span>
                          {t.rich("favorites.empty.recentAction", {
                            count: recent.length,
                            b: (chunks) => (
                              <strong className="font-bold">{chunks}</strong>
                            ),
                          })}
                        </span>
                      </Button>
                    )}
                  </div>
                }
              />
            ) : (
              <EmptyState
                icon={<Clock size={26} />}
                title={t("favorites.recentEmpty.title")}
                description={t("favorites.recentEmpty.body")}
                action={exploreButton}
              />
            )}
          </div>
          <p className="text-caption text-text-muted">
            {tab === "favorites"
              ? t("favorites.deviceNoteEmpty")
              : t("favorites.deviceNote")}
          </p>
        </>
      ) : loading ? (
        <>
          <BeachRowSkeleton
            rows={Math.min(rawItems.length, 4)}
            label={t("favorites.loading")}
          />
          <p className="text-caption text-text-muted">
            {t("favorites.deviceNote")}
          </p>
        </>
      ) : (
        <div className="flex flex-col gap-3.5">
          <FavoritesSummary
            tab={tab}
            total={readyItems.length}
            counts={reasonCounts}
            time={dataTime}
            stale={staleCheckedAt(readyViews)}
            nowMs={nowMs}
            hasDistance={coords !== null}
            sort={sort}
            onSortChange={setFavoritesSort}
            onClearRecent={removeAll}
          />

          <FavoritesTable
            locale={locale}
            tab={tab}
            items={readyItems}
            favoriteIds={favoriteSet}
            snapshot={snapshot}
            nowMs={nowMs}
            onStar={handleStar}
          />

          <FavoritesList
            locale={locale}
            items={readyItems}
            favoriteIds={favoriteSet}
            snapshot={snapshot}
            nowMs={nowMs}
            onStar={handleStar}
          />

          <div className="flex flex-col gap-0.5 text-caption text-text-muted">
            {hasClear && (
              <p>
                {clearTime
                  ? t("home.region.countScope", { time: clearTime })
                  : t("home.region.countScopeNoTime")}
              </p>
            )}
            <p>
              {t("favorites.clearIsNotSafe")} · {t("safety.finalCall")}
            </p>
            {showsKmaSource(snapshot, sampleSnapshot) && (
              <KmaSourceNote variant="status" />
            )}
            <p>
              {hasAnyPhoto
                ? t.rich("favorites.photoNote", {
                    source: t("observation.agency.kto"),
                    license: t("photo.license.kogl-type1"),
                    link: (chunks) => (
                      <a
                        href={SOURCE_URL.tourApi}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2"
                      >
                        {chunks}
                        <span className="sr-only">
                          {" "}
                          ({t("common.newWindow")})
                        </span>
                      </a>
                    ),
                  })
                : t("favorites.photoNoteNoPhoto")}
            </p>
            <p>
              {tab === "favorites"
                ? t("favorites.deviceNoteSort")
                : t("favorites.deviceNoteRecent", { max: RECENT_MAX })}
            </p>
            {tab === "favorites" && (
              <p className="hidden lg:block">{t("favorites.tableOrderNote")}</p>
            )}
          </div>
        </div>
      )}

      <Toast message={toast.message} onHold={toast.hold} />
    </div>
  );
}

// 정적 HTML·주소 읽기 전 자리. 제목은 그대로 두고 목록 자리는 불러오는 모양
export function FavoritesFallback() {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-3.5 pt-4 lg:mx-auto lg:w-full lg:max-w-[1036px] lg:pt-0">
      <h1 className={SCREEN_TITLE_CLASS}>{t("pages.favorites")}</h1>
      <BeachRowSkeleton label={t("favorites.loading")} />
    </div>
  );
}
