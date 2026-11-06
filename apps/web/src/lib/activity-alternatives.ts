import type { Activity } from "@/lib/activity";
import { ACTIVITIES } from "@/lib/activity";
import type { BeachSummary } from "@/lib/beach-summary";
import { type HomeScope, scopeBeaches } from "@/lib/region-list";

// 홈 '대신 찾아보기' 줄 고르기 (노션 D18-6). 화면 글·동작은 부르는 쪽(home-screen)이 붙임
// ① 고른 활동이 전국에 있고 지금 범위가 전국이 아니면 '전국 ○○ 해변 n곳'이 먼저
// ② 그다음 같은 범위의 다른 활동 해변(0곳이면 줄을 두지 않음). 가까운 바다로 볼 때는 개수 없이, 전국에 있는 활동만
// 수영은 전체 해변이라(B7) 대신 찾아볼 일이 없음 → 빈 목록
export type AlternativeItem =
  | { kind: "nationwide"; activity: Activity; count: number }
  | { kind: "scoped"; activity: Activity; count: number }
  | { kind: "nearby"; activity: Activity };

// 활동이 확인된 해변 수(수영은 전체)
export function activityCount(
  beaches: readonly BeachSummary[],
  activity: Activity,
): number {
  return activity === "swimming"
    ? beaches.length
    : beaches.filter((beach) => beach.activities.includes(activity)).length;
}

export function activityAlternatives(
  beaches: readonly BeachSummary[],
  scope: HomeScope,
  activity: Activity,
): AlternativeItem[] {
  if (activity === "swimming") return [];
  const items: AlternativeItem[] = [];
  const nationwide = activityCount(beaches, activity);
  if (scope.kind !== "nationwide" && nationwide > 0) {
    items.push({ kind: "nationwide", activity, count: nationwide });
  }
  for (const other of ACTIVITIES) {
    if (other === activity) continue;
    if (scope.kind === "nearby") {
      if (activityCount(beaches, other) > 0) {
        items.push({ kind: "nearby", activity: other });
      }
      continue;
    }
    const count = scopeBeaches(beaches, scope, other).length;
    if (count > 0) items.push({ kind: "scoped", activity: other, count });
  }
  return items;
}
