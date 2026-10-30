"use client"; // 위치·지역·정렬·바다 정보를 쓰므로 브라우저 부품

import { Search, SearchX } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";

import { BeachRow } from "@/components/beach-row";
import { LocationOffBanner } from "@/components/home/location-off-banner";
import { BeachMarkers, type MapMarker } from "@/components/map/beach-markers";
import { MapCard } from "@/components/map/map-card";
import { MapLegend } from "@/components/map/map-legend";
import { MapView } from "@/components/map/map-view";
import { RegionSheet } from "@/components/region/region-sheet";
import { SituationBanner } from "@/components/situation-banner";
import { KmaSourceNote } from "@/components/source-note";
import { Banner } from "@/components/ui/banner";
import { Chip } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { BeachRowSkeleton } from "@/components/ui/skeleton";
import { StatusGroup } from "@/components/ui/status-group";
import { ViewToggle } from "@/components/ui/view-toggle";
import type { BeachSummary } from "@/lib/beach-summary";
import {
  asksLocationOnNear,
  buildItems,
  exploreMode,
  filterBeaches,
  groupItems,
  isLoading,
  locationNotice,
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
import { showsKmaSource } from "@/lib/kma-source";
import { requestLocation, useUserLocation } from "@/lib/location";
import { boundsOf } from "@/lib/map/bounds";
import { formatKm } from "@/lib/meta-join";
import { setRegion, useRegion } from "@/lib/region";
import {
  NATIONWIDE,
  regionGroups,
  regionName,
  validRegion,
} from "@/lib/region-list";
import {
  pickSituation,
  shownDataTime,
  noConfirmedVerdict,
} from "@/lib/situation";
import { kstStamp } from "@/lib/snapshot/clock";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useRowText } from "@/lib/snapshot/use-row-text";
import { deriveBeachView, hidesLastValues } from "@/lib/snapshot/view";
import { clearCheckedAt } from "@/lib/status-count";
import { useOnline } from "@/lib/use-online";
import { useSheet } from "@/lib/use-sheet";

// 탐색 목록 (BRD-29 · 노션 2장 EXP-L·D-EXP, Figma S_M02_01~07)
// 위에서 아래: 제목 → 검색 입구 → 지역 버튼 → 상황 배너(하나) → 보기 전환 → "전체 n곳 · 시각" → 목록
// 활동으로 거르지 않음(BRD-128 · 10/30 결정): 고른 지역의 모든 해변. 판단은 활동과 무관(G1)
// 지역: 버튼 하나("강원 ⌄") → 홈과 같은 지역 시트(전국 · 시·도 → 시·군). 저장 값은 홈 기본 지역과 같은 칸
// 목록: 상태별(특보 없음 → 이용불가 → 판단불가 묶음) 또는 가까운 순 한 목록(위치가 없으면 이름 순). 순위·점수·추천 표시 없음
// 분류는 스냅샷 게시값 그대로(G1). PC(lg)는 왼쪽 448px 목록 열 + 오른쪽 지도(BRD-65, 탐색에 들어오면 불러옴)
// 지도(BRD-30 · EXP-M·D-EXP): 모바일은 [목록 | 지도]로 바꿔 봄(처음은 지도, 기기 저장 · BRD-128), PC는 목록과 지도를 함께
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
  // 지도에서 고른 해변(카드)과 PC 목록에서 가리킨 해변(마커 강조)
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  // 지역은 홈 기본 지역과 같은 저장 값(10/27 결정). 저장값 없음·목록에 없어진 지역·고른 전국은 전국으로 봄
  const saved = useRegion();
  const region = useMemo(() => validRegion(saved, beaches), [saved, beaches]);
  const groups = useMemo(() => regionGroups(beaches), [beaches]);
  const name = region === null ? null : regionName(groups, region);
  const regionLabel = name ?? t("explore.nationwide");

  // 위치는 거리 계산에만 쓰고 저장·전송하지 않음
  const coords = location.status === "ready" ? location.coords : null;
  const mode = exploreMode(sortChoice, location.status);

  // 해변 → 목록 줄. 화면 상태는 게시된 분류 그대로(deriveBeachView는 만료·오프라인 때 판단불가로 내리기만 함)
  const shown = useMemo(
    () => filterBeaches(beaches, region),
    [beaches, region],
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

  // 상황 배너는 하나만(BRD-28 · 상세와 같은 범위: 오프라인 → 지원 밖 형식 → 불러오기 실패 → 확인된 판단 없음, 결정 2로 확정)
  // 그 밖에 '특보 없음이 하나도 없음' → '위치 꺼짐' 순. 관측 지연은 행의 사유 배지가 이미 보여 줌
  const picked = pickSituation<Pick<BeachSummary, "name" | "slug">>({
    phase: snapshot.phase,
    live: snapshot.live,
    failedOnline: snapshot.failedOnline,
    online,
    delayed: [],
    locationOff: false,
    // 확인된 판단 없음은 노출 중인 전체 해변으로 봄(고른 지역과 무관, BRD-38)
    noConfirmed: noConfirmedVerdict(
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
  // 위치 안내(Figma S_M02_06): 거부·끔·받지 못함, 또는 가까운 순인데 아직 묻지 않음 → 이름 순인 이유
  const notice = locationNotice(sortChoice, location.status);
  const locationOff =
    situation === null && !noClear && !offBannerClosed && notice !== null;
  const noticeTitle =
    notice === "denied"
      ? t("explore.locationOff.deniedTitle")
      : notice === "failed"
        ? t("explore.locationOff.failedTitle")
        : t("explore.locationOff.title");

  // 정렬 고르기. '가까운 순'을 눌렀는데 위치가 없으면 그때 물음(사용자가 누른 것, 반복 요청 아님)
  // 거부·끔은 다시 묻지 않고 이름 순 + 안내. 닫아 둔 안내도 다시 보임(누른 결과를 알 수 있게)
  function pickSort(next: SortChoice) {
    setSortChoice(next);
    if (next !== "second") return;
    setOffBannerClosed(false);
    if (asksLocationOnNear(location.status)) requestLocation();
  }

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

  // 기상청 출처(BRD-113 · 기상법): 받은 실제 상태가 있을 때 목록 아래·지도 아래에 한 줄.
  // 불러오는 중·처음부터 못 받음·개발용 예시는 숨김(showsKmaSource). 결과 없음은 목록 자리째 빈 화면이라 붙지 않음
  const hasKmaData = showsKmaSource(snapshot, sampleSnapshot);

  // "전체 n곳 · 14:30 업데이트"(Figma 173:558: 개수 14 굵게 + 시각 12 보조색). 결과가 없으면 아래 빈 화면이 말함
  const showCount = !loading && items.length > 0;
  const updated = dataTime ? t("explore.updatedAt", { time: dataTime }) : null;
  // map = 모바일 지도 보기 줄(Figma 174:906: 12 보조색 한 줄). PC는 목록 줄과 같은 모양
  function countLine(variant: "list" | "map", className?: string) {
    return (
      <p className={cn("text-caption text-text-muted", className)}>
        <span
          className={
            variant === "list"
              ? "text-body font-bold text-text-default"
              : "lg:text-body lg:font-bold lg:text-text-default"
          }
        >
          {t("explore.count", { count: items.length })}
        </span>
        {updated && ` · ${updated}`}
      </p>
    );
  }

  return (
    <div className="lg:grid lg:grid-cols-[448px_minmax(0,1fr)] lg:items-start lg:gap-6">
      {/* 묶음 간격: 모바일 12(Figma pad.stack), 머리(제목·검색·지역)는 11. PC는 16 그대로 */}
      <div className="flex flex-col gap-3 lg:gap-4">
        <div className="flex flex-col gap-[11px] lg:gap-4">
          <h1
            ref={titleRef}
            tabIndex={-1}
            className="text-title-xl text-text-default outline-none"
          >
            {t("pages.explore")}
          </h1>

          {/* 검색 입구(누르면 검색 화면). PC는 상단 내비에 검색이 있어 숨김. 모바일 지도 보기도 숨김(Figma 174:894) */}
          <Link
            href={localizedPath(locale, "/search/")}
            className={cn(
              "flex h-search items-center gap-2.5 rounded-input border border-border-strong bg-bg-surface px-[15px] text-[15px] text-text-muted lg:hidden",
              view === "map" && "hidden",
            )}
          >
            <Search aria-hidden="true" size={17} className="shrink-0" />
            {t("home.top.search")}
          </Link>

          {/* 지역 버튼(Figma 173:529 '칩 · 선택값'). 누르면 홈과 같은 지역 시트, 고르기 전에는 저장하지 않음 */}
          <Chip
            variant="sel"
            aria-haspopup="dialog"
            aria-label={t("home.top.changeRegion", { region: regionLabel })}
            onClick={regionSheet.show}
            className="self-start"
          >
            {regionLabel}
          </Chip>
        </div>

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
            title={noticeTitle}
            body={t("explore.locationOff.body")}
          />
        )}

        {/* 보기 줄. 모바일 목록: [상태별 | 가까운 순] + [목록 | 지도] (Figma 173:549)
            모바일 지도: 개수·시각 + [목록 | 지도] (174:905) · PC: 개수·시각 + [상태별 | 가까운 순] (181:1027) */}
        <div className="flex items-center justify-between gap-2">
          {showCount &&
            countLine(
              view === "map" ? "map" : "list",
              cn("min-w-0", view === "list" && "hidden lg:block"),
            )}
          {/* 정렬은 목록에만. 모바일 지도 보기에서는 숨김(PC는 목록이 늘 보임) */}
          <ViewToggle<SortChoice>
            label={t("explore.sortLabel")}
            className={cn(
              "w-[176px] shrink-0",
              view === "map" && "hidden lg:flex",
            )}
            options={[
              { value: "status", label: t("explore.sort.status") },
              { value: "second", label: t("explore.sort.near") },
            ]}
            value={sortChoice}
            onChange={pickSort}
          />
          {/* [목록 | 지도]는 모바일만(PC는 둘 다 보임). 지도 보기 120 → 130(Figma 174:907) */}
          <ViewToggle<ExploreView>
            label={t("explore.view.label")}
            className={cn(
              "ml-auto shrink-0 lg:hidden",
              view === "map" ? "w-[130px]" : "w-[120px]",
            )}
            options={[
              { value: "list", label: t("explore.view.list") },
              { value: "map", label: t("explore.view.map") },
            ]}
            value={view}
            onChange={setExploreView}
          />
        </div>

        {/* 모바일 목록 보기의 개수 줄(보기 줄 아래). PC·지도 보기는 보기 줄 안 */}
        {showCount && view === "list" && countLine("list", "lg:hidden")}

        {/* 모바일 지도 보기에서는 목록을 숨김(PC는 늘 보임) */}
        <div className={cn(view === "map" && "hidden lg:block")}>
          {loading ? (
            <BeachRowSkeleton label={t("explore.loading")} />
          ) : items.length === 0 ? (
            // 활동으로 거르지 않고 고른 지역은 해변이 있는 곳만이라(validRegion) 공개 해변이 하나도 없을 때만
            <EmptyState
              icon={<SearchX size={26} />}
              title={t("explore.empty.title")}
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
              {hasKmaData && <KmaSourceNote variant="status" />}
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
                {hasKmaData && <KmaSourceNote variant="status" />}
              </div>
            </div>
          )}
        </div>

        {/* 지역 고르기 시트(홈과 같은 부품). 고르면 기기에 저장하고 닫음
            '내 주변'은 두지 않음: 탐색에서 가까운 해변은 정렬 '가까운 순'이 보여 줌(홈 '내 주변'은 지역을 지우는 동작이라 탐색에선 전국과 같아짐) */}
        <RegionSheet
          open={regionSheet.open}
          onClose={regionSheet.close}
          groups={groups}
          value={region}
          onSelect={(next) => {
            setRegion(next);
            regionSheet.close();
          }}
          // '전국'(맨 앞): 전국을 고른 것으로 저장(BRD-127 · 10/29 결정 B). 저장값 없는 기본 전국도 선택으로 보임
          nationwide={{
            selected: region === null,
            onSelect: () => {
              setRegion(NATIONWIDE);
              regionSheet.close();
            },
          }}
        />
      </div>

      {/* 지도(EXP-M·D-EXP). 모바일은 지도 보기에서만 보이고, 숨긴 동안은 불러오지 않음(MapView가 보일 때 시작)
          PC는 오른쪽 열에 늘 보임. 지도가 실패해도 목록은 그대로 */}
      <div
        className={cn(
          view === "map" ? "mt-3 flex flex-col gap-3" : "hidden",
          "lg:sticky lg:top-[88px] lg:mt-0 lg:block",
        )}
      >
        <p className="sr-only">{t("map.listNote")}</p>
        <MapView
          locale={locale}
          bounds={mapBounds}
          // 마커(해변 상태)를 그릴 때만 지도 아래 출처 줄에 기상청 출처
          dataSource={
            hasKmaData && markers.length > 0 ? t("source.kmaStatus") : null
          }
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
