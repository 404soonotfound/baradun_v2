import { sortByDistance, type LatLng } from "@/lib/geo";

// 지도 '내 주변 보기' (BRD-114 · 결정 기록 12장 결정 5)
// 정확한 위치는 여기서 거리 계산에만 씀. 옮길 범위는 가까운 해변 좌표만으로 만들고 내 위치는 넣지 않음
// → 지도 타일 요청(제3자 OpenFreeMap)에는 해변 근처 범위만 드러나고, 내 위치 점도 그리지 않음

// 내 위치에서 가까운 해변 몇 곳을 감싸는 범위로 옮김(주변을 파악할 만큼)
export const NEARBY_BEACH_COUNT = 3;

// 이보다 깊게 확대하지 않음(해변이 한곳에 몰려 있어도 내 위치 근처를 크게 보여 주지 않게)
export const NEARBY_MAX_ZOOM = 10;

// 내 위치에서 가까운 순으로 count곳. 고른 지역과 상관없이 받은 해변 전체에서 고름
export function nearbyBeaches<T extends { coords: LatLng }>(
  beaches: readonly T[],
  from: LatLng,
  count = NEARBY_BEACH_COUNT,
): (T & { distanceKm: number })[] {
  return sortByDistance(beaches, from)
    .filter((beach) => Number.isFinite(beach.distanceKm))
    .slice(0, count);
}
