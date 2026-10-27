import { useSyncExternalStore } from "react";

import type { SavedRegion } from "@/lib/region-list";

// 기본 지역 (BRD-11 결정: 위치 권한이 없을 때 홈에서 고르는 지역, 기기 저장) (BRD-26·27)
// 칩은 출시된 해변이 있는 시·도만. 고른 뒤 지역 선택 창에서 시·군까지 고름
// 기기 저장만 여기. 순수 계산(지리 순서·칩·지역 묶음)은 lib/region-list.ts (BRD-27에서 나눔)

// [6] ── 기기 저장 (lib/activity.ts와 같은 틀) ──
const STORAGE_KEY = "baradun:region";
let memory: SavedRegion | null = null; // 저장소를 못 쓰는 환경 대비
let lastRaw: string | null = null; // 같은 글자면 같은 객체를 돌려주기 위한 기억
let lastValue: SavedRegion | null = null;
// 쓰기가 실패한 적 있음(읽기는 되는데 쓰기만 막힌 환경). 이후로는 memory를 읽음
let writeFailed = false;
const listeners = new Set<() => void>();

// [7] 저장 글자 → 지역. 모양이 다르면 null(고르지 않은 것으로 봄)
function parse(raw: string | null): SavedRegion | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    // as Record<string, unknown> = "어떤 칸이든 있을 수 있는 객체"로 보고 칸을 꺼냄
    const { sido, sigungu } = value as Record<string, unknown>;
    if (typeof sido !== "string") return null;
    return { sido, sigungu: typeof sigungu === "string" ? sigungu : null };
  } catch {
    return null;
  }
}

// [8] 저장값 읽기. 글자가 같으면 같은 객체
function read(): SavedRegion | null {
  if (writeFailed) return memory; // 저장소의 옛 값이 방금 고른 지역을 덮지 않게
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return memory;
  }
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastValue = parse(raw);
  }
  return lastValue;
}

// [9] 바뀔 때 알림 받기(다른 탭 포함)
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

// [10] 지역 고르기·바꾸기. null이면 저장한 지역 지움(기기 데이터 초기화)
export function setRegion(next: SavedRegion | null) {
  memory = next;
  try {
    if (next === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 저장 못 해도 memory로 이번 방문 동안은 유지
    writeFailed = true;
  }
  listeners.forEach((listener) => listener());
}

// [11] 화면에서: const region = validRegion(useRegion(), beaches);  (validRegion은 region-list.ts)
export function useRegion(): SavedRegion | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
