"use client";

import {
  CircleCheck,
  CircleQuestionMark,
  Clock,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { badgeTone, type VerdictTone } from "@/lib/badge-tone";
import { cn } from "@/lib/cn";
import type { LatLng } from "@/lib/geo";
import type { MapHandle } from "@/lib/map/engine";
import { shortName } from "@/lib/map/short-name";
import type { BadgeLabel } from "@/lib/snapshot/view";

// 해변 마커 (BRD-30 · 노션 2장 EXP-M '마커 = 상태 아이콘 + 짧은 이름', 4장 지도 마커 원)
// 원: 특보 없음 파랑 채움 · 이용불가 빨강 채움 · 확인 못 함 흰 원 + 회색 점선 · 관측 지연 연주황 + 주황 점선
// 색 + 아이콘(+ 점선)으로 구분(색만으로 구분하지 않음). 분류는 게시값 그대로(G1)
// 마커는 화면 읽기·Tab에서 뺌(aria-hidden): 같은 해변은 목록에서 모두 키보드로 닿음(206곳을 Tab으로 돌지 않게)
// 이름은 가까이 볼 때(확대 11 이상)와 고른·가리킨 마커만 보여 지명 라벨·다른 마커와 덜 겹치게 함

export type MapMarker = {
  id: string;
  name: string;
  coords: LatLng;
  badge: BadgeLabel;
};

// 이 확대 단계부터 모든 마커에 이름을 붙임. 동해안처럼 해변이 촘촘한 곳은 z10에서 이름끼리 겹쳐 11부터
const NAME_ZOOM = 11;

// 마커 원의 색·아이콘. 범례(map-legend.tsx)도 같은 표를 씀. 테두리 굵기는 쓰는 쪽이 정함
// 채운 원(특보 없음·이용불가)은 흰 테두리로 지도 위에서 떼어 보이게, 판단불가는 점선 테두리
export const MARKER_TONE: Record<
  VerdictTone,
  { circle: string; Icon: LucideIcon }
> = {
  clear: {
    circle: "border-bg-surface bg-status-clear-fg text-bg-surface",
    Icon: CircleCheck,
  },
  blocked: {
    circle: "border-bg-surface bg-status-blocked-fg text-bg-surface",
    Icon: TriangleAlert,
  },
  unknown: {
    circle:
      "border-dashed border-status-unknown-border bg-status-unknown-bg text-status-unknown-fg",
    Icon: CircleQuestionMark,
  },
  stale: {
    circle:
      "border-dashed border-status-stale-border bg-status-stale-bg text-status-stale-fg",
    Icon: Clock,
  },
};

export function BeachMarkers({
  api,
  markers,
  selectedId,
  highlightedId,
  onSelect,
}: {
  api: MapHandle;
  markers: readonly MapMarker[];
  selectedId: string | null;
  highlightedId: string | null; // PC 목록 행에 마우스·포커스가 있는 해변
  onSelect: (id: string | null) => void;
}) {
  const [zoom, setZoom] = useState(() => api.map.getZoom());
  // 지도 이벤트에서 부를 최신 onSelect(이벤트를 다시 걸지 않게)
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  });

  useEffect(() => {
    const map = api.map;
    const onZoom = () => setZoom(map.getZoom());
    // 마커가 아닌 곳을 누르면 고른 해변을 놓음
    const onClick = (event: { originalEvent: MouseEvent }) => {
      const target = event.originalEvent.target;
      if (target instanceof Element && target.closest("[data-beach-marker]"))
        return;
      onSelectRef.current(null);
    };
    map.on("zoomend", onZoom);
    map.on("click", onClick);
    return () => {
      map.off("zoomend", onZoom);
      map.off("click", onClick);
    };
  }, [api]);

  return markers.map((marker) => {
    const selected = marker.id === selectedId;
    const emphasized = selected || marker.id === highlightedId;
    return (
      <BeachMarker
        key={marker.id}
        api={api}
        lngLat={[marker.coords.lng, marker.coords.lat]}
      >
        <MarkerFace
          name={shortName(marker.name)}
          tone={badgeTone(marker.badge)}
          emphasized={emphasized}
          showName={emphasized || zoom >= NAME_ZOOM}
          onClick={() => onSelect(marker.id)}
        />
      </BeachMarker>
    );
  });
}

// 마커 하나: 지도에 붙일 요소를 만들고 그 안에 React로 그림(포털)
function BeachMarker({
  api,
  lngLat,
  children,
}: {
  api: MapHandle;
  lngLat: [number, number];
  children: ReactNode;
}) {
  // 지도에 붙일 빈 요소. 지도가 다 그려진 뒤(브라우저)에만 이 부품이 그려지므로 document를 씀
  const [node] = useState(() => {
    const element = document.createElement("div");
    element.setAttribute("aria-hidden", "true");
    element.dataset.beachMarker = "";
    return element;
  });
  const [lng, lat] = lngLat;

  useEffect(() => api.addMarker(node, [lng, lat]), [api, node, lng, lat]);

  return createPortal(children, node);
}

function MarkerFace({
  name,
  tone,
  emphasized,
  showName,
  onClick,
}: {
  name: string;
  tone: VerdictTone;
  emphasized: boolean;
  showName: boolean;
  onClick: () => void;
}) {
  const { circle, Icon } = MARKER_TONE[tone];
  return (
    // 누르는 자리(44px). 원의 가운데가 해변 좌표(이름은 원 아래에 띄워 자리를 바꾸지 않음)
    // data-front: 고른·가리킨 마커를 다른 마커 위로(globals.css)
    <div
      onClick={onClick}
      data-front={emphasized || undefined}
      className="relative flex size-touch cursor-pointer items-center justify-center"
    >
      <span
        className={cn(
          "flex size-7 items-center justify-center rounded-full border-2 shadow-card",
          circle,
          emphasized && "size-9 ring-3 ring-text-default",
        )}
      >
        <Icon size={15} strokeWidth={2.5} />
      </span>
      {showName && (
        <span
          className={cn(
            "absolute top-[calc(50%+18px)] left-1/2 -translate-x-1/2 rounded-full px-1.5 py-px text-caption whitespace-nowrap shadow-card",
            emphasized
              ? "bg-text-default font-bold text-bg-surface"
              : "bg-bg-surface text-text-default",
          )}
        >
          {name}
        </span>
      )}
    </div>
  );
}
