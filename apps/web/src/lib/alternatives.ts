import type { Activity } from "@/lib/activity";
import { withinKm, type LatLng } from "@/lib/geo";
import type { BeachView } from "@/lib/snapshot/view";

// 대안 해변 (BRD-10 결정 · 노션 3장 AltBeachCard, BRD-32)
// '특보 없음'인 해변만, 지금 보는 해변에서 가까운 순 최대 2곳, 30km 이내, 선택 활동을 지원하는 해변.
// 분류는 게시된 값 그대로(G1). B5로 '이후 확인 못 함'이 붙은 해변은 '특보 없음'이 아니라 넣지 않음
export const ALT_MAX_KM = 30;
export const ALT_MAX_COUNT = 2;

type Candidate = {
  id: string;
  coords: LatLng;
  activities: readonly Activity[];
};

// 지금 받은 정보로 '특보 없음'인지. 근거 검증은 deriveBeachView가 이미 함(빠지면 판단불가로 내려옴)
export function isClearView(view: BeachView): boolean {
  return view.kind === "ready" && view.category === "clear" && !view.stale;
}

// 수영은 전체 해변(B7), 서핑·스쿠버는 그 활동이 확인된 해변만 (홈 가까운 바다와 같은 규칙)
function supports(beach: Candidate, activity: Activity): boolean {
  return activity === "swimming" || beach.activities.includes(activity);
}

export function alternativeBeaches<T extends Candidate>(
  current: { id: string; coords: LatLng },
  beaches: readonly T[],
  activity: Activity,
  viewOf: (beach: T) => BeachView,
): (T & { distanceKm: number })[] {
  return withinKm(
    beaches.filter(
      (beach) => beach.id !== current.id && supports(beach, activity),
    ),
    current.coords,
    ALT_MAX_KM,
  )
    .filter((beach) => isClearView(viewOf(beach)))
    .slice(0, ALT_MAX_COUNT);
}
