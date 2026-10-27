import type { WarningItem } from "@baradun/contracts";

// 특보 상세 시트의 확인 시각 (BRD-33 · B5)
// 시트를 연 사이 새 조회에서 그 특보가 빠지면(해제·단계 변경) 새 목록의 확인 시각을 쓰지 않고,
// 그 특보가 목록에 마지막으로 있던 조회의 확인 시각을 씀 → 'HH:MM 확인 · 이후 확인 못 함'

export type SeenWarning = { item: WarningItem; confirmedAt: string | null };

// 같은 특보인지: 구역·종류·단계·발표 시각(목록 key와 같은 기준). 조회마다 새 객체라 값으로 비교
export function sameWarning(a: WarningItem, b: WarningItem): boolean {
  return (
    a.zoneCode === b.zoneCode &&
    a.zoneName === b.zoneName &&
    a.type === b.type &&
    a.level === b.level &&
    a.publishedAt === b.publishedAt
  );
}

// 지금 목록에 있으면 지금 확인 시각으로 갱신, 없으면 이전에 기억한 같은 특보의 시각 유지.
// 목록에 있던 적이 없으면 null(확인 시각 모름)
export function rememberSeen(
  previous: SeenWarning | null,
  item: WarningItem | null,
  items: readonly WarningItem[],
  confirmedAt: string | null,
): SeenWarning | null {
  if (item === null) return null;
  if (items.some((other) => sameWarning(other, item))) {
    // 바뀐 것이 없으면 이전 값 그대로(렌더 중 상태 갱신이 반복되지 않게)
    return previous?.item === item && previous.confirmedAt === confirmedAt
      ? previous
      : { item, confirmedAt };
  }
  return previous && sameWarning(previous.item, item) ? previous : null;
}
