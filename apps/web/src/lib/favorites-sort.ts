import { useSyncExternalStore } from "react";

import type { BeachView, Category } from "@/lib/snapshot/view";

// 즐겨찾기 목록 정렬 선택 (GH-530 · 결정 기록 29장 D29-3)
// 기기 저장(localStorage). 못 쓰는 환경이면 이번 방문 동안은 메모리 값(lib/explore-sort.ts와 같은 틀)
const STORAGE_KEY = "baradun:favorites-sort";

export type FavoritesSort = "status" | "added";
const DEFAULT_SORT: FavoritesSort = "status";

// 상태 먼저: 위험·미확인 정보를 위로 (이용불가 → 판단불가 → 특보 없음)
export const FAVORITES_CATEGORY_ORDER: readonly Category[] = [
  "unavailable",
  "undetermined",
  "clear",
];

let memory: FavoritesSort = DEFAULT_SORT;
// 쓰기가 실패한 적 있음. 이후로는 저장소의 옛 값이 방금 고른 값을 덮지 않게 memory를 읽음
let writeFailed = false;
const listeners = new Set<() => void>();

export function isFavoritesSort(value: unknown): value is FavoritesSort {
  return value === "status" || value === "added";
}

function read(): FavoritesSort {
  if (writeFailed) return memory;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isFavoritesSort(stored) ? stored : memory;
  } catch {
    return memory;
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function setFavoritesSort(choice: FavoritesSort) {
  memory = choice;
  try {
    localStorage.setItem(STORAGE_KEY, choice);
    writeFailed = false;
  } catch {
    writeFailed = true;
  }
  listeners.forEach((listener) => listener());
}

// 기기 데이터 초기화(BRD-36): 저장값을 지우고 기본(상태 먼저)으로 되돌림
export function clearFavoritesSort() {
  memory = DEFAULT_SORT;
  try {
    localStorage.removeItem(STORAGE_KEY);
    writeFailed = false;
  } catch {
    writeFailed = true;
  }
  listeners.forEach((listener) => listener());
}

// 서버(정적 HTML)는 저장 값을 몰라 기본값, 브라우저에서는 저장된 값
export function useFavoritesSort(): FavoritesSort {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_SORT);
}

// 테스트용: 메모리 상태 되돌리기
export function resetFavoritesSortForTest() {
  memory = DEFAULT_SORT;
  writeFailed = false;
}

function statusRank(view: BeachView): number {
  if (view.kind !== "ready") return FAVORITES_CATEGORY_ORDER.length;
  const index = FAVORITES_CATEGORY_ORDER.indexOf(view.category);
  return index === -1 ? FAVORITES_CATEGORY_ORDER.length : index;
}

/**
 * 즐겨찾기 목록을 고른 정렬 방식으로 줄 세움. 같은 상태 안에서는 넣은 순서를 유지함.
 */
export function sortFavoriteItems<T extends { view: BeachView }>(
  items: readonly T[],
  sort: FavoritesSort,
): T[] {
  if (sort === "added") return [...items];
  return [...items].sort((a, b) => statusRank(a.view) - statusRank(b.view));
}
