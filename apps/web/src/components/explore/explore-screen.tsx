"use client"; // 활동·위치·지역·정렬·바다 정보를 쓰므로 브라우저 부품

import { Search, SearchX } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";

import { BeachRow } from "@/components/beach-row";
import { ExploreFilters } from "@/components/explore/explore-filters";
import { LocationOffBanner } from "@/components/home/location-off-banner";
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
import { localizedPath, type Locale } from "@/lib/i18n";
import { useUserLocation } from "@/lib/location";
import { formatKm, joinMeta } from "@/lib/meta-join";
import { setRegion, useRegion } from "@/lib/region";
import {
  regionChips,
  regionGroups,
  regionName,
  validRegion,
} from "@/lib/region-list";
import { pickSituation, shownDataTime } from "@/lib/situation";
import { kstStamp } from "@/lib/snapshot/clock";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useRowText } from "@/lib/snapshot/use-row-text";
import { deriveBeachView } from "@/lib/snapshot/view";
import { clearCheckedAt } from "@/lib/status-count";
import { useOnline } from "@/lib/use-online";
import { useSheet } from "@/lib/use-sheet";

// 탐색 목록 (BRD-29 · 노션 2장 EXP-L·D-EXP, Figma S_M02_01~07)
// 위에서 아래: 제목 → 검색 입구 → 활동·지역 칩 → 상황 배너(하나) → 보기 전환 → "전체 n곳 · 시각" → 목록
// 목록: 상태별(특보 없음 → 이용불가 → 판단불가 묶음) 또는 가까운 순/이름 순 한 목록. 순위·점수·추천 표시 없음
// 분류는 스냅샷 게시값 그대로(G1). PC(lg)는 왼쪽 448px 목록 열(오른쪽 지도는 지도 이슈에서 채움)

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
  const { badgeText } = useBadgeText();
  const { rowMeta, rowDetail } = useRowText();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const regionSheet = useSheet("region");
  // 위치 안내 배너를 닫았는지. 이번 방문 동안만 기억
  const [offBannerClosed, setOffBannerClosed] = useState(false);

  // 지역은 홈 기본 지역과 같은 저장 값(10/27 결정). 목록에 없어진 지역이면 전국으로 봄
  const region = validRegion(useRegion(), beaches);
  const chips = useMemo(() => regionChips(beaches), [beaches]);
  const groups = useMemo(() => regionGroups(beaches), [beaches]);
  const name = region === null ? null : regionName(groups, region);

  // 위치는 거리 계산에만 쓰고 저장·전송하지 않음
  const coords = location.status === "ready" ? location.coords : null;
  const mode = exploreMode(sortChoice, coords !== null);

  // 해변 → 목록 줄. 화면 상태는 게시된 분류 그대로(deriveBeachView는 만료·오프라인 때 판단불가로 내리기만 함)
  const items = useMemo(
    () =>
      buildItems(filterBeaches(beaches, activity, region), coords, (beach) =>
        deriveBeachView({ id: beach.id, hidden: false }, snapshot),
      ),
    [beaches, activity, region, coords, snapshot],
  );
  const loading = isLoading(items);
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
  });
  // 위치 배너는 아래에서 따로 그리므로(locationOff: false로 부름) 공용 배너에는 데이터 상황만 넘김
  const situation = picked?.kind === "noLocation" ? null : picked;
  const noClear = situation === null && noClearAtAll(items, snapshot.live);
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

  const countText = t("explore.count", { count: items.length });
  const secondLabel = coords ? t("explore.sort.near") : t("explore.sort.name");

  return (
    <div className="flex flex-col gap-4 lg:max-w-[448px]">
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
        onPickSido={(sido) => {
          if (region?.sido !== sido) setRegion({ sido, sigungu: null });
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

      <ViewToggle<SortChoice>
        label={t("explore.sortLabel")}
        options={[
          { value: "status", label: t("explore.sort.status") },
          { value: "second", label: secondLabel },
        ]}
        value={sortChoice}
        onChange={setSortChoice}
      />

      {!loading && (
        <div className="flex flex-col gap-0.5 text-caption text-text-muted">
          {activity !== "swimming" && (
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

      {/* 시·군 고르기 시트. 시·도 칩을 누르면 그 시·도가 이미 골라져 있어 시·군 단계로 열림 */}
      <RegionSheet
        open={regionSheet.open}
        onClose={regionSheet.close}
        groups={groups}
        value={region}
        onSelect={(next) => {
          setRegion(next);
          regionSheet.close();
        }}
      />
    </div>
  );
}
