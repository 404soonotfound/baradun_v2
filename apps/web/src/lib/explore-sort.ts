import { useSyncExternalStore } from "react";

import type { SortChoice } from "@/lib/explore";

// 탐색 목록의 마지막 정렬 선택 (BRD-29 · 노션 2장 EXP-L, 아키텍처 9.1 '화면 상태 유지')
// 기기 저장(localStorage). 못 쓰는 환경이면 이번 방문 동안은 메모리 값(lib/activity.ts와 같은 틀)
const STORAGE_KEY = "baradun:explore-sort";
const DEFAULT_SORT: SortChoice = "status";

let memory: SortChoice = DEFAULT_SORT;
// 쓰기가 실패한 적 있음. 이후로는 저장소의 옛 값이 방금 고른 값을 덮지 않게 memory를 읽음
let writeFailed = false;
const listeners = new Set<() => void>();

export function isSortChoice(value: unknown): value is SortChoice {
  return value === "status" || value === "second";
}

function read(): SortChoice {
  if (writeFailed) return memory;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isSortChoice(stored) ? stored : memory;
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

export function setSortChoice(choice: SortChoice) {
  memory = choice;
  try {
    localStorage.setItem(STORAGE_KEY, choice);
    writeFailed = false;
  } catch {
    writeFailed = true;
  }
  listeners.forEach((listener) => listener());
}

// 기기 데이터 초기화(BRD-36): 저장값을 지우고 기본(상태별)으로
export function clearSortChoice() {
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
export function useSortChoice(): SortChoice {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_SORT);
}

// 테스트용: 메모리 상태 되돌리기
export function resetSortChoiceForTest() {
  memory = DEFAULT_SORT;
  writeFailed = false;
}
