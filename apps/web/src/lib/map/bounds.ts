import type { LatLng } from "@/lib/geo";

// 지도 처음 보이는 범위 (BRD-65). 해변 좌표만으로 정함(사용자 위치로 지도를 옮기지 않음, 점검표 8)

// [1] [서남쪽 [경도, 위도], 동북쪽 [경도, 위도]] — MapLibre fitBounds 모양
export type LngLatBox = [[number, number], [number, number]];

// 출시 해변 전체가 들어가는 남한 범위(제주·울릉 포함). 해변이 없을 때 기본값
export const KOREA_BOUNDS: LngLatBox = [
  [124.5, 33.0],
  [131.0, 38.7],
];

// 지도를 끌어도 이 밖으로는 나가지 않음(쓸모없는 먼 타일을 받지 않게)
export const MAX_BOUNDS: LngLatBox = [
  [119.5, 30.5],
  [135.5, 41.5],
];

// 범위에 맞출 때 가장자리 여백(px)과 최대 확대(해변 하나일 때 너무 가까이 가지 않게)
export const FIT_OPTIONS = { padding: 40, maxZoom: 12 } as const;

// [2] 좌표들을 감싸는 상자. 숫자가 아니거나 범위 밖 좌표는 빼고, 남는 게 없으면 남한 범위
export function boundsOf(points: readonly LatLng[]): LngLatBox {
  const valid = points.filter(
    (p) =>
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lng) &&
      Math.abs(p.lat) <= 90 &&
      Math.abs(p.lng) <= 180,
  );
  if (valid.length === 0) return KOREA_BOUNDS;
  const lats = valid.map((p) => p.lat);
  const lngs = valid.map((p) => p.lng);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}
