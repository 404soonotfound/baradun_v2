"use client";

import { LocateFixed } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import type { LatLng } from "@/lib/geo";
import {
  locationRetrying,
  requestLocation,
  useUserLocation,
} from "@/lib/location";
import { nearbyWaitStep } from "@/lib/map/nearby";
import type { MapHandle } from "@/lib/map/engine";

// 지도 '내 주변 보기' (BRD-114 · 결정 기록 12장 결정 5)
// - 누를 때만 위치를 물음(앱 위치 저장소의 request: 거부·꺼짐이면 다시 묻지 않고 안내만)
// - 위치 허용이 먼저: 받은 위치를 onLocated로 넘기면 화면이 내 위치에서 가까운 해변으로 지도를 옮김(explore-screen)
// - 내 위치 점을 그리지 않고, 위치를 저장·전송하지 않음
// - 옮기지 못하면 무슨 일 → 영향 → 다음 행동을 버튼 아래에 알림(role=status)

export function NearbyButton({
  api,
  onLocated,
  className,
}: {
  api: MapHandle;
  // 위치를 받으면 한 번 부름. 정확한 위치는 기기 안 거리 계산에만 씀
  onLocated: (coords: LatLng) => void;
  className?: string;
}) {
  const t = useTranslations("map.nearby");
  const location = useUserLocation();
  // 이 버튼을 눌렀는지. 안내는 '눌렀음 + 지금 위치 상태'로 정함(따로 들고 있지 않음)
  // 지도를 직접 움직이거나 누르면 내려서 지난 안내를 지움
  const [pressed, setPressed] = useState(false);
  // 눌러서 위치를 기다리는 중. 위치가 오면 한 번만 옮김(다른 화면이 받은 위치로는 옮기지 않음)
  const waitingRef = useRef(false);

  function press() {
    if (location.status === "ready") {
      // 바로 옮김. 알릴 실패가 없어 지난 안내도 지움(뒤에 다른 곳의 위치 실패가 이 버튼 안내로 보이지 않게)
      setPressed(false);
      onLocated(location.coords);
      return;
    }
    setPressed(true);
    // 다른 곳(위치 배너)의 '다시 시도' 답을 기다리는 중이면 그 답을 같이 기다림(새로 묻지 않음)
    if (locationRetrying(location)) {
      waitingRef.current = true;
      return;
    }
    // 거부·꺼짐은 다시 묻지 않음(안내만). 그 밖은 지금 물음
    if (location.status === "denied" || location.status === "off") return;
    waitingRef.current = true;
    requestLocation();
  }

  useEffect(() => {
    if (!waitingRef.current) return;
    const step = nearbyWaitStep(location);
    if (step === "wait") return;
    waitingRef.current = false;
    if (step === "move" && location.status === "ready")
      onLocated(location.coords);
  }, [location, onLocated]);

  useEffect(() => {
    const map = api.map;
    const clear = () => setPressed(false);
    map.on("dragstart", clear);
    map.on("click", clear);
    return () => {
      map.off("dragstart", clear);
      map.off("click", clear);
    };
  }, [api]);

  const busy = location.status === "locating" || locationRetrying(location);
  const label = busy ? t("locating") : t("button");
  const notice =
    pressed &&
    !busy &&
    (location.status === "denied" ||
      location.status === "off" ||
      location.status === "unavailable")
      ? location.status
      : null;

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
      <NearbyNotice notice={notice} />
    </div>
  );
}

// 옮기지 못한 까닭 안내(무슨 일 → 영향 → 다음 행동). 안내가 없을 때도 자리(role=status)를 둬 바뀔 때 읽힘
export function NearbyNotice({ notice }: { notice: NearbyNoticeKind | null }) {
  const t = useTranslations("map.nearby");
  return (
    <p
      role="status"
      className={cn(
        "max-w-[260px] rounded-card bg-bg-surface px-3 py-2 text-caption text-text-body shadow-card",
        notice === null && "sr-only",
      )}
    >
      {notice !== null && t(notice)}
    </p>
  );
}

export type NearbyNoticeKind = "denied" | "off" | "unavailable";
