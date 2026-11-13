import { deriveBeachView, type BadgeLabel, type ViewSource } from "./view";

// 배지 사유 비교용 키. 분류는 같아도 사유가 바뀌면 변경으로 봄
export function badgeKey(badge: BadgeLabel): string {
  if (badge.kind === "warning") {
    return `warning:${badge.type}:${badge.level}`;
  }
  return badge.kind;
}

// 직전에 이 화면에 띄웠던 상태(prev)와 새로 받은 게시본(next)을 비교해
// 분류나 대표 배지가 바뀐 해변 id -> 이전 배지 사유 맵을 반환함.
// 기기에 지난 방문 상태를 저장하지 않고 메모리 안 직전 상태만 씀(결정 11)
export function diffBeachStatuses(
  beaches: readonly { id: string; hidden?: boolean }[],
  prev: ViewSource,
  next: ViewSource,
): Map<string, BadgeLabel> {
  const changed = new Map<string, BadgeLabel>();
  if (
    prev.phase !== "ready" ||
    next.phase !== "ready" ||
    !prev.statuses ||
    !next.statuses
  ) {
    return changed;
  }

  for (const beach of beaches) {
    if (beach.hidden) continue;
    const target = { id: beach.id, hidden: false };
    const prevView = deriveBeachView(target, prev);
    const nextView = deriveBeachView(target, next);
    if (prevView.kind !== "ready" || nextView.kind !== "ready") continue;
    if (
      prevView.category !== nextView.category ||
      badgeKey(prevView.badge) !== badgeKey(nextView.badge)
    ) {
      changed.set(beach.id, prevView.badge);
    }
  }

  return changed;
}
