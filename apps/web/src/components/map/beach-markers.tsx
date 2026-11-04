"use client";

import {
  CircleCheck,
  CircleQuestionMark,
  Clock,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { badgeTone, type VerdictTone } from "@/lib/badge-tone";
import { cn } from "@/lib/cn";
import type { LatLng } from "@/lib/geo";
import { FIT_OPTIONS, type LngLatBox } from "@/lib/map/bounds";
import {
  CLUSTER_MAX_ZOOM,
  clusterMarkers,
  releaseMarkers,
} from "@/lib/map/cluster";
import type { MapHandle } from "@/lib/map/engine";
import { shortName } from "@/lib/map/short-name";
import { prefersReducedMotion } from "@/lib/motion";
import type { BadgeLabel } from "@/lib/snapshot/view";

// 해변 마커 (BRD-30 · 노션 2장 EXP-M '마커 = 상태 아이콘 + 짧은 이름', 4장 지도 마커 원)
// 원: 특보 없음 파랑 채움 · 이용불가 빨강 채움 · 확인 못 함 흰 원 + 회색 점선 · 관측 지연 연주황 + 주황 점선
// 색 + 아이콘(+ 점선)으로 구분(색만으로 구분하지 않음). 분류는 게시값 그대로(G1)
// 마커는 화면 읽기·Tab에서 뺌(aria-hidden): 같은 해변은 목록에서 모두 키보드로 닿음(206곳을 Tab으로 돌지 않게)
// 이름은 가까이 볼 때(확대 11 이상)와 고른·가리킨 마커만 보여 지명 라벨·다른 마커와 덜 겹치게 함
// 확대 11 미만에서 겹치는 마커는 숫자 묶음 버튼으로(BRD-114 · 결정 8). 묶음은 해변 수만 보여 주고 상태 색을 쓰지 않음

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
  const t = useTranslations("map");
  const [zoom, setZoom] = useState(() => api.map.getZoom());
  // 전체 묶기는 해변·확대가 바뀔 때만. 고른·가리킨 해변은 그 해변이 든 묶음만 다시 묶어 꺼냄
  // (PC 목록 행에 마우스를 올릴 때마다 전체를 다시 묶지 않게)
  const clustered = useMemo(
    () => clusterMarkers(markers, zoom),
    [markers, zoom],
  );
  const groups = useMemo(
    () =>
      releaseMarkers(
        clustered,
        new Set([selectedId, highlightedId].filter((id) => id !== null)),
        zoom,
      ),
    [clustered, selectedId, highlightedId, zoom],
  );
  // 키보드 포커스가 있던 묶음 버튼이 다시 묶이며 사라지면(+/− 키 확대, 목록 행 가리키기) 포커스를 지도 캔버스로
  // 그대로 두면 포커스가 페이지 처음으로 튐
  const focusedRef = useRef<Element | null>(null);
  useEffect(() => {
    const container = api.map.getContainer();
    const onFocusIn = (event: FocusEvent) => {
      focusedRef.current =
        event.target instanceof Element &&
        event.target.closest("[data-beach-marker]")
          ? event.target
          : null;
    };
    container.addEventListener("focusin", onFocusIn);
    return () => container.removeEventListener("focusin", onFocusIn);
  }, [api]);
  useEffect(() => {
    const focused = focusedRef.current;
    if (!focused || focused.isConnected) return;
    focusedRef.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body)
      api.map.getCanvas().focus({ preventScroll: true });
  }, [groups, api]);
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

  return groups.map((group) => {
    if (group.kind === "cluster") {
      return (
        <BeachMarker
          key={group.key}
          api={api}
          lngLat={[group.center.lng, group.center.lat]}
          hidden={false}
        >
          <ClusterFace
            count={group.items.length}
            label={t("cluster", { count: group.items.length })}
            onClick={() => zoomToCluster(api, group.bounds)}
          />
        </BeachMarker>
      );
    }
    const marker = group.item;
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

// 묶음을 누르면 그 해변들이 보이는 범위로 확대. 범위가 넓어도 적어도 한 단계는 확대(누를 때마다 풀리게)
// 확대 11(CLUSTER_MAX_ZOOM)까지만 맞춰서 한 곳에 몰린 묶음도 개별 마커로 풀림
// 여백은 지도 범위 맞추기와 같음(오른쪽 버튼 열 밑으로 마커가 들어가지 않게)
// 누른 묶음은 풀리면서 사라지므로 포커스를 지도 캔버스로 옮김(키보드 포커스가 페이지 처음으로 튀지 않게)
function zoomToCluster(api: MapHandle, bounds: LngLatBox) {
  const map = api.map;
  const camera = map.cameraForBounds(bounds, {
    padding: FIT_OPTIONS.padding,
    maxZoom: CLUSTER_MAX_ZOOM,
  });
  map.getCanvas().focus({ preventScroll: true });
  const atLeast = Math.min(map.getZoom() + 1, map.getMaxZoom());
  const [[west, south], [east, north]] = bounds;
  map.easeTo({
    center: camera?.center ?? [(west + east) / 2, (south + north) / 2],
    zoom: Math.max(camera?.zoom ?? 0, atLeast),
    animate: !prefersReducedMotion(),
  });
}

// 마커 하나: 지도에 붙일 요소를 만들고 그 안에 React로 그림(포털)
// hidden: 해변 마커는 화면 읽기·Tab에서 뺌(목록에서 모두 닿음). 묶음은 누르는 버튼이라 뺄 수 없음(결정 8 키보드 조작)
function BeachMarker({
  api,
  lngLat,
  hidden = true,
  children,
}: {
  api: MapHandle;
  lngLat: [number, number];
  hidden?: boolean;
  children: ReactNode;
}) {
  // 지도에 붙일 빈 요소. 지도가 다 그려진 뒤(브라우저)에만 이 부품이 그려지므로 document를 씀
  const [node] = useState(() => {
    const element = document.createElement("div");
    if (hidden) element.setAttribute("aria-hidden", "true");
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

// 묶음: 해변 수만 보여 주는 중립 원(상태 색·아이콘 없음 → 대표 상태로 읽히지 않게). 누르면 그 범위로 확대
// 해변 마커와 같은 44px 누르는 자리. 접근 가능한 이름에 해변 수와 동작을 담음
export function ClusterFace({
  count,
  label,
  onClick,
}: {
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-touch cursor-pointer items-center justify-center rounded-full"
    >
      <span
        aria-hidden="true"
        className="flex size-9 items-center justify-center rounded-full border-2 border-text-body bg-bg-surface text-caption font-bold text-text-default tabular-nums shadow-card"
      >
        {count}
      </span>
    </button>
  );
}
