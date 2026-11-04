"use client";

import { LocateFixed } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import type { LatLng } from "@/lib/geo";
import {
  deviceLocationGuide,
  locationRetrying,
  refreshLocation,
  requestLocation,
  useUserLocation,
  watchLocation,
  type LocationState,
} from "@/lib/location";
import type { MapHandle } from "@/lib/map/engine";
import { nearbyWaitStep } from "@/lib/map/nearby";

// 지도 '내 주변 보기' (BRD-114 · 결정 기록 12장 결정 5)
// - 위치 허용이 먼저: 누를 때만 위치를 물음(앱 위치 저장소의 request: 거부·꺼짐이면 다시 묻지 않고 안내만)
// - 이미 받은 위치가 있어도 누를 때마다 새로 받음(앱을 연 뒤 옮겨 간 곳 기준으로)
// - 받은 위치를 onLocated로 넘기면 화면이 내 위치에서 가까운 해변으로 지도를 옮김(explore-screen). 못 옮기면 false
// - 내 위치 점을 그리지 않고, 위치를 저장·전송하지 않음
// - 옮기지 못하면 무슨 일 → 영향 → 다음 행동을 버튼 아래에 알림(role=status)

export type NearbyNoticeKind = "denied" | "off" | "unavailable" | "outside";

export function NearbyButton({
  api,
  onLocated,
  className,
}: {
  api: MapHandle;
  // 위치를 받으면 한 번 부름. 정확한 위치는 기기 안 거리 계산에만 씀. 지도를 옮겼으면 true
  onLocated: (coords: LatLng) => boolean;
  className?: string;
}) {
  const t = useTranslations("map.nearby");
  const location = useUserLocation();
  const [notice, setNotice] = useState<NearbyNoticeKind | null>(null);
  // 이미 받은 위치를 새로 받는 중(저장소 상태는 ready 그대로라 따로 둠)
  const [refreshing, setRefreshing] = useState(false);
  // 눌러서 기다리는 위치 알림을 그만 받는 함수(다시 누르거나 화면을 떠날 때)
  const stopWaiting = useRef<(() => void) | null>(null);
  const onLocatedRef = useRef(onLocated);
  useEffect(() => {
    onLocatedRef.current = onLocated;
  });

  function settle(coords: LatLng | null, failed: NearbyNoticeKind) {
    if (coords === null) setNotice(failed);
    else if (!onLocatedRef.current(coords)) setNotice("outside");
  }

  function press() {
    setNotice(null);
    stopWaiting.current?.();
    stopWaiting.current = null;
    if (location.status === "ready") {
      setRefreshing(true);
      void refreshLocation().then((coords) => {
        setRefreshing(false);
        settle(coords, "unavailable");
      });
      return;
    }
    // 거부·꺼짐은 다시 묻지 않음(안내만). 다른 곳의 '다시 시도' 답을 기다리는 중이면 그 답을 같이 기다림
    if (
      (location.status === "denied" && !locationRetrying(location)) ||
      location.status === "off"
    ) {
      setNotice(location.status);
      return;
    }
    // 위치 답(받음·거부·받을 수 없음)이 오면 한 번 처리하고 그만 받음
    const stop = watchLocation((state: LocationState) => {
      const step = nearbyWaitStep(state);
      if (step === "wait") return;
      stop();
      if (stopWaiting.current === stop) stopWaiting.current = null;
      if (step === "move" && state.status === "ready")
        settle(state.coords, "unavailable");
      else
        setNotice(
          state.status === "denied" || state.status === "off"
            ? state.status
            : "unavailable",
        );
    });
    stopWaiting.current = stop;
    if (!locationRetrying(location)) requestLocation();
  }

  useEffect(() => () => stopWaiting.current?.(), []);

  // 지도를 직접 움직이거나 누르면 지난 안내를 지움
  useEffect(() => {
    const map = api.map;
    const clear = () => setNotice(null);
    map.on("dragstart", clear);
    map.on("click", clear);
    return () => {
      map.off("dragstart", clear);
      map.off("click", clear);
    };
  }, [api]);

  const busy =
    refreshing || location.status === "locating" || locationRetrying(location);
  const label = busy ? t("locating") : t("button");

  return (
    <div className={cn("flex flex-col items-end gap-2", className)}>
      {/* disabled 대신 aria-disabled: 누른 버튼의 포커스가 사라지지 않게(결과 안내를 이어서 들음, location-retry.tsx와 같음) */}
      {/* 모바일은 확대·축소 버튼과 같은 44px 아이콘 버튼(지도를 덜 가리게), PC는 글자도 보임. 이름은 보이는 글자와 같음 */}
      <button
        type="button"
        onClick={busy ? undefined : press}
        aria-disabled={busy ? "true" : undefined}
        aria-label={label}
        title={label}
        className="flex size-touch items-center justify-center gap-1.5 rounded-full bg-bg-surface text-body-s font-bold text-text-default shadow-card hover:bg-bg-subtle aria-disabled:cursor-default aria-disabled:font-normal aria-disabled:text-text-muted lg:w-auto lg:px-4"
      >
        <LocateFixed aria-hidden="true" size={18} />
        <span className="hidden lg:inline">{label}</span>
      </button>
      <NearbyNotice notice={busy ? null : notice} />
    </div>
  );
}

// 옮기지 못한 까닭 안내(무슨 일 → 영향 → 다음 행동). 안내가 없을 때도 자리(role=status)를 둬 바뀔 때 읽힘
// 거부는 기기별 설정 경로(아이폰·아이패드는 기기 위치 서비스, 그 밖은 브라우저 사이트 설정, BRD-139와 같은 판별)
export function NearbyNotice({ notice }: { notice: NearbyNoticeKind | null }) {
  const t = useTranslations("map.nearby");
  const key =
    notice === "denied"
      ? deviceLocationGuide() === "ios"
        ? "deniedIos"
        : "deniedBrowser"
      : notice;
  return (
    <p
      role="status"
      className={cn(
        "max-w-[260px] rounded-card bg-bg-surface px-3 py-2 text-caption text-text-body shadow-card",
        key === null && "sr-only",
      )}
    >
      {key !== null && t(key)}
    </p>
  );
}
