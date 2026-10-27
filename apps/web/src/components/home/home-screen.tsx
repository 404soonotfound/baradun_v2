"use client"; // 활동·위치·기기 저장·바다 정보를 쓰므로 브라우저 부품

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { ActivityTiles } from "@/components/activity-tiles";
import { FirstVisitCard } from "@/components/home/first-visit-card";
import { GuideLink } from "@/components/home/guide-link";
import { HomeTopBar } from "@/components/home/home-top-bar";
import { LocationOffBanner } from "@/components/home/location-off-banner";
import { NationwideWarnings } from "@/components/home/nationwide-warnings";
import { NearCard } from "@/components/home/near-card";
import { RecentBeaches } from "@/components/home/recent-beaches";
import { RegionButton } from "@/components/home/region-button";
import { RegionCountCard } from "@/components/home/region-count-card";
import { RegionPick } from "@/components/home/region-pick";
import { SectionHead } from "@/components/home/section-head";
import { RegionSheet } from "@/components/region/region-sheet";
import { SituationBanner } from "@/components/situation-banner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useActivity } from "@/lib/activity";
import type { BeachSummary, RegionPart } from "@/lib/beach-summary";
import { useRecent } from "@/lib/favorites";
import { distanceKm, sortByDistance } from "@/lib/geo";
import { localizedPath, type Locale } from "@/lib/i18n";
import {
  requestLocation,
  useUserLocation,
  type LocationState,
} from "@/lib/location";
import { setRegion, useRegion } from "@/lib/region";
import {
  inRegion,
  regionChips,
  regionGroups,
  regionName,
  validRegion,
} from "@/lib/region-list";
import { isDelayedView, pickSituation } from "@/lib/situation";
import type { SnapshotState } from "@/lib/snapshot/store";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { deriveBeachView } from "@/lib/snapshot/view";
import { clearCheckedAt, countByStatus } from "@/lib/status-count";
import { useOnline } from "@/lib/use-online";
import { useSheet } from "@/lib/use-sheet";

// 홈 (BRD-26·27·28 · 노션 2장 HOME/D-HOME, Figma S_M01_01~06·S_D07_01)
// 페이지(서버)가 빌드 때 만든 해변 목록을 props로 받고, 나머지(활동·위치·지역·최근 본·바다 정보)는 브라우저에서 읽음
// 모바일 순서: 상단 줄 → 제목 → 상황 배너 → 활동 타일 → 최근 본/처음 → 가까운 바다(또는 강원 바다 + 상태별 개수) → 해상 특보 → 안내
// PC(lg): 제목+타일 → 가까운 바다 4장 → 해상 특보 · 최근 본 · 안내 3단 (같은 부품, 배치만 다름)
// 지역(BRD-27 · 10/27 결정): 고른 지역이 있으면 위치와 관계없이 그 지역 해변(이름 순, 위치가 있으면 거리도)
// 지역을 안 골랐으면 위치 → 가까운 바다, 위치도 없으면 지역 칩. 위치를 다시 묻지 않음

// PC에서 보여줄 가까운 바다 카드 수(모바일은 1장)
const NEAR_COUNT = 4;

// 위치가 있으면 km, 없으면 null
type ShownBeach = BeachSummary & { distanceKm: number | null };

// Vue: props: { locale, beaches, sampleSnapshot }
export function HomeScreen({
  locale,
  beaches,
  sampleSnapshot,
}: {
  locale: Locale;
  beaches: BeachSummary[];
  sampleSnapshot: boolean; // 개발용 예시 특보·관측값(dev:data)을 보는 중. 배포 빌드는 늘 false
}) {
  const t = useTranslations("home");
  const activity = useActivity();
  const location = useUserLocation();
  const snapshot = useSnapshot();
  const recentIds = useRecent();
  const online = useOnline();
  // 다시 시도가 성공해 배너가 사라지면 포커스를 제목으로 (Vue: ref="title")
  const titleRef = useRef<HTMLHeadingElement>(null);
  // [1] 기기에 저장한 기본 지역. 지금 해변 목록에 없는 지역이면 null(validRegion)
  const region = validRegion(useRegion(), beaches);
  // [2] 지역 고르기 시트. 열면 브라우저 기록 한 칸(뒤로 가기로 닫힘)
  const regionSheet = useSheet("region");
  // [3] '위치 없이 보고 있어요' 배너를 닫았는지. 이번 방문 동안만 기억 (Vue: data)
  const [offBannerClosed, setOffBannerClosed] = useState(false);

  // Vue: computed. 칩·시트에 쓸 지역 목록은 해변 목록이 바뀔 때만 다시 만듦
  const chips = useMemo(() => regionChips(beaches), [beaches]);
  const groups = useMemo(() => regionGroups(beaches), [beaches]);

  // [4] Vue: computed. 위치가 있을 때만 전체 해변을 가까운 순으로(위치·목록이 바뀔 때만 다시 계산)
  // 위치는 이 계산에만 쓰고 저장·전송하지 않음
  const coords = location.status === "ready" ? location.coords : null;
  const sorted = useMemo(
    () => (coords ? sortByDistance(beaches, coords) : []),
    [beaches, coords],
  );
  // 활동으로 거르기. 수영은 전체 해변(B7), 서핑·스쿠버는 그 활동이 확인된 해변만
  const nearest = useMemo(
    () =>
      (activity === "swimming"
        ? sorted
        : sorted.filter((beach) => beach.activities.includes(activity))
      ).slice(0, NEAR_COUNT),
    [sorted, activity],
  );

  // [5] 지역을 골랐으면 위치와 관계없이 그 지역을 보여줌 (10/27 결정)
  const byRegion = region !== null;
  // '위치 없이 보고 있어요'는 지역으로 보는데 위치도 없을 때만(권한 확인 중·받는 중은 아직 모름)
  const locationOff =
    byRegion &&
    location.status !== "ready" &&
    location.status !== "locating" &&
    location.status !== "checking";
  // 고른 지역의 해변 전체(이름 순). 개수 카드는 전체, 카드는 앞에서 NEAR_COUNT곳
  const regionBeaches = useMemo(
    () =>
      region === null
        ? []
        : beaches
            .filter(
              (beach) =>
                inRegion(beach, region) &&
                (activity === "swimming" ||
                  beach.activities.includes(activity)),
            )
            .sort((a, b) => a.name.localeCompare(b.name)),
    [beaches, region, activity],
  );
  const name = region === null ? null : regionName(groups, region);
  // 지역 해변의 화면 상태(게시된 분류 그대로, G1). 개수 카드의 개수·확인 시각에 씀
  const regionViews = regionBeaches.map((beach) =>
    deriveBeachView({ id: beach.id, hidden: false }, snapshot),
  );

  // [6] 홈에 보이는 해변 카드(지역 → 이름 순, 위치가 있으면 거리도 / 지역 없음 → 가까운 순)
  const shown: ShownBeach[] = byRegion
    ? regionBeaches.slice(0, NEAR_COUNT).map((beach) => ({
        ...beach,
        distanceKm:
          location.status === "ready"
            ? distanceKm(location.coords, beach.coords)
            : null,
      }))
    : nearest;

  // [7] 상황 배너는 하나만(BRD-28). 관측 지연은 홈 카드 해변 중 배지가 관측 지연인 곳
  const delayed = shown.filter((beach) =>
    isDelayedView(deriveBeachView({ id: beach.id, hidden: false }, snapshot)),
  );
  const situation = pickSituation({
    phase: snapshot.phase,
    live: snapshot.live,
    failedOnline: snapshot.failedOnline,
    online,
    delayed,
    locationOff: locationOff && !offBannerClosed,
  });

  // 최근 본: 저장된 id 순서 그대로. 목록에 없는 id(노출 끈 해변)는 건너뜀(기기 기록은 지우지 않음)
  const byId = useMemo(
    () => new Map(beaches.map((beach) => [beach.id, beach])),
    [beaches],
  );
  // flatMap: 찾으면 [해변], 못 찾으면 [] → 없는 id가 자연스럽게 빠짐
  const recent = recentIds.flatMap((id) => {
    const beach = byId.get(id);
    return beach ? [beach] : [];
  });

  // 상단 지역 버튼 글자: 고른 지역 → 그 이름, 안 골랐으면 활동과 상관없이 가장 가까운 해변의 지역
  const regionLabel = name ?? sorted[0]?.region ?? null;
  const regionNearby = name === null && sorted.length > 0;

  return (
    <div className="grid gap-5 lg:grid-cols-3 lg:gap-6">
      {/* 제목 + 상황 배너 + 활동 타일. PC는 3칸 전체 */}
      <div className="flex flex-col gap-4 lg:col-span-3">
        <HomeTopBar
          locale={locale}
          label={regionLabel}
          nearby={regionNearby}
          onPickRegion={regionSheet.show}
        />
        {/* PC는 상단 줄이 없어 제목 위에 같은 지역 버튼(지역 보기·'내 주변' 전환) */}
        <RegionButton
          label={regionLabel}
          nearby={regionNearby}
          onClick={regionSheet.show}
          className="-ml-1 hidden self-start lg:flex"
        />
        <h1
          ref={titleRef}
          tabIndex={-1}
          className="text-title-xl text-text-default outline-none"
        >
          {t("titleLine1")}
          <br />
          {t("titleLine2")}
        </h1>
        {/* 상황 배너 자리(노션 HOME 3). 예시 값이 실제 확인 결과처럼 보이지 않게 카드들 위에 둠 */}
        {sampleSnapshot && (
          <p
            role="note"
            className="rounded-card bg-bg-surface px-4 py-3 text-body-s text-text-body shadow-card"
          >
            {t("sampleSnapshot")}
          </p>
        )}
        {/* 위치 없이 보는 중은 홈 배너, 나머지(오프라인·실패·지연 등)는 공용 상황 배너 */}
        {situation?.kind === "noLocation" ? (
          <LocationOffBanner
            locale={locale}
            status={location.status}
            onClose={() => setOffBannerClosed(true)}
          />
        ) : (
          <SituationBanner
            locale={locale}
            situation={situation}
            snapshot={snapshot}
            onRetrySucceeded={() => titleRef.current?.focus()}
          />
        )}
        <div className="lg:w-[560px]">
          <ActivityTiles />
        </div>
      </div>

      {/* 최근 본(재방문) 또는 처음 오셨네요(첫 방문). PC는 아래 3단의 가운데 */}
      <div className="lg:order-3">
        {recent.length > 0 ? (
          <RecentBeaches locale={locale} beaches={recent} />
        ) : (
          <FirstVisitCard />
        )}
      </div>

      {/* 가까운 바다(지역을 고르면 '강원 바다'). PC는 3칸 전체에 카드 4장 */}
      <section
        aria-labelledby="home-near"
        className="flex flex-col gap-2.5 lg:order-1 lg:col-span-3"
      >
        <SectionHead
          id="home-near"
          title={
            byRegion && name
              ? t("region.seaTitle", { region: name })
              : t("near.title")
          }
          href={localizedPath(locale, "/explore/")}
          linkText={t("near.all")}
        />
        <NearContent
          locale={locale}
          status={location.status}
          shown={shown}
          byRegion={byRegion}
          snapshot={snapshot}
          chips={chips}
          onPickSido={(sido) => setRegion({ sido, sigungu: null })}
        />
        {/* 지역 해변 상태별 개수(지역 고른 뒤만). 게시된 분류 그대로 셈(G1) */}
        {byRegion && name && regionBeaches.length > 0 && (
          <RegionCountCard
            href={localizedPath(locale, "/explore/")}
            title={t("region.countTitle", {
              region: name,
              count: regionBeaches.length,
            })}
            counts={countByStatus(regionViews)}
            clearCheckedAt={clearCheckedAt(regionViews)}
            nowMs={snapshot.nowMs}
          />
        )}
      </section>

      {/* 해상 특보 · 안내. PC는 3단의 왼쪽·오른쪽 */}
      <div className="lg:order-2">
        <NationwideWarnings />
      </div>
      <div className="lg:order-4">
        <GuideLink locale={locale} />
      </div>

      {/* 지역 고르기 시트. 고르면 기기에 저장하고 닫음 */}
      <RegionSheet
        open={regionSheet.open}
        onClose={regionSheet.close}
        groups={groups}
        value={region}
        onSelect={(next) => {
          setRegion(next);
          regionSheet.close();
        }}
        // '내 주변': 고른 지역을 지우고 가까운 바다로. 위치를 거부했으면 숨김
        nearby={
          location.status === "denied"
            ? null
            : {
                selected: region === null,
                onSelect: () => {
                  setRegion(null);
                  regionSheet.close();
                  // 아직 묻지 않았으면 이때 처음 물음(반복 요청 아님). 받을 수 없음(시간 초과 등)은 다시 시도
                  // 권한 확인 중에 누른 것도 요청(결과가 '아직 안 물음'이면 버튼을 한 번 더 누르게 되지 않게)
                  if (
                    location.status === "checking" ||
                    location.status === "idle" ||
                    location.status === "unavailable"
                  )
                    requestLocation();
                },
              }
        }
      />
    </div>
  );
}

// 가까운 바다 묶음 안쪽. 위치·지역 상태마다 다른 내용 (Vue: v-if / v-else-if 여러 갈래)
// 함수 안에서 if → return으로 나누면 중첩 삼항식보다 읽기 쉬움
function NearContent({
  locale,
  status,
  shown,
  byRegion,
  snapshot,
  chips,
  onPickSido,
}: {
  locale: Locale;
  status: LocationState["status"];
  shown: ShownBeach[];
  byRegion: boolean;
  snapshot: SnapshotState;
  chips: readonly RegionPart[];
  onPickSido: (sido: string) => void;
}) {
  const t = useTranslations("home");

  // [8] 위치가 있거나 지역을 골랐으면 카드 목록
  if (status === "ready" || byRegion) {
    if (shown.length === 0) {
      return (
        <p className="text-body-s text-text-muted">
          {byRegion ? t("region.noBeach") : t("near.noBeach")}
        </p>
      );
    }
    return (
      <ul className="grid gap-3 lg:grid-cols-4">
        {shown.map((beach, index) => (
          // 모바일은 첫 카드만, PC는 4장
          <li key={beach.id} className={index > 0 ? "hidden lg:block" : ""}>
            <NearCard
              locale={locale}
              beach={beach}
              distanceKm={beach.distanceKm}
              view={deriveBeachView({ id: beach.id, hidden: false }, snapshot)}
              nowMs={snapshot.nowMs}
            />
          </li>
        ))}
      </ul>
    );
  }

  // 권한 확인 중(앱을 연 직후)도 받는 중처럼 자리만 잡음(버튼·지역 칩이 잠깐 보였다 사라지지 않게)
  if (status === "locating" || status === "checking") {
    return (
      <div
        role="status"
        className="flex flex-col gap-2 rounded-card bg-bg-surface p-4 shadow-card"
      >
        <Skeleton className="h-5 w-[50%]" />
        <Skeleton className="h-12 w-full" />
        <span className="text-caption text-text-muted">
          {t("near.locating")}
        </span>
      </div>
    );
  }

  if (status === "idle") {
    // 권한을 아직 묻지 않은 기기. 버튼을 눌렀을 때만 권한 창(반복 요청 금지)
    // 첫 실행 위치 안내(BRD-25)가 생기면 대부분 그쪽에서 먼저 정해짐
    return (
      <div className="flex flex-col gap-3 rounded-card bg-bg-surface p-4 shadow-card">
        <p className="text-title-s text-text-default">
          {t("near.needLocation")}
        </p>
        <p className="text-body-s text-text-body">
          {t("near.needLocationBody")}
        </p>
        <Button onClick={requestLocation}>{t("near.useLocation")}</Button>
      </div>
    );
  }

  // [9] 거부·받을 수 없음 + 지역을 아직 안 고름 → 지역 칩(빈 묶음 방지). 거부면 다시 묻지 않음
  // 받을 수 없음(시간 초과·기기 오류)은 지역 시트의 '내 주변'·배너의 '위치 정보 켜기'로 다시 시도
  return <RegionPick chips={chips} onPick={onPickSido} />;
}
