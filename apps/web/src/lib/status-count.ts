import type { BadgeLabel, BeachView, Category } from "@/lib/snapshot/view";

// 지역 해변 상태별 개수 (노션 2장 HOME 8 '지역 해변 상태별 개수 카드', BRD-27)
// 게시된 분류(category)와 배지 사유를 그대로 셈(G1). 여기서 상태를 새로 정하지 않음
// 순서: 특보 없음 → 이용불가 → 판단불가(탐색 상태별 묶음과 같은 순서). 같은 분류 안은 먼저 나온 순

// [1] 한 칸: 분류 + 배지 사유 + 개수
export type StatusCount = {
  category: Category;
  label: BadgeLabel;
  count: number;
};

// [2] 분류 순서표
export const CATEGORY_ORDER: readonly Category[] = [
  "clear",
  "unavailable",
  "undetermined",
];

// [3] 같은 사유인지 비교할 글자. 특보는 종류·단계까지 같아야 같은 칸
function labelKey(label: BadgeLabel): string {
  return label.kind === "warning"
    ? `warning:${label.type}:${label.level}`
    : label.kind;
}

// [4] 화면 상태 목록 → 칸 목록. 하나라도 아직 불러오는 중이면 null(개수를 미리 보이지 않음)
export function countByStatus(
  views: readonly BeachView[],
): StatusCount[] | null {
  const counts = new Map<string, StatusCount>();
  for (const view of views) {
    if (view.kind === "loading") return null;
    if (view.kind === "hidden") continue; // 노출 끈 해변은 세지 않음
    const key = `${view.category}|${labelKey(view.badge)}`;
    const found = counts.get(key);
    if (found) found.count += 1;
    else
      counts.set(key, { category: view.category, label: view.badge, count: 1 });
  }
  // sort는 순번이 같으면 원래 순서를 지킴(먼저 나온 사유가 앞)
  return [...counts.values()].sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );
}

// [5] 고른 해변들의 가장 이른 특보 확인 시각
// undefined = 고른 해변 없음. null = 확인 시각을 모르는 해변이 섞임(가장 이른 시각을 알 수 없음)
type ReadyView = Extract<BeachView, { kind: "ready" }>;
function oldestConfirmedAt(
  views: readonly BeachView[],
  pick: (view: ReadyView) => boolean,
): string | null | undefined {
  let oldest: string | undefined;
  let oldestMs = Infinity;
  for (const view of views) {
    if (view.kind !== "ready" || !pick(view)) continue;
    const ms = view.confirmedAt === null ? NaN : Date.parse(view.confirmedAt);
    if (!Number.isFinite(ms)) return null;
    if (ms < oldestMs) {
      oldestMs = ms;
      oldest = view.confirmedAt ?? undefined;
    }
  }
  return oldest;
}

// [6] '특보 없음'으로 센 해변들의 가장 이른 특보 확인 시각(집계 전체의 가장 오래된 근거)
// '특보 없음'이 없거나, 확인 시각을 모르는 '특보 없음'이 섞이면 null(시각을 내세우지 않음)
export function clearCheckedAt(views: readonly BeachView[]): string | null {
  return (
    oldestConfirmedAt(
      views,
      (view) => !view.stale && view.badge.kind === "clear",
    ) ?? null
  );
}

// [7] 오래된(B5: 오프라인·만료) 해변들의 가장 이른 특보 확인 시각 (노션 결정 기록 11장 화면 잔여 결정 10/27 ②)
// null = 오래된 해변 없음(줄을 보이지 않음). { confirmedAt: null } = 오래됐지만 시각을 모름
// 확인 시각을 모르는 오래된 해변이 섞이면 시각을 내세우지 않음(가장 이른 시각을 알 수 없음)
export function staleCheckedAt(
  views: readonly BeachView[],
): { confirmedAt: string | null } | null {
  const confirmedAt = oldestConfirmedAt(views, (view) => view.stale);
  return confirmedAt === undefined ? null : { confirmedAt };
}

// [8] 분류별 묶음 (PC 홈 히어로 상태 요약 카드 3장, Figma 181:819, BRD-129)
// 칸 목록(countByStatus)을 분류 순서대로 다시 묶음. 해변이 없는 분류도 0곳으로 남김(보일지는 부르는 쪽이 정함)
// 개수는 칸의 합이라 게시된 분류를 다시 계산하지 않음(G1)
export type CategorySummary = {
  category: Category;
  count: number;
  reasons: StatusCount[]; // 이 분류 안의 사유별 칸(먼저 나온 순)
};

export function summarizeByCategory(
  counts: readonly StatusCount[],
): CategorySummary[] {
  return CATEGORY_ORDER.map((category) => {
    const reasons = counts.filter((item) => item.category === category);
    return {
      category,
      count: reasons.reduce((sum, item) => sum + item.count, 0),
      reasons,
    };
  });
}
