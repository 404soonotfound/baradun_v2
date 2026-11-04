import { useSyncExternalStore } from "react";

// 왼쪽 메뉴 '문의'의 접수 수 배지 (BRD-153, 화면 설계서 6장 공통 틀 '문의에 새 문의 수 배지')
// 이 탭 메모리에만 둠. 문의 목록 첫 쪽(상태별 수)을 받을 때마다 고치고, 처음 열 때 공통 틀이 한 번 읽음
// 상태 GSI는 최종적 일관성이라 저장 직후 잠시 늦을 수 있음(D16-B4)

let received: number | null = null;
const listeners = new Set<() => void>();

export function setReceivedCount(count: number): void {
  if (received === count) return;
  received = count;
  for (const listener of listeners) listener();
}

// 이 탭에서 상태를 바꿨을 때 바로 반영(접수에서 빠지면 -1, 접수로 돌아오면 +1)
export function adjustReceivedCount(delta: number): void {
  if (received === null) return;
  setReceivedCount(Math.max(0, received + delta));
}

export function receivedCountKnown(): boolean {
  return received !== null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useReceivedCount(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => received,
    () => null,
  );
}
