import { useSyncExternalStore } from "react";

import type { BeachSummary, RegionPart } from "@/lib/beach-summary";

// 기본 지역 (BRD-11 결정: 위치 권한이 없을 때 홈에서 고르는 지역, 기기 저장) (BRD-26·27)
// 칩은 출시된 해변이 있는 시·도만. 고른 뒤 지역 선택 창에서 시·군까지 고름

// [2] 시·도 지리 순서. as const = 글자를 그 값 그대로(예: "강원") 타입으로 고정하고 읽기 전용으로 만듦
export const SIDO_ORDER = [
  "강원",
  "경북",
  "울산", // 동해안 위→아래
  "부산",
  "경남",
  "전남", // 남해 동→서
  "전북",
  "충남",
  "인천", // 서해 남→북(해안선을 이어서. 방향은 확인 필요)
  "제주",
] as const;

// [3] 저장하는 값. sigungu는 시·군을 아직 안 골랐으면 null. 둘 다 한국어 원본 이름(key)
export type SavedRegion = { sido: string; sigungu: string | null };

// [4] 해변 목록에서 칩으로 보여줄 시·도 목록. 해변이 있는 시·도만, SIDO_ORDER 순
// 순서표에 없는 시·도(새로 생긴 이름 등)는 숨기지 않고 맨 뒤에 붙임
export function regionChips(beaches: readonly BeachSummary[]): RegionPart[] {
  // Map = 키 → 값 모음. 같은 시·도는 하나만 남음
  const found = new Map<string, RegionPart>();
  for (const beach of beaches) found.set(beach.sido.key, beach.sido);
  // indexOf가 못 찾으면 -1 → 맨 뒤 순번
  const rank = (key: string) => {
    const index = (SIDO_ORDER as readonly string[]).indexOf(key);
    return index === -1 ? SIDO_ORDER.length : index;
  };
  // [...found.values()] = Map의 값들을 배열로. sort는 앨의 순번이 작은 쪽이 앞
  return [...found.values()].sort((a, b) => rank(a.key) - rank(b.key));
}

// [5] 저장된 지역이 지금 해변 목록에 없으면(해변이 빠진 경우 등) 고르지 않은 것으로 봄
// 시·군만 없어졌으면 시·도는 유지
export function validRegion(
  saved: SavedRegion | null,
  beaches: readonly BeachSummary[],
): SavedRegion | null {
  if (saved === null) return null;
  // some = 하나라도 조건에 맞으면 true
  if (!beaches.some((beach) => beach.sido.key === saved.sido)) return null;
  if (saved.sigungu === null) return saved;
  const hasSigungu = beaches.some(
    (beach) =>
      beach.sido.key === saved.sido && beach.sigungu.key === saved.sigungu,
  );
  return hasSigungu ? saved : { sido: saved.sido, sigungu: null };
}

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

// [11] 화면에서: const region = validRegion(useRegion(), beaches);
export function useRegion(): SavedRegion | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
