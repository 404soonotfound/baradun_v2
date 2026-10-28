"use client"; // 활동·위치·지역·정렬·바다 정보를 쓰므로 브라우저 부품

import { Search, SearchX } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";

import { BeachRow } from "@/components/beach-row";
import { ExploreFilters } from "@/components/explore/explore-filters";
import { LocationOffBanner } from "@/components/home/location-off-banner";
import { BeachMarkers, type MapMarker } from "@/components/map/beach-markers";
import { MapCard } from "@/components/map/map-card";
import { MapLegend } from "@/components/map/map-legend";
import { MapView } from "@/components/map/map-view";
import { RegionSheet } from "@/components/region/region-sheet";
import { SituationBanner } from "@/components/situation-banner";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { BeachRowSkeleton } from "@/components/ui/skeleton";
import { StatusGroup } from "@/components/ui/status-group";
import { ViewToggle } from "@/components/ui/view-toggle";
import { useActivity } from "@/lib/activity";
import type { BeachSummary } from "@/lib/beach-summary";
import {
  buildItems,
  exploreMode,
  filterBeaches,
  groupItems,
  isLoading,
  noClearAtAll,
  sortItems,
  type ExploreGroup,
  type ExploreItem,
  type SortChoice,
} from "@/lib/explore";
import { setSortChoice, useSortChoice } from "@/lib/explore-sort";
import {
  setExploreView,
  useExploreView,
  type ExploreView,
} from "@/lib/explore-view";
import { cn } from "@/lib/cn";
import { localizedPath, type Locale } from "@/lib/i18n";
import { useUserLocation } from "@/lib/location";
import { boundsOf } from "@/lib/map/bounds";
import { formatKm, joinMeta } from "@/lib/meta-join";
import { setRegion, useRegion } from "@/lib/region";
import {
  regionChips,
  regionGroups,
  regionName,
  validRegion,
} from "@/lib/region-list";
import { pickSituation, shownDataTime, sourceOutage } from "@/lib/situation";
import { kstStamp } from "@/lib/snapshot/clock";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useRowText } from "@/lib/snapshot/use-row-text";
import { deriveBeachView, hidesLastValues } from "@/lib/snapshot/view";
import { clearCheckedAt } from "@/lib/status-count";
import { useOnline } from "@/lib/use-online";
import { useSheet } from "@/lib/use-sheet";

// 탐색 목록 (BRD-29 · 노션 2장 EXP-L·D-EXP, Figma S_M02_01~07)
// 위에서 아래: 제목 → 검색 입구 → 활동·지역 칩 → 상황 배너(하나) → 보기 전환 → "전체 n곳 · 시각" → 목록
// 목록: 상태별(특보 없음 → 이용불가 → 판단불가 묶음) 또는 가까운 순/이름 순 한 목록. 순위·점수·추천 표시 없음
// 분류는 스냅샷 게시값 그대로(G1). PC(lg)는 왼쪽 448px 목록 열 + 오른쪽 지도(BRD-65, 탐색에 들어오면 불러옴)
// 지도(BRD-30 · EXP-M·D-EXP): 모바일은 [목록 | 지도]로 바꿔 봄(기기 저장), PC는 목록과 지도를 함께
//   마커(상태 아이콘 + 짧은 이름) → 아래 카드가 그 해변으로 바뀜 → 카드를 누르면 상세. PC 목록 행을 가리키면 마커 강조
//   지도 없이도 같은 해변·상태를 목록에서 키보드로 모두 볼 수 있음(마커는 Tab에서 뺌)

export function ExploreScreen({
  locale,
  beaches,
  sampleSnapshot,
}: {
  locale: Locale;
  beaches: BeachSummary[];
  sampleSnapshot: boolean; // 개발용 예시 특보·관측값을 보는 중. 배포 빌드는 늘 false
}) {
  const t = useTranslations();
  const intlLocale = useLocale();
  const activity = useActivity();
  const location = useUserLocation();
  const snapshot = useSnapshot();
  const online = useOnline();
  const sortChoice = useSortChoice();
  const view = useExploreView();
  const { badgeText } = useBadgeText();
  const { rowMeta, rowDetail } = useRowText();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const regionSheet = useSheet("region");
  // 위치 안내 배너를 닫았는지. 이번 방문 동안만 기억
  const [offBannerClosed, setOffBannerClosed] = useState(false);
  // 시·군 시트로 열어 줄 시·도(칩에서 누른 것). 저장 값과 별개
  const [pickSido, setPickSido] = useState<string | null>(null);
  // 지도에서 고른 해변(카드)과 PC 목록에서 가리킨 해변(마커 강조)
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  // 지역은 홈 기본 지역과 같은 저장 값(10/27 결정). 목록에 없어진 지역이면 전국으로 봄
  const region = validRegion(useRegion(), beaches);
  const chips = useMemo(() => regionChips(beaches), [beaches]);
  const groups = useMemo(() => regionGroups(beaches), [beaches]);
  const name = region === null ? null : regionName(groups, region);

  // 위치는 거리 계산에만 쓰고 저장·전송하지 않음
  const coords = location.status === "ready" ? location.coords : null;
  const mode = exploreMode(sortChoice, coords !== null);

  // 해변 → 목록 줄. 화면 상태는 게시된 분류 그대로(deriveBeachView는 만료·오프라인 때 판단불가로 내리기만 함)
  const shown = useMemo(
    () => filterBeaches(beaches, activity, region),
    [beaches, activity, region],
  );
  const items = useMemo(
    () =>
      buildItems(shown, coords, (beach) =>
        deriveBeachView({ id: beach.id, hidden: false }, snapshot),
      ),
    [shown, coords, snapshot],
  );
  // 지도 범위 = 지금 목록에 보이는 해변(사용자 위치로 옮기지 않음)
  const mapBounds = useMemo(
    () => boundsOf(shown.map((beach) => beach.coords)),
    [shown],
  );
  const loading = isLoading(items);
  // 지도 마커: 상태를 받은 해변만(첫 응답 전에는 마커를 미리 그리지 않음)
  const markers = useMemo<MapMarker[]>(
    () =>
      items.flatMap((item) =>
        item.view.kind === "ready"
          ? [
              {
                id: item.id,
                name: item.name,
                coords: item.coords,
                badge: item.view.badge,
              },
            ]
          : [],
      ),
    [items],
  );
  // 고른 해변이 거르기로 빠지면 카드도 닫힘
  const selectedItem = items.find((item) => item.id === selectedId) ?? null;
  const statusGroups = useMemo(
    () => (mode === "status" && !loading ? groupItems(items, intlLocale) : []),
    [mode, loading, items, intlLocale],
  );
  const flatItems = useMemo(
    () =>
      mode === "status" || loading
        ? []
        : sortItems(items, mode === "near" ? "near" : "name", intlLocale),
    [mode, loading, items, intlLocale],
  );

  // 상황 배너는 하나만(BRD-28 · 상세와 같은 범위: 오프라인 → 지원 밖 형식 → 불러오기 실패, 10/27 임시안)
  // 그 밖에 '특보 없음이 하나도 없음' → '위치 꺼짐' 순. 관측 지연은 행의 사유 배지가 이미 보여 줌
  const picked = pickSituation<Pick<BeachSummary, "name" | "slug">>({
    phase: snapshot.phase,
    live: snapshot.live,
    failedOnline: snapshot.failedOnline,
    online,
    delayed: [],
    locationOff: false,
    // 판단 출처 전체 장애는 노출 중인 전체 해변으로 봄(고른 지역·활동과 무관, BRD-38)
    outage: sourceOutage(
      beaches.map((beach) =>
        deriveBeachView({ id: beach.id, hidden: false }, snapshot),
      ),
    ),
  });
  // 위치 배너는 아래에서 따로 그리므로(locationOff: false로 부름) 공용 배너에는 데이터 상황만 넘김
  const situation = picked?.kind === "noLocation" ? null : picked;
  // 점검·강제 업데이트 중에는 해변이 모두 값을 숨긴 판단불가라 '특보 없는 곳 없음'으로 말하지 않음(덮는 화면이 알림)
  const noClear =
    situation === null &&
    !hidesLastValues(snapshot.phase) &&
    noClearAtAll(items, snapshot.live);
  const locationOff =
    situation === null &&
    !noClear &&
    !offBannerClosed &&
    (location.status === "denied" || location.status === "unavailable");

  const dataTime = shownDataTime(
    snapshot.manifest?.generatedAt,
    snapshot.nowMs,
  );
  const nowMs = snapshot.nowMs;

  // 특보 없음 범위 줄: "특보 없음: 각 해변 특보구역 · 기상청 14:30 확인". 가장 이른 확인 시각(집계 규칙)
  function clearScope(checkedAt: string | null): string {
    const time = kstStamp(checkedAt, nowMs);
    return time
      ? t("home.region.countScope", { time })
      : t("home.region.countScopeNoTime");
  }

  // 묶음 오른쪽 "가장 가까운 곳 2.1km". 위치가 없거나 거리를 읽을 수 없으면 없음
  function nearestText(nearestKm: number | null): string | null {
    const km = nearestKm === null ? null : formatKm(nearestKm);
    return km === null ? null : t("explore.group.nearest", { km });
  }

  function renderRow(item: ExploreItem) {
    const view = item.view;
    if (view.kind !== "ready") return null;
    return (
      <li key={item.id}>
        <BeachRow
          href={localizedPath(locale, `/spots/${item.slug}/`)}
          name={item.name}
          meta={rowMeta(item.region, item.distanceKm, view, nowMs)}
          wave={view.metrics.waveHeight}
          status={view.badge}
          detail={rowDetail(view, nowMs)}
          // PC 지도에서 고른 해변은 행도 강조(파란 줄 + 연한 바탕)
          highlight={item.id === selectedId}
          onHighlight={(on) =>
            setHighlightedId((current) =>
              on ? item.id : current === item.id ? null : current,
            )
          }
        />
      </li>
    );
  }

  function renderGroup(group: ExploreGroup) {
    const tone =
      group.category === "clear"
        ? "clear"
        : group.category === "unavailable"
          ? "blocked"
          : "unknown";
    return (
      <StatusGroup
        key={group.category}
        tone={tone}
        title={t(`explore.group.${group.category}`, {
          count: group.items.length,
        })}
        aside={nearestText(group.nearestKm)}
        // 사유가 섞이면 사유별 개수. 특보 없음 묶음은 범위·기관·확인 시각
        summary={
          group.category === "clear"
            ? clearScope(group.checkedAt)
            : group.counts.length > 1
              ? group.counts
                  .map((item) => `${badgeText(item.label)} ${item.count}`)
                  .join(" · ")
              : null
        }
        notes={group.category === "clear" ? [t("safety.finalCall")] : []}
      >
        {group.items.map(renderRow)}
      </StatusGroup>
    );
  }

  // 한 목록(가까운 순·이름 순)에 특보 없음이 있으면 범위 줄, 늘 현장 우선 문구
  const flatClearViews = flatItems.flatMap((item) =>
    item.view.kind === "ready" ? [item.view] : [],
  );
  const flatHasClear = flatClearViews.some(
    (view) => !view.stale && view.badge.kind === "clear",
  );

  // 지도에 특보 없음 마커가 있으면 범례 아래에 범위·기관·가장 이른 확인 시각(점검표 5)
  const readyViews = items.flatMap((item) =>
    item.view.kind === "ready" ? [item.view] : [],
  );
  const mapClearScope = readyViews.some(
    (item) => !item.stale && item.badge.kind === "clear",
  )
    ? clearScope(clearCheckedAt(readyViews))
    : null;

  const countText = t("explore.count", { count: items.length });
  const secondLabel = coords ? t("explore.sort.near") : t("explore.sort.name");

  return (
    <div className="lg:grid lg:grid-cols-[448px_minmax(0,1fr)] lg:items-start lg:gap-6">
      <div className="flex flex-col gap-4">
        <h1
          ref={titleRef}
          tabIndex={-1}
          className="text-title-xl text-text-default outline-none"
        >
          {t("pages.explore")}
        </h1>

        {/* 검색 입구(누르면 검색 화면). PC는 상단 내비에 검색이 있어 숨김 */}
        <Link
          href={localizedPath(locale, "/search/")}
          className="flex h-search items-center gap-2.5 rounded-input border border-border-strong bg-bg-surface px-[15px] text-[15px] text-text-muted lg:hidden"
        >
          <Search aria-hidden="true" size={17} className="shrink-0" />
          {t("home.top.search")}
        </Link>

        <ExploreFilters
          chips={chips}
          region={region}
          regionLabel={name}
          onNationwide={() => setRegion(null)}
          // 시트에서 고르기 전에는 저장하지 않음(그냥 닫으면 지역이 그대로)
          onPickSido={(sido) => {
            setPickSido(sido);
            regionSheet.show();
          }}
        />

        {sampleSnapshot && (
          <p
            role="note"
            className="rounded-card bg-bg-surface px-4 py-3 text-body-s text-text-body shadow-card"
          >
            {t("home.sampleSnapshot")}
          </p>
        )}

        {/* 상황 배너 자리(하나만) */}
        <SituationBanner
          locale={locale}
          situation={situation}
          snapshot={snapshot}
          onRetrySucceeded={() => titleRef.current?.focus()}
        />
        {noClear && (
          <Banner
            tone="gray"
            icon={<SearchX size={16} />}
            title={t("explore.noClear.title")}
          >
            {t("explore.noClear.body")}
          </Banner>
        )}
        {locationOff && (
          <LocationOffBanner
            locale={locale}
            status={location.status}
            onClose={() => setOffBannerClosed(true)}
            title={t("explore.locationOff.title")}
            body={t("explore.locationOff.body")}
          />
        )}

        <div className="flex gap-2">
          {/* 정렬은 목록에만. 모바일 지도 보기에서는 숨김(PC는 목록이 늘 보임) */}
          <ViewToggle<SortChoice>
            label={t("explore.sortLabel")}
            className={cn("flex-1", view === "map" && "hidden lg:flex")}
            options={[
              { value: "status", label: t("explore.sort.status") },
              { value: "second", label: secondLabel },
            ]}
            value={sortChoice}
            onChange={setSortChoice}
          />
          {/* [목록 | 지도]는 모바일만(PC는 둘 다 보임). 지도 보기면 오른쪽으로 붙임 */}
          <ViewToggle<ExploreView>
            label={t("explore.view.label")}
            className="ml-auto w-[120px] shrink-0 lg:hidden"
            options={[
              { value: "list", label: t("explore.view.list") },
              { value: "map", label: t("explore.view.map") },
            ]}
            value={view}
            onChange={setExploreView}
          />
        </div>

        {!loading && (
          <div className="flex flex-col gap-0.5 text-caption text-text-muted">
            {activity !== "swimming" && items.length > 0 && (
              <p>{t("explore.activityNote", { count: items.length })}</p>
            )}
            {/* 결과가 없으면 '전체 0곳'을 되풀이하지 않고 아래 빈 화면이 말함 */}
            {items.length > 0 && (
              <p>
                {joinMeta([
                  countText,
                  dataTime && t("explore.updatedAt", { time: dataTime }),
                ])}
              </p>
            )}
          </div>
        )}

        {/* 모바일 지도 보기에서는 목록을 숨김(PC는 늘 보임) */}
        <div className={cn(view === "map" && "hidden lg:block")}>
          {loading ? (
            <BeachRowSkeleton label={t("explore.loading")} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={<SearchX size={26} />}
              title={t("explore.empty.title")}
              description={t("explore.empty.body")}
              action={
                region !== null ? (
                  <Button variant="secondary" onClick={() => setRegion(null)}>
                    {t("explore.empty.action")}
                  </Button>
                ) : undefined
              }
            />
          ) : mode === "status" ? (
            <div className="flex flex-col gap-5">
              {statusGroups.map(renderGroup)}
              {/* 특보 없음 묶음이 없으면(이용불가·판단불가만, 오프라인 포함) 묶음 안내가 없으니 목록 아래에 한 번 둠 */}
              {!statusGroups.some((group) => group.category === "clear") && (
                <p className="text-caption text-text-muted">
                  {t("safety.finalCall")}
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <ul className="divide-y divide-border-default overflow-hidden rounded-card bg-bg-surface shadow-card">
                {flatItems.map(renderRow)}
              </ul>
              <div className="flex flex-col gap-0.5 text-caption text-text-muted">
                {flatHasClear && (
                  <p>{clearScope(clearCheckedAt(flatClearViews))}</p>
                )}
                <p>{t("safety.finalCall")}</p>
              </div>
            </div>
          )}
        </div>

        {/* 시·군 고르기 시트. 시·도 칩을 누르면 그 시·도의 시·군 단계로 열림 */}
        <RegionSheet
          open={regionSheet.open}
          onClose={regionSheet.close}
          groups={groups}
          value={region}
          startSido={pickSido}
          onSelect={(next) => {
            setRegion(next);
            regionSheet.close();
          }}
        />
      </div>

      {/* 지도(EXP-M·D-EXP). 모바일은 지도 보기에서만 보이고, 숨긴 동안은 불러오지 않음(MapView가 보일 때 시작)
          PC는 오른쪽 열에 늘 보임. 지도가 실패해도 목록은 그대로 */}
      <div
        className={cn(
          view === "map" ? "mt-4 flex flex-col gap-3" : "hidden",
          "lg:sticky lg:top-[88px] lg:mt-0 lg:block",
        )}
      >
        <p className="sr-only">{t("map.listNote")}</p>
        <MapView
          locale={locale}
          bounds={mapBounds}
          className="h-[62dvh] min-h-[380px] lg:h-[calc(100dvh-112px)]"
          onShowList={() => setExploreView("list")}
          overlay={(api) => (
            <>
              <BeachMarkers
                api={api}
                markers={markers}
                selectedId={selectedId}
                highlightedId={highlightedId}
                onSelect={setSelectedId}
              />
              {/* PC는 범례를 지도 왼쪽 위에, 모바일은 지도를 덜 가리게 지도 아래에 */}
              <MapLegend
                clearScope={mapClearScope}
                className="absolute top-3 left-3 hidden max-w-[360px] lg:flex"
              />
              {selectedItem && (
                <MapCard
                  locale={locale}
                  item={selectedItem}
                  nowMs={nowMs}
                  onClose={() => setSelectedId(null)}
                  className="absolute inset-x-3 bottom-3 lg:right-auto lg:w-[380px]"
                />
              )}
            </>
          )}
        />
        <MapLegend clearScope={mapClearScope} className="lg:hidden" />
      </div>
    </div>
  );
}
