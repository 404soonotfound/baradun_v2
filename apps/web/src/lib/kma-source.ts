import type { SnapshotState } from "@/lib/snapshot/store";

// 화면에 기상청 출처(줄·기관 이름)를 둘지 (BRD-113 · 기상법 출처 표시)
// 받은(또는 기기에 저장된) 실제 상태가 있을 때만. 불러오는 중·처음부터 못 받음은 기상청 자료가 화면에 없음
// 개발용 예시 특보·관측값(dev:data)은 기상청 자료가 아니므로 출처를 붙이지 않음(실제·예시 구분, 제품 규칙)
export function showsKmaSource(
  snapshot: Pick<SnapshotState, "statuses">,
  sampleSnapshot: boolean,
): boolean {
  return snapshot.statuses !== null && !sampleSnapshot;
}
