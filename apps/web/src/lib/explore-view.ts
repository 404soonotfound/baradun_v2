import { useSyncExternalStore } from "react";

// 탐색의 마지막 보기 [목록 | 지도] (BRD-30 · 노션 2장 EXP-M, 아키텍처 9장 '화면 상태 유지')
// 모바일에서만 고름(PC는 목록과 지도를 함께 보여 줌). 기기 저장(localStorage)
// 못 쓰는 환경이면 이번 방문 동안은 메모리 값(explore-sort.ts와 같은 틀)
export type ExploreView = "list" | "map";

const STORAGE_KEY = "baradun:explore-view";
const DEFAULT_VIEW: ExploreView = "list";

let memory: ExploreView = DEFAULT_VIEW;
// 쓰기가 실패한 적 있음. 이후로는 저장소의 옛 값이 방금 고른 값을 덮지 않게 memory를 읽음
let writeFailed = false;
const listeners = new Set<() => void>();

export function isExploreView(value: unknown): value is ExploreView {
  return value === "list" || value === "map";
}

function read(): ExploreView {
  if (writeFailed) return memory;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isExploreView(stored) ? stored : memory;
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

export function setExploreView(view: ExploreView) {
  memory = view;
  try {
    localStorage.setItem(STORAGE_KEY, view);
    writeFailed = false;
  } catch {
    writeFailed = true;
  }
  listeners.forEach((listener) => listener());
}

// 서버(정적 HTML)는 저장 값을 몰라 목록, 브라우저에서는 저장된 값
export function useExploreView(): ExploreView {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_VIEW);
}

// 테스트용
export const readExploreViewForTest = read;
export function resetExploreViewForTest() {
  memory = DEFAULT_VIEW;
  writeFailed = false;
}
