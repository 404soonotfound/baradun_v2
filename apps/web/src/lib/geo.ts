// 두 좌표 사이 거리 (BRD-26). 홈 '가까운 바다', 탐색 '가까운 순', 대안 해변 30km에 씀
// 하버사인 공식: 지구를 공으로 보고 표면을 따라 잴 거리(지구 모양 때문에 오차 0.5% 안팎)
// 위치는 기기 안에서 거리 계산에만 씀(서버로 보내지 않음)

// [1] 좌표 모양
export type LatLng = { lat: number; lng: number };

// [2] 지구 평균 반지름
const EARTH_RADIUS_KM = 6371;

// [3] 도(°) → 라디안. Math.sin·cos는 라디안을 받음
function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

// [4] 두 좌표 사이 거리(km)
export function distanceKm(from: LatLng, to: LatLng): number {
  const dLat = toRad(to.lat - from.lat);
  const dLng = toRad(to.lng - from.lng);
  // x ** 2 = x의 제곱
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) *
      Math.cos(toRad(to.lat)) *
      Math.sin(dLng / 2) ** 2;
  // Math.min(1, …): 소수 계산 오차로 1을 살짝 넘으면 asin이 NaN이 되는 것 방지
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

// [5] 가까운 순 정렬 + 항목마다 distanceKm 붙이기. 원본 배열은 고치지 않음
// <T extends { coords: LatLng }> = 제네릭. BeachSummary든 다른 항목이든 coords만 있으면 받음
// 돌려주는 항목 타입은 받은 타입 그대로 + distanceKm(교차 타입 &)
export function sortByDistance<T extends { coords: LatLng }>(
  items: readonly T[],
  from: LatLng,
): (T & { distanceKm: number })[] {
  return items
    .map((item) => ({ ...item, distanceKm: distanceKm(from, item.coords) }))
    .sort((a, b) => a.distanceKm - b.distanceKm); // 음수면 a가 앞
}

// [6] maxKm 안(같으면 포함)만 가까운 순으로. 대안 해변 '30km 이내'에 씀
export function withinKm<T extends { coords: LatLng }>(
  items: readonly T[],
  from: LatLng,
  maxKm: number,
): (T & { distanceKm: number })[] {
  return sortByDistance(items, from).filter((item) => item.distanceKm <= maxKm);
}
