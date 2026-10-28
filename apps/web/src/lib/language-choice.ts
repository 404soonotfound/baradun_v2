import { useSyncExternalStore } from "react";

import { LOCALES, type Locale } from "@/lib/i18n";

// 첫 방문 언어 안내 (디자인 시스템 8절 10/16 결정 · BRD-48)
// 기기 언어로 자동 이동하지 않음. 기기 언어와 주소 언어가 다르면 첫 방문에 안내를 한 번 보여주고, 고른 언어는 기기에 저장
// 고른 언어는 안내를 다시 띄우지 않는 데만 씀(주소가 언어를 정함, 아키텍처 9.1). 서버로 보내지 않음

// [1] 기기 언어 → 지원 언어. 첫 번째 언어만 봄. 지원하지 않는 언어(일본어 등)는 null → 안내 안 함
export function deviceLocale(languages: readonly string[]): Locale | null {
  const first = languages[0]?.toLowerCase();
  if (!first) return null;
  const primary = first.split("-")[0] ?? "";
  return (LOCALES as readonly string[]).includes(primary)
    ? (primary as Locale)
    : null;
}

// [2] 안내할 언어. 이미 골랐거나, 기기 언어를 모르거나, 주소 언어와 같으면 null
export function noticeTarget(
  page: Locale,
  device: Locale | null,
  chosen: Locale | null,
): Locale | null {
  if (chosen !== null || device === null || device === page) return null;
  return device;
}

// [3] 주소에서 언어 접두어를 뺀 한국어 기준 경로: "/en/spots/gangmun/" → "/spots/gangmun/", "/en" → "/"
export function basePath(pathname: string): string {
  if (pathname === "/en") return "/";
  return pathname.startsWith("/en/") ? pathname.slice(3) : pathname;
}

// [4] 기기 저장 (lib/region.ts와 같은 틀). 저장소를 못 쓰면 이번 방문 동안 memory로 유지
const STORAGE_KEY = "baradun:language";
let memory: Locale | null = null;
let writeFailed = false;
const listeners = new Set<() => void>();

function parse(raw: string | null): Locale | null {
  return raw !== null && (LOCALES as readonly string[]).includes(raw)
    ? (raw as Locale)
    : null;
}

function readChoice(): Locale | null {
  if (writeFailed) return memory;
  try {
    return parse(localStorage.getItem(STORAGE_KEY)) ?? memory;
  } catch {
    return memory;
  }
}

function subscribeChoice(onChange: () => void) {
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

export function setLanguageChoice(next: Locale) {
  memory = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    writeFailed = true;
  }
  listeners.forEach((listener) => listener());
}

// [5] 기기 언어: 브라우저 언어 설정이 바뀌면 다시 읽음. 서버 렌더에서는 모름(null)
function readDevice(): Locale | null {
  try {
    return deviceLocale(navigator.languages ?? [navigator.language]);
  } catch {
    return null;
  }
}

function subscribeDevice(onChange: () => void) {
  window.addEventListener("languagechange", onChange);
  return () => window.removeEventListener("languagechange", onChange);
}

// [6] 화면에서: const target = useLanguageNotice(locale); target이 있으면 그 언어로 안내
// 서버 렌더·첫 그리기는 null(안내 없음) → 정적 HTML에 기기 언어가 들어가지 않음
export function useLanguageNotice(page: Locale): Locale | null {
  const device = useSyncExternalStore(subscribeDevice, readDevice, () => null);
  const chosen = useSyncExternalStore(subscribeChoice, readChoice, () => null);
  return noticeTarget(page, device, chosen);
}
