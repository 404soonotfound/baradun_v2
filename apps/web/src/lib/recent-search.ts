import { useSyncExternalStore } from "react";

// 최근 검색 (BRD-31 · 노션 2장 SRCH '최근 검색 최대 10개', 결정 기록 10장)
// 기기 저장(localStorage), 서버로 보내지 않음. 개별 삭제·전체 지우기·기기 데이터 초기화로 지움
// 항목: 검색어 + (결과를 눌렀다면) 그 해변 id. 보여 줄 때 노출을 끈 해변의 항목은 뺌(기기 기록은 지우지 않음)

export const RECENT_MAX = 10;
export const QUERY_MAX_LENGTH = 50;
const STORAGE_KEY = "baradun:recent-search";

export type RecentSearch = { q: string; id: string | null };
const EMPTY: readonly RecentSearch[] = [];

// 같은 검색어(공백·대소문자 무시)는 하나로. 맨 앞에 넣고 max를 넘으면 오래된 것부터 버림
export function addRecent(
  list: readonly RecentSearch[],
  entry: RecentSearch,
  max: number = RECENT_MAX,
): RecentSearch[] {
  const q = entry.q.trim().slice(0, QUERY_MAX_LENGTH);
  if (q === "") return [...list];
  const key = q.replace(/\s+/g, "").toLowerCase();
  const rest = list.filter(
    (item) => item.q.replace(/\s+/g, "").toLowerCase() !== key,
  );
  return [{ q, id: entry.id }, ...rest].slice(0, max);
}

// 저장 글자 → 목록. 깨졌거나 모양이 다른 항목은 건너뜀(화면을 멈추지 않음)
export function parseRecent(raw: string | null): readonly RecentSearch[] {
  if (raw === null) return EMPTY;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return EMPTY;
    return value
      .flatMap((item): RecentSearch[] => {
        if (typeof item !== "object" || item === null) return [];
        const { q, id } = item as Record<string, unknown>;
        if (typeof q !== "string" || q.trim() === "") return [];
        return [{ q, id: typeof id === "string" ? id : null }];
      })
      .slice(0, RECENT_MAX);
  } catch {
    return EMPTY;
  }
}

// 보여 줄 항목: 해변 id가 있는 항목은 그 해변이 지금 보이는 해변일 때만(노출을 끈 해변은 뺌)
export function visibleRecent(
  list: readonly RecentSearch[],
  visibleIds: ReadonlySet<string>,
): RecentSearch[] {
  return list.filter((item) => item.id === null || visibleIds.has(item.id));
}

// ── 기기 저장 (lib/device-list.ts와 같은 틀: 못 쓰면 이번 방문 동안 메모리) ──
let memory: readonly RecentSearch[] = EMPTY;
let lastRaw: string | null = null;
let lastValue: readonly RecentSearch[] = EMPTY;
let writeFailed = false;
const listeners = new Set<() => void>();

function read(): readonly RecentSearch[] {
  if (writeFailed) return memory;
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return memory;
  }
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastValue = parseRecent(raw);
  }
  return lastValue;
}

function write(next: readonly RecentSearch[]) {
  memory = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    writeFailed = true;
  }
  listeners.forEach((listener) => listener());
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

export function saveRecentSearch(entry: RecentSearch) {
  write(addRecent(read(), entry));
}

export function removeRecentSearch(q: string) {
  write(read().filter((item) => item.q !== q));
}

export function clearRecentSearches() {
  write(EMPTY);
}

export function useRecentSearches(): readonly RecentSearch[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}
