"use client"; // 바다 정보·위치·활동·기기 저장을 쓰므로 브라우저 부품

import type { Beach } from "@baradun/contracts";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

import { ActivityButton } from "@/components/detail/activity-button";
import { AltBeaches } from "@/components/detail/alt-beaches";
import { BackButton } from "@/components/detail/back-button";
import {
  Call119,
  DetailActions,
  NearbyWarnings,
  SourceList,
} from "@/components/detail/detail-sections";
import { SeaCard, StatGrid } from "@/components/detail/sea-card";
import { VerdictCard } from "@/components/detail/verdict-card";
import { SituationBanner } from "@/components/situation-banner";
import { useActivity } from "@/lib/activity";
import { alternativeBeaches, isClearView } from "@/lib/alternatives";
import type { BeachSummary } from "@/lib/beach-summary";
import { addRecent } from "@/lib/favorites";
import { distanceKm } from "@/lib/geo";
import type { Locale } from "@/lib/i18n";
import { useUserLocation } from "@/lib/location";
import { formatKm } from "@/lib/meta-join";
import { pickSituation } from "@/lib/situation";
import { deriveDetail } from "@/lib/snapshot/detail";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { deriveBeachView } from "@/lib/snapshot/view";
import { useOnline } from "@/lib/use-online";

// 장소 상세 (BRD-32 · 노션 2장 DET/D-DET, Figma S_M04_01~05·L06)
// 모바일 순서: 헤더 → 상황 배너 → 판단 카드 → 대안 해변(특보 없음이 아닐 때) → 바다 상태 → 2×2 지표 →
//   주변 특보 → 119 → 정보 출처 → 하단 고정 즐겨찾기·길찾기
// PC(lg): 본문(바다 상태·지표·주변 특보·출처) + 오른쪽 384px 열(판단 카드 + 길찾기 → 대안 → 119)
// 119·길찾기는 자리마다 하나씩 두고 화면 크기에 맞는 쪽만 보임(display:none이라 화면 읽기에도 하나만)
// 상황 배너(10/27 임시안): 오프라인·형식 미지원·불러오기 실패만. 관측 지연은 판단 카드가, 위치는 상세에 해당 없음
// 공유 버튼은 BRD-34, '자세히'·특보 상세 시트는 BRD-33

export function DetailScreen({
  locale,
  beach,
  beaches,
  sample,
}: {
  locale: Locale;
  beach: Beach;
  beaches: BeachSummary[]; // 대안 해변 후보(노출 끈 해변 제외)
  sample: boolean; // 개발용 예시 해변 목록
}) {
  const t = useTranslations();
  const snapshot = useSnapshot();
  const online = useOnline();
  const activity = useActivity();
  const location = useUserLocation();
  const titleRef = useRef<HTMLHeadingElement>(null);

  // 최근 본 해변에 넣음(기기 저장)
  useEffect(() => {
    addRecent(beach.id);
  }, [beach.id]);

  const view = deriveBeachView(beach, snapshot);
  const detail = deriveDetail(beach.id, view, snapshot);

  // 대안 해변: 지금 보는 해변이 '특보 없음'이 아닐 때만(가까운 순, 사용자 위치와 무관)
  // B5(오프라인·만료)에는 다른 해변도 '특보 없음'을 확인할 수 없어 카드를 두지 않음
  // ('근처에 특보 없는 해변이 없어요'가 확인 못 한 상태를 '없음'으로 말하지 않게)
  const showAlt = view.kind === "ready" && !view.stale && !isClearView(view);
  // 근거 줄에 쓸 기관을 읽을 수 없는 해변은 고르기 전에 뺌(그리는 단계에서 빠져 2곳보다 적어지지 않게)
  const alternatives = showAlt
    ? alternativeBeaches(
        beach,
        beaches
          .filter((item) => item.id !== beach.id)
          .flatMap((item) => {
            const itemView = deriveBeachView(
              { id: item.id, hidden: false },
              snapshot,
            );
            const { warningSource } = deriveDetail(item.id, itemView, snapshot);
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
  });

  // 헤더 2줄째: 지역 · 거리(위치가 있을 때만, 기기 안에서만 계산)
  const region = `${beach.region.sido[locale]} ${beach.region.sigungu[locale]}`;
  const km =
    location.status === "ready"
      ? formatKm(distanceKm(location.coords, beach.coords))
      : null;

  return (
    <div className="pb-[calc(var(--spacing-button)+32px)] lg:pb-0">
      <header className="-mx-2 flex h-detail-header items-center gap-1">
        <BackButton locale={locale} />
        <div className="min-w-0 flex-1">
          <h1
            ref={titleRef}
            tabIndex={-1}
            className="truncate text-[19px] leading-tight font-bold text-text-default outline-none"
          >
            {beach.name[locale]}
          </h1>
          <p className="truncate text-caption text-text-muted">
            {km ? t("detail.region", { region, km }) : region}
          </p>
        </div>
        <ActivityButton />
      </header>

      <div className="mt-3 flex flex-col gap-3">
        {sample && (
          <p
            role="note"
            className="rounded-card bg-bg-surface px-4 py-3 text-body-s text-text-body shadow-card"
          >
            {t("detail.sample")}
          </p>
        )}
        <SituationBanner
          locale={locale}
          situation={situation?.kind === "noLocation" ? null : situation}
          snapshot={snapshot}
          onRetrySucceeded={() => titleRef.current?.focus()}
        />
      </div>

      <div className="mt-4 flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_384px] lg:items-start lg:gap-6">
        {/* 오른쪽 열(PC) · 위쪽(모바일) */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-6 lg:col-start-2 lg:row-start-1">
          <VerdictCard
            beachId={beach.id}
            view={view}
            detail={detail}
            stations={beach.stations}
            nowMs={snapshot.nowMs}
          />
          <DetailActions beach={beach} view={view} className="hidden lg:flex" />
          {showAlt && (
            <AltBeaches
              locale={locale}
              items={alternatives}
              nowMs={snapshot.nowMs}
            />
          )}
          <Call119 className="hidden lg:flex" />
        </div>

        {/* 본문(PC 왼쪽) */}
        <div className="flex flex-col gap-4 lg:col-start-1 lg:row-start-1">
          <SeaCard
            view={view}
            stations={beach.stations}
            nowMs={snapshot.nowMs}
          />
          <StatGrid
            view={view}
            stations={beach.stations}
            ripCurrent={detail.ripCurrent}
            nowMs={snapshot.nowMs}
          />
          <NearbyWarnings
            items={detail.nearbyWarnings}
            nowMs={snapshot.nowMs}
          />
          <Call119 className="lg:hidden" />
          <SourceList
            locale={locale}
            view={view}
            detail={detail}
            stations={beach.stations}
            nowMs={snapshot.nowMs}
          />
        </div>
      </div>

      {/* 하단 고정 버튼(모바일). 위쪽 페이드 + 하단 안전 영역 */}
      <div className="fixed inset-x-0 bottom-0 z-20 bg-gradient-to-t from-bg-page from-70% to-transparent px-gutter pt-6 pb-[max(14px,env(safe-area-inset-bottom))] lg:hidden">
        <DetailActions beach={beach} view={view} />
      </div>
    </div>
  );
}
