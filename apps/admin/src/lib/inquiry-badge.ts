import { useSyncExternalStore } from "react";

// 왼쪽 메뉴 '문의'의 접수 수 배지 (BRD-153, 화면 설계서 6장 공통 틀 '문의에 새 문의 수 배지')
// 이 탭 메모리에만 둠. 문의 목록 첫 쪽(상태별 수)을 받을 때마다 고치고, 처음 열 때 공통 틀이 한 번 읽음
// 값은 읽은 계정(풀·이메일)에 묶음 → 로그아웃 뒤 다른 계정(데모 포함)으로 들어오면 앞 계정 수를 보이지 않고 다시 읽음
// 상태 GSI는 최종적 일관성이라 저장 직후 잠시 늦을 수 있음(D16-B4)

let state: { readonly owner: string; readonly count: number } | null = null;
const listeners = new Set<() => void>();

function publish(next: typeof state): void {
  state = next;
  for (const listener of listeners) listener();
}

export function setReceivedCount(owner: string, count: number): void {
  if (state?.owner === owner && state.count === count) return;
  publish({ owner, count });
}

// 이 탭에서 상태를 바꿨을 때 바로 반영(접수에서 빠지면 -1, 접수로 돌아오면 +1)
export function adjustReceivedCount(owner: string, delta: number): void {
  if (state?.owner !== owner) return;
  publish({ owner, count: Math.max(0, state.count + delta) });
}

export function receivedCountKnown(owner: string): boolean {
  return state?.owner === owner;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 다른 계정이 읽은 값이면 없음(null)
export function useReceivedCount(owner: string | null): number | null {
  return useSyncExternalStore(
    subscribe,
    () => (owner !== null && state?.owner === owner ? state.count : null),
    () => null,
  );
}

// 배지 값의 주인: 로그인한 풀과 이메일. 로그아웃이면 없음
export function badgeOwner(
  snapshot:
    | { readonly status: "signed_out" }
    | {
        readonly status: string;
        readonly pool: string;
        readonly email: string | null;
      },
): string | null {
  return snapshot.status === "signed_out" || !("pool" in snapshot)
    ? null
    : `${snapshot.pool}:${snapshot.email ?? ""}`;
}
