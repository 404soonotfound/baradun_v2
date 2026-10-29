import { useSyncExternalStore } from "react";

import { ACTIVITIES } from "@/lib/activity";
import { DEVICE_KEYS } from "@/lib/device-keys";

// 최근 본 해변을 본 시각과 그때 고른 활동 (BRD-129 · #105 결정 4, Figma 171:454 '어제 18:40에 봤어요')
// 이 기기에만 저장하고 서버로 보내지 않음. 최근 본 목록(id 배열, baradun:recent)은 그대로 두고 따로 둠
// → 예전 기록(시각 없음)은 그대로 읽히고, 시각 줄만 빠짐

type TileActivity = (typeof ACTIVITIES)[number];
export type Visit = { at: string; activity: TileActivity | null };
export type Visits = Readonly<Record<string, Visit>>;

const KEY = DEVICE_KEYS.recentVisits;
const EMPTY: Visits = {};
// 최근 본 목록 상한(favorites.ts RECENT_MAX)보다 넉넉히. 넘으면 오래된 것부터 버림
const MAX = 40;

// [1] 저장 글자 → 기록. 모양이 틀린 칸은 버림(읽을 수 없는 시각을 '본 시각'으로 쓰지 않음)
export function parseVisits(raw: string | null): Visits {
  if (raw === null) return EMPTY;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return EMPTY;
  const out: Record<string, Visit> = {};
  for (const [id, item] of Object.entries(value)) {
    if (typeof item !== "object" || item === null) continue;
    const { at, activity } = item as Record<string, unknown>;
    if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) continue;
    out[id] = {
      at,
      activity: (ACTIVITIES as readonly unknown[]).includes(activity)
        ? (activity as TileActivity)
        : null,
    };
  }
  return out;
}

// [2] 한 곳 기록을 더한 새 기록. 오래된 것부터 MAX를 넘는 만큼 버림
export function withVisit(visits: Visits, id: string, visit: Visit): Visits {
  const entries = Object.entries({ ...visits, [id]: visit }).sort(
    ([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at),
  );
  return Object.fromEntries(entries.slice(0, MAX));
}

// [3] 저장소(못 쓰는 환경이면 이번 방문 동안 memory)
let memory: Visits = EMPTY;
let lastRaw: string | null = null;
let lastValue: Visits = EMPTY;
let writeFailed = false;
const listeners = new Set<() => void>();

function read(): Visits {
  if (writeFailed) return memory;
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return memory;
  }
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastValue = parseVisits(raw);
  }
  return lastValue;
}

function write(next: Visits) {
  memory = next;
  try {
    if (Object.keys(next).length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    writeFailed = true;
  }
  listeners.forEach((listener) => listener());
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useRecentVisits(): Visits {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

// 상세에 들어갈 때(최근 본에 넣을 때 같이). at은 기기 시각(ISO, UTC)
export function recordVisit(id: string, visit: Visit) {
  write(withVisit(read(), id, visit));
}

// ✕로 한 곳 지우기. 되돌리기용으로 지우기 전 기록을 다시 쓰는 함수를 돌려줌
export function removeVisit(id: string): () => void {
  const before = read();
  if (!(id in before)) return () => {};
  const next = { ...before };
  delete next[id];
  write(next);
  return () => write(before);
}

// 최근 본 전체 지우기·기기 데이터 초기화. 되돌리기용 함수를 돌려줌
export function clearVisits(): () => void {
  const before = read();
  write(EMPTY);
  return () => write(before);
}

// [4] 본 시각을 한국 시각(KST, UTC+9 고정, 일광 절약 없음)으로 나눔: 오늘 · 어제 · 그 전(월·일)
// 읽을 수 없거나 지금보다 2분 넘게 미래(기기 시계가 틀림)면 null → 시각 줄을 뺌
const KST_OFFSET_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const FUTURE_TOLERANCE_MS = 2 * 60_000;

export type ViewedTime = {
  day: "today" | "yesterday" | "earlier";
  time: string; // "18:40"
  month: number;
  date: number;
};

export function viewedTime(at: string, nowMs: number): ViewedTime | null {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms) || !Number.isFinite(nowMs)) return null;
  if (ms > nowMs + FUTURE_TOLERANCE_MS) return null;
  const kst = new Date(ms + KST_OFFSET_MS);
  const days =
    Math.floor((nowMs + KST_OFFSET_MS) / DAY_MS) -
    Math.floor((ms + KST_OFFSET_MS) / DAY_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    day: days <= 0 ? "today" : days === 1 ? "yesterday" : "earlier",
    time: `${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}`,
    month: kst.getUTCMonth() + 1,
    date: kst.getUTCDate(),
  };
}
