import { useSyncExternalStore } from "react";

import type { Locale } from "@/lib/i18n";
import type { TabKey } from "@/lib/nav";

// 하단 탭의 "마지막 상태" (노션 1장 이동 규칙: 각 탭의 마지막 상태로) (BRD-24)
// 이 브라우저 탭 안에서만 기억(sessionStorage). 앱을 새로 열면 처음부터 시작
//   urls:  탭마다 마지막으로 보던 주소 (예: explore → "/search/?q=경포")
//   owner: 지금 화면이 속한 탭. 상세·검색처럼 탭이 아닌 화면은 들어오기 전 탭 소속
type Memory = { urls: Partial<Record<TabKey, string>>; owner?: TabKey };

const KEY = "baradun:tabs";
const SCROLL_KEY = "baradun:scroll";
const RESTORE_KEY = "baradun:restore";
const IN_APP_KEY = "baradun:in-app";
const EMPTY: Memory = { urls: {} };

function load(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // 저장 실패 시 기억 없이 동작(각 탭 첫 화면으로)
  }
}
function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = load(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

// useSyncExternalStore는 값이 그대로면 같은 객체가 필요해서, 문자열이 같으면 이전 객체 재사용
let cachedRaw: string | null = null;
let cached: Memory = EMPTY;
function getSnapshot(): Memory {
  const raw = load(KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = loadJson<Memory>(KEY, EMPTY);
  }
  return cached;
}

const listeners = new Set<() => void>();
function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}
function update(change: (memory: Memory) => Memory) {
  save(KEY, JSON.stringify(change(getSnapshot())));
  listeners.forEach((listener) => listener());
}

export function useTabMemory(): Memory {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}

// 그 탭의 마지막 주소. 다른 언어로 보던 주소는 제외(한국어 화면에서 /en/…으로 가는 것 방지)
export function lastUrlOf(
  memory: Memory,
  tab: TabKey,
  locale: Locale,
): string | undefined {
  const url = memory.urls[tab];
  if (!url?.startsWith("/")) return undefined;
  const isEnglish = url === "/en" || url.startsWith("/en/");
  return (locale === "en") === isEnglish ? url : undefined;
}

export function rememberTabUrl(tab: TabKey, url: string) {
  update((memory) => ({ ...memory, urls: { ...memory.urls, [tab]: url } }));
}

export function rememberOwnerTab(tab: TabKey) {
  if (getSnapshot().owner !== tab)
    update((memory) => ({ ...memory, owner: tab }));
}

// 스크롤 위치: 탭을 떠날 때 저장하고, 탭으로 돌아올 때 그 자리로
export function rememberScroll(url: string, y: number) {
  const map = loadJson<Record<string, number>>(SCROLL_KEY, {});
  map[url] = Math.round(y);
  save(SCROLL_KEY, JSON.stringify(map));
}
export function requestScrollRestore(url: string) {
  save(RESTORE_KEY, url);
}
// 탭을 눌러 이 주소로 왔으면 돌아갈 위치(처음이면 0), 아니면 null
export function takeScrollRestore(url: string): number | null {
  const wanted = load(RESTORE_KEY);
  if (wanted === null) return null;
  save(RESTORE_KEY, null);
  if (wanted !== url) return null;
  return loadJson<Record<string, number>>(SCROLL_KEY, {})[url] ?? 0;
}

// 기기 데이터 초기화(BRD-36): 탭별 마지막 주소(검색어가 든 주소 포함)와 스크롤 위치를 지움
export function clearTabMemory() {
  save(KEY, null);
  save(SCROLL_KEY, null);
  save(RESTORE_KEY, null);
  listeners.forEach((listener) => listener());
}

// 앱 안에서 한 번이라도 이동했는지 여부 (상세의 뒤로: 앱 안에서 왔으면 이전 화면, 공유 링크로 바로 왔으면 홈)
export function markInAppNavigation() {
  save(IN_APP_KEY, "1");
}
export function cameFromInApp(): boolean {
  return load(IN_APP_KEY) === "1";
}
