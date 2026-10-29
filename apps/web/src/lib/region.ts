import { useSyncExternalStore } from "react";

import {
  parseRegionChoice,
  pickedRegion,
  type RegionChoice,
  type SavedRegion,
} from "@/lib/region-list";

// 기본 지역 (BRD-11 결정: 위치 권한이 없을 때 홈에서 고르는 지역, 기기 저장) (BRD-26·27)
// 칩은 출시된 해변이 있는 시·도만. 고른 뒤 지역 선택 창에서 시·군까지 고름
// 시트·탐색에서 '전국'을 고르면 같은 칸에 전국으로 저장(BRD-127). 저장값이 없으면 홈은 기본값(homeScope)
// 기기 저장만 여기. 순수 계산(지리 순서·칩·지역 묶음·저장 글자 읽기)은 lib/region-list.ts (BRD-27에서 나눔)

// [6] ── 기기 저장 (lib/activity.ts와 같은 틀) ──
const STORAGE_KEY = "baradun:region";
let memory: RegionChoice | null = null; // 저장소를 못 쓰는 환경 대비
let lastRaw: string | null = null; // 같은 글자면 같은 객체를 돌려주기 위한 기억
let lastValue: RegionChoice | null = null;
// 쓰기가 실패한 적 있음(읽기는 되는데 쓰기만 막힌 환경). 이후로는 memory를 읽음
let writeFailed = false;
const listeners = new Set<() => void>();

// [7] 저장값 읽기. 글자가 같으면 같은 객체
function read(): RegionChoice | null {
  if (writeFailed) return memory; // 저장소의 옛 값이 방금 고른 지역을 덮지 않게
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return memory;
  }
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastValue = parseRegionChoice(raw);
  }
  return lastValue;
}

// [8] 바뀔 때 알림 받기(다른 탭 포함)
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

// [9] 지역 고르기·바꾸기. NATIONWIDE = 시트·탐색에서 고른 전국. null이면 저장한 값 지움(홈 기본값으로: '내 주변'·지우기·초기화)
export function setRegion(next: RegionChoice | null) {
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

// [10] 저장값 그대로(전국 포함). 홈은 homeScope(useRegionChoice(), beaches, 위치 상태)로 범위를 정함
export function useRegionChoice(): RegionChoice | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

// [11] 시·도 지역만. 전국은 null(탐색·검색은 null을 전국으로 봄)
// 화면에서: const region = validRegion(useRegion(), beaches);  (validRegion은 region-list.ts)
export function useRegion(): SavedRegion | null {
  return pickedRegion(useRegionChoice());
}
