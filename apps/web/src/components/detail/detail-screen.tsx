"use client"; // 바다 정보·위치·활동·기기 저장을 쓰므로 브라우저 부품

import type { Beach, WarningItem } from "@baradun/contracts";
import { ChevronDown, ChevronRight, ChevronUp, MapPin } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { ActivityIcon } from "@/components/activity-icon";
import { AltBeaches } from "@/components/detail/alt-beaches";
import { BackButton } from "@/components/detail/back-button";
import {
  Call119,
  DetailActions,
  DirectionsLink,
  FavoriteButton,
  NearbyWarnings,
  SourceList,
} from "@/components/detail/detail-sections";
import { SeaCard, StatGrid } from "@/components/detail/sea-card";
import { ShareButton } from "@/components/detail/share-button";
import { DetailSheet } from "@/components/detail/detail-sheet";
import { VerdictCard } from "@/components/detail/verdict-card";
import { SampleNote } from "@/components/sample-note";
import { SituationBanner } from "@/components/situation-banner";
import { WarningSheet } from "@/components/warning-sheet";
import { ACTIVITIES, currentActivity, useActivity } from "@/lib/activity";
import { alternativeBeaches, isClearView } from "@/lib/alternatives";
import { cn } from "@/lib/cn";
import type { BeachSummary } from "@/lib/beach-summary";
import { addRecent } from "@/lib/favorites";
import { recordVisit } from "@/lib/recent-visits";
import { showsKmaSource } from "@/lib/kma-source";
import { distanceKm } from "@/lib/geo";
import type { Locale } from "@/lib/i18n";
import { useUserLocation } from "@/lib/location";
import { formatKm } from "@/lib/meta-join";
import { pickSituation, noConfirmedVerdict } from "@/lib/situation";
import { deriveDetail, warningSourceOf } from "@/lib/snapshot/detail";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { deriveBeachView } from "@/lib/snapshot/view";
import { useOnline } from "@/lib/use-online";
import { useSheet } from "@/lib/use-sheet";

// 장소 상세 (BRD-32 · 노션 2장 DET/D-DET, Figma S_M04_01~05·183:748·183:1438·184:748, BRD-129 · 시안 D안 BRD-182)
// 모바일 순서: 헤더 → 상황 배너 → 판단 묶음(판단 카드 + 열면 주변 특보) → 대안 해변(특보 없음이 아닐 때) →
//   지금 바다 → 2×2 지표 → 119 → 정보 출처 → 하단 고정 즐겨찾기·길찾기
// PC(lg): 머리 두 줄 → 본문(지금 바다 · 119) + 오른쪽 384px 열(판단 묶음: 판단 카드 안 길찾기 · 주변 특보 · 정보 출처 → 대안)
// 판단 묶음(D18-11 ②): 모바일은 배지 줄 '주변 특보 n건'·'확인한 것'으로 확인한 것·주변 특보를 열고 접음(기본 접음).
//   PC는 늘 펼침이라 버튼 없음. 특보 사유 상자는 접지 않음
// Figma '현장 화면'(CCTV) 카드는 출시에서 뺌(10/30 사용자 결정)
// 119·길찾기는 자리마다 하나씩 두고 화면 크기에 맞는 쪽만 보임(display:none이라 화면 읽기에도 하나만)
// 상황 배너(결정 2로 확정): 오프라인·형식 미지원·불러오기 실패·확인된 판단 없음(BRD-38·결정 1)만. 관측 지연은 판단 카드가, 위치는 상세에 해당 없음
// '자세히' 시트(DET-SH)·특보 상세 시트(WARN)는 BRD-33. 공유 버튼·시트는 BRD-34(share-button)

export function DetailScreen({
  locale,
  beach,
  beaches,
  allBeachIds,
  sample,
  sampleSnapshot,
}: {
  locale: Locale;
  beach: Beach;
  beaches: BeachSummary[]; // 대안 해변 후보: 이 해변 제외 30km 안(노출 끈 해변 제외, listAltCandidates)
  allBeachIds: string[]; // 노출 중인 전체 해변 id(확인된 판단 없음 배너, listVisibleBeachIds)
  sample: boolean; // 개발용 예시 해변 목록
  sampleSnapshot: boolean; // 개발용 예시 특보·관측값을 보는 중. 배포 빌드는 늘 false
}) {
  const t = useTranslations();
  const snapshot = useSnapshot();
  const online = useOnline();
  const activity = useActivity();
  const location = useUserLocation();
  const titleRef = useRef<HTMLHeadingElement>(null);
  // 시트 2개. 열면 브라우저 기록 한 칸(뒤로 가기로 닫힘), 닫히면 연 버튼으로 포커스가 돌아감(<dialog>)
  const detailSheet = useSheet("detail");
  const warningSheet = useSheet("warning");
  const [warningItem, setWarningItem] = useState<WarningItem | null>(null);
  // 모바일 판단 묶음 열고 접기(D18-11 ②). 해변을 옮기면 접힌 상태로 시작(상세 화면이 새로 그려짐)
  const [expanded, setExpanded] = useState(false);
  const checkedId = useId();
  const nearbyId = useId();

  // 최근 본 해변에 넣음(기기 저장). 본 시각과 그때 고른 활동도 이 기기에만(홈 최근 본 카드, BRD-129)
  // 활동은 훅 값 대신 저장값을 바로 읽음(첫 그림의 기본값 '수영'이 남지 않게)
  useEffect(() => {
    addRecent(beach.id);
    recordVisit(beach.id, {
      at: new Date().toISOString(),
      activity: currentActivity(),
    });
  }, [beach.id]);

  const view = deriveBeachView(beach, snapshot);
  const detail = deriveDetail(beach.id, view, snapshot);
  // 기상청 출처(줄·기관 이름)는 받은 실제 상태가 있을 때만(BRD-113, 개발용 예시 제외)
  const kmaSource = showsKmaSource(snapshot, sampleSnapshot);

  // 대안 해변: 지금 보는 해변이 '특보 없음'이 아닐 때만(가까운 순, 사용자 위치와 무관)
  // B5(오프라인·만료)에는 다른 해변도 '특보 없음'을 확인할 수 없어 카드를 두지 않음
  // ('근처에 특보 없는 해변이 없어요'가 확인 못 한 상태를 '없음'으로 말하지 않게)
  const showAlt = view.kind === "ready" && !view.stale && !isClearView(view);
  // 근거 줄에 쓸 기관을 읽을 수 없는 해변은 고르기 전에 뺌(그리는 단계에서 빠져 2곳보다 적어지지 않게)
  const alternatives = showAlt
    ? alternativeBeaches(
        beach,
        beaches.flatMap((item) => {
          const itemView = deriveBeachView(
            { id: item.id, hidden: false },
            snapshot,
          );
          const warningSource = warningSourceOf(item.id, snapshot);
          return warningSource
            ? [{ ...item, view: itemView, warningSource }]
            : [];
        }),
        activity,
        (item) => item.view,
      )
    : [];

  const situation = pickSituation({
    phase: snapshot.phase,
    live: snapshot.live,
    failedOnline: snapshot.failedOnline,
    online,
    delayed: [],
    locationOff: false,
    // 확인된 판단 없음은 노출 중인 전체 해변으로 봄(대안 후보 30km 안만이 아님, BRD-38)
    noConfirmed: noConfirmedVerdict(
      allBeachIds.map((id) => deriveBeachView({ id, hidden: false }, snapshot)),
    ),
    // 공지는 홈 상단에만(화면 설계서 6장 ADM-NTC, BRD-151)
    notice: null,
  });

  // 모바일 열고 접기 버튼 이름: 읽은 주변 특보 수 '주변 특보 n건'(없으면 '확인한 것')
  // 읽지 못한 주변 특보가 있으면 접지 않고 늘 보여 '내용을 읽지 못했어요' 안내가 가려지지 않게 함(리뷰 PR #177)
  const nearbyCount = detail.nearbyWarnings.length;
  const nearbyUnreadable = detail.unreadableNearby !== 0;
  // 주변 특보를 접을 때만 버튼이 주변 특보를 말함(읽지 못한 항목이 있어 늘 보이면 '확인한 것'만 여닫음)
  const nearbyFolds = nearbyCount > 0 && !nearbyUnreadable;
  const toggleLabel = nearbyFolds
    ? t("detail.verdict.nearbyCount", { count: nearbyCount })
    : t("detail.verdict.checked");
  // 정보 출처는 PC 묶음 안·모바일 본문 맨 아래 두 자리에 그림. 넘기는 값은 한곳에서
  const sourceProps = {
    locale,
    beachSlug: beach.slug,
    view,
    detail,
    stations: beach.stations,
    warningZones: beach.warningZones,
    nowMs: snapshot.nowMs,
    kmaSource,
  };

  const Chevron = expanded ? ChevronUp : ChevronDown;

  // 헤더 2줄째: 지역 · 거리(위치가 있을 때만, 기기 안에서만 계산). PC는 '내 위치에서 2.1km'(Figma 183:806)
  const region = `${beach.region.sido[locale]} ${beach.region.sigungu[locale]}`;
  const km =
    location.status === "ready"
      ? formatKm(distanceKm(location.coords, beach.coords))
      : null;

  return (
    <div className="pb-[calc(var(--spacing-button)+32px)] lg:-mt-4 lg:px-6 lg:pb-0">
      {/* 머리(시안 D안 ActR_D_WXM·PLD, D18-4). 모바일 한 줄: 뒤로 · 이름 / 지역·거리 | 확인된 활동 · 공유,
          PC 두 줄: '‹ 뒤로' / 34px 이름 + 지역 줄 | 즐겨찾기·공유 칩.
          활동은 고르는 버튼이 아니라 이 해변에서 확인된 활동 글자(누를 수 없음). 활동은 홈 활동 타일에서만 고름 */}
      <header className="-mr-3 -ml-4 mb-2 flex h-detail-header items-center gap-1 lg:mx-0 lg:mb-0 lg:grid lg:h-auto lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end lg:gap-x-6 lg:gap-y-3">
        <BackButton
          locale={locale}
          labelWide
          className="lg:col-start-1 lg:row-start-1 lg:self-center lg:justify-self-start"
        />
        <div className="min-w-0 flex-1 lg:col-start-1 lg:row-start-2 lg:flex lg:flex-col lg:gap-2">
          <h1
            ref={titleRef}
            tabIndex={-1}
            className="truncate text-[19px] leading-[1.45] font-bold tracking-[-0.4px] text-text-default outline-none lg:text-[34px] lg:leading-[1.2] lg:tracking-[-1px]"
          >
            {beach.name[locale]}
          </h1>
          <div className="flex min-w-0 items-center gap-2 lg:gap-3">
            <p className="truncate text-caption text-text-muted lg:flex lg:items-center lg:gap-1.5 lg:text-[14px] lg:font-medium lg:text-text-body">
              <MapPin
                aria-hidden="true"
                size={16}
                className="hidden shrink-0 text-text-muted lg:block"
              />
              {km ? (
                <>
                  <span className="lg:hidden">
                    {t("detail.region", { region, km })}
                  </span>
                  <span className="hidden lg:inline">
                    {t("detail.regionFromMe", { region, km })}
                  </span>
                </>
              ) : (
                region
              )}
            </p>
            <span
              aria-hidden="true"
              className="h-2.5 w-px shrink-0 bg-border-strong lg:h-3"
            />
            <ul
              aria-label={t("activity.confirmed")}
              className="flex shrink-0 cursor-default gap-2 select-none lg:gap-3 [&_svg]:size-3.5 lg:[&_svg]:size-4"
            >
              {ACTIVITIES.filter((item) => beach.activities.includes(item)).map(
                (item) => (
                  <li
                    key={item}
                    className="inline-flex items-center gap-0.5 text-caption font-medium text-text-muted lg:gap-1 lg:text-label-s"
                  >
                    <ActivityIcon activity={item} />
                    {/* 세 활동이 모두면 모바일 머리 줄이 좁아 지역·거리가 잘리지 않게 아이콘만(이름은 화면 읽기에) */}
                    <span
                      className={cn(
                        beach.activities.length > 2 && "max-lg:sr-only",
                      )}
                    >
                      {t(
                        item === "scuba"
                          ? "activity.scubaFull"
                          : `activity.${item}`,
                      )}
                    </span>
                  </li>
                ),
              )}
            </ul>
          </div>
        </div>
        <div className="flex gap-2 lg:col-start-2 lg:row-start-2 lg:items-center lg:self-center lg:justify-self-end">
          <FavoriteButton
            beachId={beach.id}
            variant="pill"
            className="hidden lg:flex"
          />
          <ShareButton locale={locale} beach={beach} />
        </div>
      </header>

      {/* 배너가 없으면 띄움 없이 판단 카드가 머리 바로 아래(Figma). 배너의 숨은 알림 글(sr-only)은 세지 않음 */}
      <div className="flex flex-col gap-3.5 has-[>:not(.sr-only)]:mb-3.5 lg:has-[>:not(.sr-only)]:mt-3.5 lg:has-[>:not(.sr-only)]:mb-0">
        {sample && <SampleNote>{t("detail.sample")}</SampleNote>}
        {/* 예시 특보·관측값이 실제 확인 결과처럼 보이지 않게 판단 카드보다 먼저 둠 */}
        {sampleSnapshot && <SampleNote />}
        <SituationBanner
          locale={locale}
          situation={situation?.kind === "noLocation" ? null : situation}
          snapshot={snapshot}
          onRetrySucceeded={() => titleRef.current?.focus()}
        />
      </div>

      {/* 본문. 모바일 사이 14(Figma pad.stack), PC 두 열 740 | 384 · 사이 28(Figma 183:814) */}
      <div className="flex flex-col gap-3.5 lg:mt-[18px] lg:grid lg:grid-cols-[minmax(0,1fr)_384px] lg:items-start lg:gap-7">
        {/* 오른쪽 열(PC) · 위쪽(모바일) */}
        <div className="flex flex-col gap-3.5 lg:col-start-2 lg:row-start-1">
          {/* 판단 묶음: 칸 사이 구분선, 바탕·그림자는 묶음이 그림(시안 D안) */}
          <div className="flex flex-col divide-y divide-border-default overflow-hidden rounded-card bg-bg-surface shadow-card lg:shadow-raised">
            <VerdictCard
              beachId={beach.id}
              view={view}
              detail={detail}
              stations={beach.stations}
              warningZones={beach.warningZones}
              nowMs={snapshot.nowMs}
              kmaSource={kmaSource}
              embedded
              checkedId={checkedId}
              expanded={expanded}
              toggle={
                view.kind === "ready" && (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={
                      nearbyFolds ? `${checkedId} ${nearbyId}` : checkedId
                    }
                    onClick={() => setExpanded((open) => !open)}
                    // 보이는 줄은 18px, 누르는 영역은 위아래·옆으로 넓혀 44px(BRD-39)
                    className="relative inline-flex items-center gap-0.5 text-label-s font-bold text-text-body before:absolute before:-inset-x-2 before:-inset-y-[13px] before:content-['']"
                  >
                    {/* 접힌 이름('주변 특보 n건'·'확인한 것')은 펼친 뒤에도 화면 읽기에 남겨 무엇을 접는지 알림.
                        보이는 글자는 시안 D안대로 '접기'(접근 가능한 이름이 보이는 글자를 포함) */}
                    {expanded ? (
                      <>
                        <span className="sr-only">{toggleLabel} </span>
                        {t("detail.verdict.collapse")}
                      </>
                    ) : (
                      toggleLabel
                    )}
                    <Chevron aria-hidden="true" size={14} strokeWidth={2.4} />
                  </button>
                )
              }
              onOpenWarning={(item) => {
                setWarningItem(item);
                warningSheet.show();
              }}
              more={
                // 불러온 뒤에만 '자세히'(확인한 것이 있어야 보여줄 수 있음)
                view.kind === "ready" && (
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    onClick={detailSheet.show}
                    // 보이는 줄은 17px, 누르는 영역은 위아래로 넓혀 44px(BRD-39)
                    className="relative inline-flex items-center gap-0.5 text-caption font-bold text-brand-default before:absolute before:inset-x-0 before:-inset-y-[13px] before:content-['']"
                  >
                    {t("detailSheet.more")}
                    <ChevronRight
                      aria-hidden="true"
                      size={12}
                      strokeWidth={2.6}
                    />
                  </button>
                )
              }
            >
              {/* PC: 길찾기는 판단 카드 안 맨 아래(Figma 183:1032). 모바일은 하단 고정 줄 */}
              <DirectionsLink
                beach={beach}
                view={view}
                className="hidden lg:flex"
              />
            </VerdictCard>
            {/* 모바일은 열었을 때만, PC는 늘 */}
            <NearbyWarnings
              embedded
              id={nearbyId}
              className={expanded || nearbyUnreadable ? "" : "max-lg:hidden"}
              items={detail.nearbyWarnings}
              unreadable={detail.unreadableNearby}
              nowMs={snapshot.nowMs}
            />
            {/* PC: 정보 출처도 묶음 안. 모바일은 본문 맨 아래 */}
            <div className="hidden px-4 pt-3 pb-1 lg:block">
              <SourceList compact {...sourceProps} />
            </div>
          </div>
          {showAlt && (
            <AltBeaches
              locale={locale}
              activity={activity}
              items={alternatives}
              nowMs={snapshot.nowMs}
            />
          )}
        </div>

        {/* 본문(PC 왼쪽) · 사이 18(Figma 183:815) */}
        <div className="flex flex-col gap-3.5 lg:col-start-1 lg:row-start-1 lg:gap-[18px]">
          <SeaCard
            view={view}
            stations={beach.stations}
            ripCurrent={detail.ripCurrent}
            nowMs={snapshot.nowMs}
            kmaSource={kmaSource}
          />
          <StatGrid
            view={view}
            stations={beach.stations}
            ripCurrent={detail.ripCurrent}
            nowMs={snapshot.nowMs}
          />
          <Call119 />
          <div className="lg:hidden">
            <SourceList {...sourceProps} />
          </div>
        </div>
      </div>

      {/* 하단 고정 버튼(모바일, Figma cta: 위 12 · 옆 16 · 위쪽 투명 → 바탕 30%) + 하단 안전 영역 */}
      <div className="fixed inset-x-0 bottom-0 z-20 bg-gradient-to-b from-transparent to-bg-page to-30% px-4 pt-3 pb-[max(14px,env(safe-area-inset-bottom))] lg:hidden">
        <DetailActions beach={beach} view={view} />
      </div>

      <DetailSheet
        open={detailSheet.open}
        onClose={detailSheet.close}
        view={view}
        detail={detail}
        stations={beach.stations}
        warningZones={beach.warningZones}
        nowMs={snapshot.nowMs}
        kmaData={kmaSource}
      />
      <WarningSheet
        open={warningSheet.open}
        onClose={warningSheet.close}
        item={warningItem}
        items={detail.warnings}
        source={detail.warningSource}
        confirmedAt={view.kind === "ready" ? view.confirmedAt : null}
        stale={view.kind !== "ready" || view.stale}
        nowMs={snapshot.nowMs}
        sourceShown={kmaSource}
      />
    </div>
  );
}
