"use client"; // 활동·위치·기기 저장·바다 정보를 쓰므로 브라우저 부품

import { useMemo } from "react";
import { useTranslations } from "next-intl";

import { ActivityTiles } from "@/components/activity-tiles";
import { FirstVisitCard } from "@/components/home/first-visit-card";
import { GuideLink } from "@/components/home/guide-link";
import { HomeTopBar } from "@/components/home/home-top-bar";
import { NationwideWarnings } from "@/components/home/nationwide-warnings";
import { NearCard } from "@/components/home/near-card";
import { RecentBeaches } from "@/components/home/recent-beaches";
import { SectionHead } from "@/components/home/section-head";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useActivity } from "@/lib/activity";
import type { BeachSummary } from "@/lib/beach-summary";
import { useRecent } from "@/lib/favorites";
import { sortByDistance } from "@/lib/geo";
import { localizedPath, type Locale } from "@/lib/i18n";
import {
  requestLocation,
  useUserLocation,
  type LocationState,
} from "@/lib/location";
import type { SnapshotState } from "@/lib/snapshot/store";
import { useSnapshot } from "@/lib/snapshot/use-snapshot";
import { deriveBeachView } from "@/lib/snapshot/view";

// 홈 (BRD-26 · 노션 2장 HOME/D-HOME, Figma S_M01_01·S_M01_02·S_D07_01)
// 페이지(서버)가 빌드 때 만든 해변 목록을 props로 받고, 나머지(활동·위치·최근 본·바다 정보)는 브라우저에서 읽음
// 모바일 순서: 상단 줄 → 제목 → 활동 타일 → 최근 본/처음 → 가까운 바다 → 해상 특보 → 안내
// PC(lg): 제목+타일 → 가까운 바다 4장 → 해상 특보 · 최근 본 · 안내 3단 (같은 부품, 배치만 다름)

// [1] PC에서 보여줄 가까운 바다 카드 수(모바일은 1장)
const NEAR_COUNT = 4;

// [2] Vue: props: { locale, beaches }
export function HomeScreen({
  locale,
  beaches,
}: {
  locale: Locale;
  beaches: BeachSummary[];
}) {
  const t = useTranslations("home");
  const activity = useActivity();
  const location = useUserLocation();
  const snapshot = useSnapshot();
  const recentIds = useRecent();

  // [3] Vue: computed. 위치가 있을 때만 전체 해변을 가까운 순으로(위치·목록이 바뀔 때만 다시 계산)
  // 위치는 이 계산에만 쓰고 저장·전송하지 않음
  const coords = location.status === "ready" ? location.coords : null;
  const sorted = useMemo(
    () => (coords ? sortByDistance(beaches, coords) : []),
    [beaches, coords],
  );
  // [4] 활동으로 거르기. 수영은 전체 해변(B7), 서핑·스쿠버는 그 활동이 확인된 해변만
  const nearest = useMemo(
    () =>
      (activity === "swimming"
        ? sorted
        : sorted.filter((beach) => beach.activities.includes(activity))
      ).slice(0, NEAR_COUNT),
    [sorted, activity],
  );

  // [5] 최근 본: 저장된 id 순서 그대로. 목록에 없는 id(노출 끈 해변)는 건너뜀(기기 기록은 지우지 않음)
  const byId = useMemo(
    () => new Map(beaches.map((beach) => [beach.id, beach])),
    [beaches],
  );
  // flatMap: 찾으면 [해변], 못 찾으면 [] → 없는 id가 자연스럽게 빠짐
  const recent = recentIds.flatMap((id) => {
    const beach = byId.get(id);
    return beach ? [beach] : [];
  });

  // [6] 배치. lg:order-* = PC에서만 보이는 순서를 바꿈(DOM 순서는 모바일 순서 그대로)
  return (
    <div className="grid gap-5 lg:grid-cols-3 lg:gap-6">
      {/* 제목 + 활동 타일. PC는 3칸 전체 */}
      <div className="flex flex-col gap-4 lg:col-span-3">
        {/* 지금 있는 곳: 활동과 상관없이 가장 가까운 해변의 지역(활동을 바꿔도 그대로) */}
        <HomeTopBar locale={locale} place={sorted[0]?.region ?? null} />
        <h1 className="text-title-xl text-text-default">
          {t("titleLine1")}
          <br />
          {t("titleLine2")}
        </h1>
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

      {/* 가까운 바다. PC는 3칸 전체에 카드 4장 */}
      <section
        aria-labelledby="home-near"
        className="flex flex-col gap-2.5 lg:order-1 lg:col-span-3"
      >
        <SectionHead
          id="home-near"
          title={t("near.title")}
          href={localizedPath(locale, "/explore/")}
          linkText={t("near.all")}
        />
        <NearContent
          locale={locale}
          status={location.status}
          nearest={nearest}
          snapshot={snapshot}
        />
      </section>

      {/* 해상 특보 · 안내. PC는 3단의 왼쪽·오른쪽 */}
      <div className="lg:order-2">
        <NationwideWarnings />
      </div>
      <div className="lg:order-4">
        <GuideLink locale={locale} />
      </div>
    </div>
  );
}

// [7] 가까운 바다 묶음 안쪽. 위치 상태마다 다른 내용 (Vue: v-if / v-else-if 여러 갈래)
// 함수 안에서 if → return으로 나누면 중첩 삼항식보다 읽기 쉬움
function NearContent({
  locale,
  status,
  nearest,
  snapshot,
}: {
  locale: Locale;
  status: LocationState["status"];
  nearest: (BeachSummary & { distanceKm: number })[];
  snapshot: SnapshotState;
}) {
  const t = useTranslations("home.near");

  if (status === "ready") {
    if (nearest.length === 0) {
      return <p className="text-body-s text-text-muted">{t("noBeach")}</p>;
    }
    return (
      <ul className="grid gap-3 lg:grid-cols-4">
        {nearest.map((beach, index) => (
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

  if (status === "locating") {
    return (
      <div
        role="status"
        className="flex flex-col gap-2 rounded-card bg-bg-surface p-4 shadow-card"
      >
        <Skeleton className="h-5 w-[50%]" />
        <Skeleton className="h-12 w-full" />
        <span className="text-caption text-text-muted">{t("locating")}</span>
      </div>
    );
  }

  if (status === "idle" || status === "unavailable") {
    // idle: 권한을 아직 묻지 않은 기기. 버튼을 눌렀을 때만 권한 창(반복 요청 금지)
    // 첫 실행 위치 안내(BRD-25)가 생기면 대부분 그쪽에서 먼저 정해짐
    // unavailable: 시간 초과·기기 오류. 거부가 아니라서 다시 시도할 수 있게 같은 버튼을 둠(빈 묶음 방지)
    return (
      <div className="flex flex-col gap-3 rounded-card bg-bg-surface p-4 shadow-card">
        <p className="text-title-s text-text-default">{t("needLocation")}</p>
        <p className="text-body-s text-text-body">{t("needLocationBody")}</p>
        <Button onClick={requestLocation}>{t("useLocation")}</Button>
      </div>
    );
  }

  // denied: 지역 고르기 칩이 이 자리에 옴(BRD-27). 다시 묻지 않음
  return null;
}
