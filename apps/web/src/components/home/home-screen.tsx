"use client"; // 활동·위치·기기 저장·바다 정보를 쓰므로 브라우저 부품

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { ActivityTiles } from "@/components/activity-tiles";
import { FirstVisitCard } from "@/components/home/first-visit-card";
import { GuideLink } from "@/components/home/guide-link";
import { HeroWaves, HomeSky } from "@/components/home/home-sky";
import { HomeTopBar } from "@/components/home/home-top-bar";
import { LocationOffBanner } from "@/components/home/location-off-banner";
import { NationwideWarnings } from "@/components/home/nationwide-warnings";
import { NearCard } from "@/components/home/near-card";
import { PageUnavailableNote } from "@/components/home/page-unavailable-note";
import { RecentBeaches, RecentEmpty } from "@/components/home/recent-beaches";
import { RegionButton } from "@/components/home/region-button";
import { RegionCountCard } from "@/components/home/region-count-card";
import { SectionHead } from "@/components/home/section-head";
import { StatusSummary } from "@/components/home/status-summary";
import { RegionSheet } from "@/components/region/region-sheet";
import { SituationBanner } from "@/components/situation-banner";
import { KmaSourceNote } from "@/components/source-note";
import { Skeleton } from "@/components/ui/skeleton";
import { useActivity } from "@/lib/activity";
import type { BeachSummary } from "@/lib/beach-summary";
import { useRecent } from "@/lib/favorites";
import { distanceKm, sortByDistance } from "@/lib/geo";
import { showsKmaSource } from "@/lib/kma-source";
import { localizedPath, type Locale } from "@/lib/i18n";
import {
  locationBlocked,
  requestLocation,
  useUserLocation,
  type LocationState,
} from "@/lib/location";
import { setRegion, useRegionChoice } from "@/lib/region";
import {
  homeScope,
  inRegion,
  NATIONWIDE,
  regionGroups,
  regionName,
  scopeBeaches,
} from "@/lib/region-list";
import {
  isDelayedView,
  pickSituation,
  noConfirmedVerdict,
  shownDataTime,
} from "@/lib/situation";
import type { SnapshotState } from "@/lib/snapshot/store";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { deriveBeachView } from "@/lib/snapshot/view";
import {
  clearCheckedAt,
  countByStatus,
  staleCheckedAt,
} from "@/lib/status-count";
import { useDesktop } from "@/lib/use-desktop";
import { useOnline } from "@/lib/use-online";
import { useSheet } from "@/lib/use-sheet";

// 홈 (BRD-26·27·28 · 노션 2장 HOME/D-HOME, Figma S_M01_01~06·S_D07_01)
// 페이지(서버)가 빌드 때 만든 해변 목록을 props로 받고, 나머지(활동·위치·지역·최근 본·바다 정보)는 브라우저에서 읽음
// 모바일 순서: 상단 줄 → 제목 → 상황 배너 → 활동 타일 → 최근 본/처음 → 가까운 바다(또는 강원·전국 바다 + 상태별 개수) → 해상 특보 → 안내
// PC(lg, Figma S_D07_01 181:736): 바다 띠(지역 · 한 줄 제목 · 요약 · 활동 타일 · 상태 요약 3장) → 가까운 바다 4장
//   → 해상 특보 · 최근 본 · 안내(상황 배너 + 안내) 3단. 같은 부품을 한 번만 그리고 배치만 다름(BRD-129)
// 지역(BRD-27 · 10/27 결정): 고른 지역이 있으면 위치와 관계없이 그 지역 해변(이름 순, 위치가 있으면 거리도)
// 전국(BRD-127 · 10/29 사용자 요청): 시트에서 고르면 위치와 관계없이 공개 해변 전체(지역과 같은 규칙)
// 지역을 안 골랐으면 위치 → 가까운 바다, 위치도 없으면 전국(기본값). 위치를 다시 묻지 않음(lib/region-list.ts homeScope)

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
  const tRoot = useTranslations(); // safety.finalCall
  const activity = useActivity();
  const location = useUserLocation();
  const snapshot = useSnapshot();
  const recentIds = useRecent();
  const online = useOnline();
  // PC 배치인지. 상황 배너 자리(모바일 제목 아래 · PC 안내 칸)와 가까운 바다 카드 모양만 바꿈
  const desktop = useDesktop();
  // 다시 시도가 성공해 배너가 사라지면 포커스를 제목으로 (Vue: ref="title")
  const titleRef = useRef<HTMLHeadingElement>(null);
  // [1] 기기에 저장한 기본 지역(전국 포함)과 위치 상태 → 홈이 보여줄 범위
  // 저장값이 없거나 지금 해변 목록에 없는 지역이면 위치가 있으면 가까운 바다, 없으면 전국(homeScope)
  const choice = useRegionChoice();
  const scope = useMemo(
    () => homeScope(choice, beaches, location.status),
    [choice, beaches, location.status],
  );
  const region = scope.kind === "region" ? scope.region : null;
  // [2] 지역 고르기 시트. 열면 브라우저 기록 한 칸(뒤로 가기로 닫힘)
  const regionSheet = useSheet("region");
  // [3] '위치 없이 보고 있어요' 배너를 닫았는지. 이번 방문 동안만 기억 (Vue: data)
  const [offBannerClosed, setOffBannerClosed] = useState(false);

  // Vue: computed. 시트에 쓸 지역 목록은 해변 목록이 바뀔 때만 다시 만듦
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

  // [5] 지역·전국이면 위치와 관계없이 그 범위를 이름 순으로 보여줌 (10/27 결정 · BRD-127)
  const byList = scope.kind !== "nearby";
  // '위치 없이 보고 있어요'는 지역·전국으로 보는데 위치도 없을 때만(권한 확인 중·받는 중은 아직 모름)
  const locationOff =
    byList &&
    location.status !== "ready" &&
    location.status !== "locating" &&
    location.status !== "checking";
  // 범위 안 해변 전체(이름 순, 전국은 공개 해변 전체). 개수 카드는 전체, 카드는 앞에서 NEAR_COUNT곳
  const regionBeaches = useMemo(
    () => scopeBeaches(beaches, scope, activity),
    [beaches, scope, activity],
  );
  // 화면 이름: 고른 지역 "강원 양양군" · 전국 "전국" · 가까운 바다는 null
  const name =
    scope.kind === "nationwide"
      ? t("nationwide.label")
      : region === null
        ? null
        : regionName(groups, region);
  // 범위 해변의 화면 상태(게시된 분류 그대로, G1). 개수 카드의 개수·확인 시각에 씀
  const regionViews = regionBeaches.map((beach) =>
    deriveBeachView({ id: beach.id, hidden: false }, snapshot),
  );

  // PC 히어로 요약(BRD-129)의 해변. 상단 지역 글자와 같은 범위:
  // 지역·전국이면 그 범위 해변, 가까운 바다면 가장 가까운 해변의 시·군 해변(활동 거르기는 같음)
  const nearestPlace = sorted[0] ?? null;
  const summaryBeaches = useMemo(() => {
    if (byList) return regionBeaches;
    if (nearestPlace === null) return [];
    const place = {
      sido: nearestPlace.sido.key,
      sigungu: nearestPlace.sigungu.key,
    };
    return beaches.filter(
      (beach) =>
        inRegion(beach, place) &&
        (activity === "swimming" || beach.activities.includes(activity)),
    );
  }, [byList, regionBeaches, nearestPlace, beaches, activity]);
  const summaryViews = summaryBeaches.map((beach) =>
    deriveBeachView({ id: beach.id, hidden: false }, snapshot),
  );

  // [6] 홈에 보이는 해변 카드(지역·전국 → 이름 순, 위치가 있으면 거리도 / 가까운 바다 → 가까운 순)
  const shown: ShownBeach[] = byList
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
    // 확인된 판단 없음은 노출 중인 전체 해변으로 봄(지역·활동과 무관, BRD-38)
    noConfirmed: noConfirmedVerdict(
      beaches.map((beach) =>
        deriveBeachView({ id: beach.id, hidden: false }, snapshot),
      ),
    ),
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

  // 상단 지역 버튼 글자: 고른 지역·전국 → 그 이름, 가까운 바다면 활동과 상관없이 가장 가까운 해변의 지역
  const regionLabel = name ?? sorted[0]?.region ?? null;
  const kmaSource = showsKmaSource(snapshot, sampleSnapshot);
  const regionNearby = name === null && sorted.length > 0;
  // 위치 배너 설명: 전국은 기본값이면 위치를 켜면 가까운 바다로, 고른 전국이면 거리를 더함. 지역은 고른 지역 문구
  const offBody =
    scope.kind === "nationwide"
      ? scope.chosen
        ? t("nationwide.offBodyChosen")
        : t("nationwide.offBodyDefault")
      : t("region.offBody");

  // PC 제목 아래 한 줄: "강원 강릉시 바다 19곳의 특보·측정 상태예요 · 14:27 업데이트"
  // 시각은 지금 보여주는 정보의 게시 시각(상황 배너와 같은 shownDataTime). 모르면 시각 칸을 뺌
  const dataTime = shownDataTime(
    snapshot.manifest?.generatedAt,
    snapshot.nowMs,
  );
  const summaryLine =
    regionLabel !== null && summaryBeaches.length > 0
      ? [
          t("hero.summary", {
            region: regionLabel,
            count: summaryBeaches.length,
          }),
          dataTime && t("hero.updated", { time: dataTime }),
        ]
          .filter(Boolean)
          .join(" · ")
      : null;

  // 상황 배너 하나(BRD-28). 모바일은 제목 아래, PC는 안내 칸(Figma 181:1004). 한 번만 그림
  // PC에서도 오프라인·불러오기 실패·형식 오류·확인된 판단 없음은 화면 전체에 영향이 있어 제목 아래에 둠
  // (안내 칸은 첫 화면 밖이라 놓칠 수 있음). 관측 지연·위치 없이 보는 중만 Figma처럼 안내 칸
  const bannerInInfo =
    desktop &&
    (situation?.kind === "delayed" || situation?.kind === "noLocation");
  // 위치 없이 보는 중은 홈 배너, 나머지(오프라인·실패·지연 등)는 공용 상황 배너
  const banner =
    situation?.kind === "noLocation" ? (
      <LocationOffBanner
        locale={locale}
        status={location.status}
        onClose={() => setOffBannerClosed(true)}
        body={offBody}
        withIcon={false}
      />
    ) : (
      <SituationBanner
        locale={locale}
        situation={situation}
        snapshot={snapshot}
        onRetrySucceeded={() => titleRef.current?.focus()}
      />
    );

  return (
    // PC 바다 띠를 상단 내비 바로 아래에 붙임(본문 위 여백 상쇄). 언어 안내가 위에 있으면(첫 칸이 아님) 덮지 않게 그대로 둠
    <div className="relative isolate flex flex-col gap-6 lg:gap-2 lg:first:-mt-8">
      {/* 모바일 바다 배경(꾸밈) */}
      <HomeSky />

      {/* [10] 머리: 모바일은 상단 줄 → 제목 → 배너 → 활동 타일, PC는 바다 띠(Figma 181:775)
          PC 띠는 화면 끝까지 넓히고(100vw) 안쪽 여백으로 본문 64px 선에 맞춤(본문 여백 40 + 24) */}
      {/* 묶음(section)이 아니라 머리 영역: 상태 요약의 근거·현장 우선 문구는 아래 가까운 바다 묶음과 함께 읽힘 */}
      <div className="relative flex flex-col lg:mx-[calc(50%-50vw)] lg:bg-home-hero lg:px-[calc(50vw-50%+24px)] lg:pt-11 lg:pb-32">
        <HeroWaves />
        <HomeTopBar
          locale={locale}
          label={regionLabel}
          nearby={regionNearby}
          onPickRegion={regionSheet.show}
        />
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:gap-12">
          <div className="flex min-w-0 flex-col gap-4 lg:flex-1 lg:gap-3">
            {/* PC는 상단 줄이 없어 제목 위에 같은 지역 버튼(지역 보기·'내 주변' 전환) */}
            <RegionButton
              label={regionLabel}
              nearby={regionNearby}
              onClick={regionSheet.show}
              variant="hero"
              className="-my-3 -ml-1 hidden self-start lg:flex"
            />
            <h1
              id="home-title"
              ref={titleRef}
              tabIndex={-1}
              className="text-title-home text-text-default outline-none lg:text-display"
            >
              {t("titleLine1")}
              {/* PC는 한 줄. 줄 머리 공백은 모바일 줄바꿈 뒤에서 사라짐 */}
              <br className="lg:hidden" /> {t("titleLine2")}
            </h1>
            {summaryLine && (
              <p className="hidden text-title-s font-normal text-text-body lg:block">
                {summaryLine}
              </p>
            )}
            {/* 상황 배너 자리(노션 HOME 3). 예시 값이 실제 확인 결과처럼 보이지 않게 카드들 위에 둠 */}
            {sampleSnapshot && (
              <p
                role="note"
                className="rounded-card bg-bg-surface px-4 py-3 text-body-s text-text-body shadow-card"
              >
                {t("sampleSnapshot")}
              </p>
            )}
            {!bannerInInfo && banner}
            {/* 연결이 없어 다른 화면을 열지 못하고 홈으로 왔을 때만(서비스 워커 표식, BRD-106) */}
            <PageUnavailableNote />
          </div>
          {/* 1152 폭에서 왼쪽 544 · 타일 560(Figma). 좁은 PC(1024)에서는 타일이 절반까지 줄어듦 */}
          <div className="lg:w-[560px] lg:max-w-[50%] lg:shrink">
            <ActivityTiles />
          </div>
        </div>
        {/* PC 상태 요약 3장(지역 글자와 같은 범위의 해변). 게시된 분류 그대로 셈(G1) */}
        {desktop && summaryBeaches.length > 0 && (
          <div className="mt-7">
            <StatusSummary
              href={localizedPath(locale, "/explore/")}
              counts={countByStatus(summaryViews)}
              clearCheckedAt={clearCheckedAt(summaryViews)}
              staleChecked={staleCheckedAt(summaryViews)}
              nowMs={snapshot.nowMs}
            />
          </div>
        )}
      </div>

      {/* [11] 아래 묶음. 모바일은 한 줄씩(최근 본 → 가까운 바다 → 해상 특보 → 안내)
          PC는 가까운 바다 3칸 전체 → 해상 특보 · 최근 본 · 안내 3단(Figma 424.6 : 339.7 : 339.7) */}
      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[1.25fr_1fr_1fr] lg:gap-x-6 lg:gap-y-0 lg:px-6">
        {/* 최근 본(재방문) 또는 처음 오셨네요(첫 방문). PC는 아래 3단의 가운데 */}
        {/* 최근 본이 없을 때: PC는 Figma 3단을 지키려고 최근 본 해변 빈 상태,
            모바일은 가까운 바다(위치)로 볼 때만 '처음 오셨네요'(Figma 171:563). 지역·전국으로 볼 때는 없음(171:818)
            빈 칸도 간격을 차지해 그릴 것이 없으면 칸째 뺌 */}
        {(recent.length > 0 || desktop || !byList) && (
          <div className="lg:order-3 lg:pt-8">
            {recent.length > 0 ? (
              <RecentBeaches locale={locale} beaches={recent} />
            ) : desktop ? (
              <RecentEmpty />
            ) : (
              <FirstVisitCard />
            )}
          </div>
        )}

        {/* 가까운 바다(지역을 고르면 '강원 바다', 전국이면 '전국 바다'). PC는 3칸 전체에 카드 4장 */}
        <section
          aria-labelledby="home-near"
          className="flex flex-col gap-2.5 lg:order-1 lg:col-span-3 lg:gap-3.5"
        >
          <SectionHead
            id="home-near"
            title={
              scope.kind === "nationwide"
                ? t("nationwide.seaTitle")
                : byList && name
                  ? t("region.seaTitle", { region: name })
                  : t("near.title")
            }
            href={localizedPath(locale, "/explore/")}
            linkText={t("near.all")}
            // PC는 카드마다 넣던 현장 우선 문구를 카드 4장 바로 위에 한 번(Figma 181:849)
            note={desktop ? tRoot("safety.finalCall") : null}
            large
          />
          <NearContent
            locale={locale}
            status={location.status}
            shown={shown}
            byList={byList}
            byRegion={region !== null}
            snapshot={snapshot}
            variant={desktop ? "wide" : "compact"}
          />
          {/* 지역·전국 해변 상태별 개수(모바일, 가까운 바다에서는 없음). PC는 히어로 상태 요약이 같은 일을 함
              게시된 분류 그대로 셈(G1) */}
          {!desktop && byList && name && regionBeaches.length > 0 && (
            <RegionCountCard
              href={localizedPath(locale, "/explore/")}
              title={
                scope.kind === "nationwide"
                  ? t("nationwide.countTitle", { count: regionBeaches.length })
                  : t("region.countTitle", {
                      region: name,
                      count: regionBeaches.length,
                    })
              }
              counts={countByStatus(regionViews)}
              clearCheckedAt={clearCheckedAt(regionViews)}
              staleChecked={staleCheckedAt(regionViews)}
              nowMs={snapshot.nowMs}
            />
          )}
        </section>

        {/* 해상 특보 · 안내. PC는 3단의 왼쪽·오른쪽 */}
        <div className="lg:order-2 lg:pt-8">
          <NationwideWarnings kmaSource={kmaSource} />
        </div>
        <section
          aria-labelledby={desktop ? "home-info" : undefined}
          className="flex flex-col gap-3 lg:order-4 lg:pt-8"
        >
          {/* PC 안내 칸 제목(Figma 181:1003). 모바일은 안내 카드 하나라 제목 없음 */}
          {desktop && (
            <h2 id="home-info" className="text-title-m text-text-default">
              {t("info.title")}
            </h2>
          )}
          {bannerInInfo && banner}
          <GuideLink locale={locale} />
        </section>

        {/* 기상청 출처(BRD-113 · 기상법). 카드·개수·해상 특보가 기상청 자료로 만든 것이라 홈 맨 아래 한 줄
            받은 실제 상태가 있을 때만(불러오는 중·처음부터 못 받음·개발용 예시는 숨김, showsKmaSource) */}
        {kmaSource && (
          <KmaSourceNote
            variant="status"
            className="lg:order-5 lg:col-span-3 lg:pt-8"
          />
        )}
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
        // '전국'(맨 앞): 전국으로 저장. 위치를 켜도 전국 유지. 저장값 없는 기본 전국일 때도 선택으로 보임
        nationwide={{
          selected: scope.kind === "nationwide",
          onSelect: () => {
            setRegion(NATIONWIDE);
            regionSheet.close();
          },
        }}
        // '내 주변': 고른 지역을 지우고 가까운 바다로. 위치를 거부했거나 설정에서 껐으면 숨김
        nearby={
          locationBlocked(location.status)
            ? null
            : {
                selected: scope.kind === "nearby",
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
  byList,
  byRegion,
  snapshot,
  variant,
}: {
  locale: Locale;
  status: LocationState["status"];
  shown: ShownBeach[];
  byList: boolean; // 지역·전국(이름 순 목록)
  byRegion: boolean; // 시·도·시·군을 고름(빈 목록 문구가 다름)
  snapshot: SnapshotState;
  variant: "compact" | "wide"; // 카드 모양(모바일 · PC)
}) {
  const t = useTranslations("home");

  // [8] 가까운 바다인데 위치가 아직 없음 = 권한 확인 중(앱을 연 직후)·받는 중(homeScope)
  // 자리만 잡음(카드·전국 목록이 잠깐 보였다 사라지지 않게)
  if (!byList && status !== "ready") {
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

  // [9] 위치가 있거나 지역·전국이면 카드 목록
  if (shown.length === 0) {
    return (
      <p className="text-body-s text-text-muted">
        {byRegion ? t("region.noBeach") : t("near.noBeach")}
      </p>
    );
  }
  return (
    <ul className="grid gap-3 lg:grid-cols-4 lg:gap-4">
      {shown.map((beach, index) => (
        // 모바일은 첫 카드만, PC는 4장
        <li key={beach.id} className={index > 0 ? "hidden lg:block" : ""}>
          <NearCard
            locale={locale}
            beach={beach}
            distanceKm={beach.distanceKm}
            view={deriveBeachView({ id: beach.id, hidden: false }, snapshot)}
            nowMs={snapshot.nowMs}
            variant={variant}
          />
        </li>
      ))}
    </ul>
  );
}
