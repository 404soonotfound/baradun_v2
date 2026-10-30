import type { BeachSummary } from "@/lib/beach-summary";
import { distanceKm, type LatLng } from "@/lib/geo";
// 타입만 가져옴(훅 파일이지만 빌드 때 지워짐)
import type { LocationState } from "@/lib/location";
import { inRegion, type SavedRegion } from "@/lib/region-list";
import type { BeachView, Category, MetricKey } from "@/lib/snapshot/view";
import {
  CATEGORY_ORDER,
  clearCheckedAt,
  countByStatus,
  type StatusCount,
} from "@/lib/status-count";

// 탐색 목록 계산 (BRD-29 · 노션 2장 EXP-L). React를 쓰지 않는 순수 함수만 모음
// 분류는 스냅샷이 게시한 값 그대로(G1). 여기서는 거르고·묶고·줄 세우기만 함(점수·순위 없음)

// [1] 목록 한 줄. 거리는 위치가 있을 때만(없으면 null)
export type ExploreItem = BeachSummary & {
  distanceKm: number | null;
  view: BeachView;
};

// [2] 정렬 선택(기기 저장 값). 버튼 이름은 늘 '상태별 | 가까운 순'(BRD-128 · 10/30 결정)
// "second" = 가까운 순. 위치가 없으면(거부·실패·시간 초과·아직 안 물음) 이름 순으로 보여 줌
export type SortChoice = "status" | "second";
// 실제로 쓰는 보기. 위치가 있을 때만 가까운 순
export type ExploreMode = "status" | "near" | "name";

export function exploreMode(
  choice: SortChoice,
  location: LocationState["status"],
): ExploreMode {
  if (choice === "status") return "status";
  return location === "ready" ? "near" : "name";
}

// [2-1] '가까운 순'을 눌렀을 때 위치를 물을지. 사용자가 누른 것이라 반복 요청이 아님(홈 '내 주변'과 같은 규칙)
// 아직 안 물음·권한 확인 중 → 그때 처음 물음, 받을 수 없음(시간 초과·기기 오류) → 다시 시도
// 거부·설정에서 끔은 다시 묻지 않음, 받는 중·받은 위치는 그대로
export function asksLocationOnNear(status: LocationState["status"]): boolean {
  return status === "idle" || status === "checking" || status === "unavailable";
}

// [2-2] 위치 안내 배너 종류(Figma S_M02_06 174:635). 위치 없이 이름 순으로 보이는 이유를 알림
//   denied   = 거부·설정에서 끔(상태별·가까운 순 모두. 묶음 안도 이름 순)
//   failed   = 받을 수 없음(시간 초과·기기 오류)
//   notAsked = 가까운 순을 골라 뒀는데 이번 방문에 아직 묻지 않음(묻는 창은 버튼으로만)
// 아직 안 물었고 상태별이면 안내 없음(지금처럼 정렬)
export type LocationNotice = "denied" | "failed" | "notAsked";

export function locationNotice(
  choice: SortChoice,
  status: LocationState["status"],
): LocationNotice | null {
  if (status === "denied" || status === "off") return "denied";
  if (status === "unavailable") return "failed";
  if (status === "idle" && choice === "second") return "notAsked";
  return null;
}

// [3] 지역으로 거르기(전국 = null). 탐색·검색은 활동으로 거르지 않음(BRD-128 · 10/30 결정: 판단은 활동과 무관, G1)
export function filterBeaches(
  beaches: readonly BeachSummary[],
  region: SavedRegion | null,
): BeachSummary[] {
  return beaches.filter((beach) => region === null || inRegion(beach, region));
}

// 측정소 정보가 없는 값은 출처를 붙일 수 없어 보이지 않음("–"). 가까운 바다 카드와 같은 규칙
function withSourcedMetrics(beach: BeachSummary, view: BeachView): BeachView {
  if (view.kind !== "ready") return view;
  const metrics = { ...view.metrics };
  for (const key of Object.keys(metrics) as MetricKey[]) {
    if (metrics[key].kind === "value" && beach.stations[key] === null) {
      metrics[key] = { kind: "hidden" };
    }
  }
  return { ...view, metrics };
}

// [4] 해변 → 목록 줄. 노출을 끈 해변(view.kind "hidden")은 뺌(개수·목록 모두)
export function buildItems(
  beaches: readonly BeachSummary[],
  coords: LatLng | null,
  viewOf: (beach: BeachSummary) => BeachView,
): ExploreItem[] {
  return beaches.flatMap((beach) => {
    const view = withSourcedMetrics(beach, viewOf(beach));
    if (view.kind === "hidden") return [];
    return [
      {
        ...beach,
        distanceKm: coords ? distanceKm(coords, beach.coords) : null,
        view,
      },
    ];
  });
}

// [5] 아직 한 번도 못 받은 해변이 있음 → 개수·묶음을 미리 보이지 않음
export function isLoading(items: readonly ExploreItem[]): boolean {
  return items.some((item) => item.view.kind === "loading");
}

// [6] 줄 세우기. 가까운 순은 거리(같으면 이름), 그 외 이름 순. 원본은 고치지 않음
export function sortItems(
  items: readonly ExploreItem[],
  by: "near" | "name",
  locale: string,
): ExploreItem[] {
  return [...items].sort((a, b) => {
    if (by === "near" && a.distanceKm !== null && b.distanceKm !== null) {
      const diff = a.distanceKm - b.distanceKm;
      if (diff !== 0) return diff;
    }
    return a.name.localeCompare(b.name, locale);
  });
}

// [7] 상태별 묶음. 순서는 특보 없음 → 이용불가 → 판단불가 고정, 빈 묶음은 숨김
export type ExploreGroup = {
  category: Category;
  items: ExploreItem[];
  // 사유별 개수. 사유가 하나뿐이면 제목과 겹쳐 쓰지 않음
  counts: StatusCount[];
  // 묶음에서 가장 가까운 곳(km). 위치가 없으면 null
  nearestKm: number | null;
  // '특보 없음' 묶음의 가장 이른 확인 시각(집계 전체의 가장 오래된 근거). 그 외·모르면 null
  checkedAt: string | null;
};

export function groupItems(
  items: readonly ExploreItem[],
  locale: string,
): ExploreGroup[] {
  return CATEGORY_ORDER.flatMap((category) => {
    const inGroup = items.filter(
      (item) => item.view.kind === "ready" && item.view.category === category,
    );
    if (inGroup.length === 0) return [];
    const sorted = sortItems(
      inGroup,
      inGroup.some((item) => item.distanceKm !== null) ? "near" : "name",
      locale,
    );
    const views = sorted.map((item) => item.view);
    const nearest = sorted[0]?.distanceKm ?? null;
    return [
      {
        category,
        items: sorted,
        counts: countByStatus(views) ?? [],
        nearestKm: nearest,
        checkedAt: category === "clear" ? clearCheckedAt(views) : null,
      },
    ];
  });
}

// [8] '특보 없음'이 하나도 없다는 안내를 보일지(노션 EXP-L 상태 '특보 없는 곳 없음')
// 받은 정보가 지금 것(live)이고 모든 해변이 지금 상태일 때만: 오프라인·만료로 '확인 못 함'이 된 것을
// '특보가 있는 곳뿐'으로 읽히게 하지 않음
export function noClearAtAll(
  items: readonly ExploreItem[],
  live: boolean,
): boolean {
  if (!live || items.length === 0 || isLoading(items)) return false;
  return items.every(
    (item) =>
      item.view.kind === "ready" &&
      !item.view.stale &&
      item.view.category !== "clear",
  );
}
