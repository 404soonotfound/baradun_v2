import { isValidLatLng, sortByDistance, type LatLng } from "@/lib/geo";
import { locationRetrying, type LocationState } from "@/lib/location";
import { boundsOf, MAX_BOUNDS, withinBox, type LngLatBox } from "./bounds";
import { CLUSTER_MAX_ZOOM } from "./cluster";

// 지도 '내 주변 보기' (BRD-114 · 결정 기록 12장 결정 5)
// 정확한 위치는 여기서 거리 계산에만 씀. 옮길 범위는 가까운 해변 좌표만으로 만들고 내 위치는 넣지 않음
// → 지도 타일 요청(지도 판 파일 범위 요청)에는 해변 근처 범위만 드러나고, 내 위치 점도 그리지 않음

// 내 위치에서 가까운 해변 몇 곳을 감싸는 범위로 옮김(주변을 파악할 만큼)
export const NEARBY_BEACH_COUNT = 3;

// 이보다 깊게 확대하지 않음(해변이 한곳에 몰려 있어도 내 위치 근처를 크게 보여 주지 않게)
// 묶음이 풀리는 단계(11)까지: 그보다 낮으면 가까운 해변끼리 숫자 묶음 하나로 보여 상태·사유가 안 보임
export const NEARBY_MAX_ZOOM = CLUSTER_MAX_ZOOM;

// [1] 내 위치에서 가까운 순으로 count곳. 고른 지역과 상관없이 받은 해변 전체에서 고름
// 좌표가 잘못된 해변은 정렬 전에 뺌(거리가 NaN이면 정렬 순서가 어긋남)
export function nearbyBeaches<T extends { coords: LatLng }>(
  beaches: readonly T[],
  from: LatLng,
  count = NEARBY_BEACH_COUNT,
): (T & { distanceKm: number })[] {
  if (!isValidLatLng(from)) return [];
  return sortByDistance(
    beaches.filter((beach) => isValidLatLng(beach.coords)),
    from,
  ).slice(0, count);
}

// [2] 옮길 곳. 가까운 해변이 지금 보이는 해변(고른 지역) 밖에 하나라도 있으면 전국으로 바꿔야 마커가 보임
// 내 위치가 지도를 옮길 수 있는 범위(MAX_BOUNDS) 밖이면 '주변'이 아니라서 옮기지 않음(거리 기준을 따로 만들지 않음)
// 옮길 해변이 없어도 null. ids는 고른 해변(묶음에서 꺼내 개별 마커로 보여 줌)
export function nearbyPlan<T extends { id: string; coords: LatLng }>(
  beaches: readonly T[],
  shownIds: ReadonlySet<string>,
  from: LatLng,
): { box: LngLatBox; ids: string[]; nationwide: boolean } | null {
  if (!isValidLatLng(from) || !withinBox(from, MAX_BOUNDS)) return null;
  const nearest = nearbyBeaches(beaches, from);
  if (nearest.length === 0) return null;
  return {
    box: boundsOf(nearest.map((beach) => beach.coords)),
    ids: nearest.map((beach) => beach.id),
    nationwide: nearest.some((beach) => !shownIds.has(beach.id)),
  };
}

// [3] 눌러서 위치를 기다리는 중에 위치 상태가 바뀌면 할 일
// move = 받은 위치로 옮기고 기다림 끝 · wait = 계속 기다림(받는 중, 다른 곳의 '다시 시도' 답을 기다리는 중 포함)
// stop = 기다림 끝(거부·꺼짐·받을 수 없음. 나중에 다른 곳이 받은 위치로 지도를 옮기지 않게)
export function nearbyWaitStep(state: LocationState): "move" | "wait" | "stop" {
  if (state.status === "ready") return "move";
  if (
    state.status === "locating" ||
    state.status === "checking" ||
    locationRetrying(state)
  )
    return "wait";
  return "stop";
}
