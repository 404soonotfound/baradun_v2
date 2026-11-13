import { useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY } from "./theme-init";

// 운영자 화면 테마 (#459): 시스템·라이트·다크, 기본은 시스템(기기 설정 따름)
// 이 브라우저에만 저장함. 로그아웃·세션 만료 때도 지우지 않음
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

let memory: Theme = "system";
let writeFailed = false;
const listeners = new Set<() => void>();

export function parseTheme(value: unknown): Theme {
  return value === "light" || value === "dark" ? value : "system";
}

export function readStoredTheme(
  storage?: Pick<Storage, "getItem"> | null,
): Theme {
  if (!storage) return "system";
  try {
    return parseTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function writeStoredTheme(
  theme: Theme,
  storage?: Pick<Storage, "setItem" | "removeItem"> | null,
): boolean {
  if (!storage) return false;
  try {
    if (theme === "system") storage.removeItem(THEME_STORAGE_KEY);
    else storage.setItem(THEME_STORAGE_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

function read(): Theme {
  if (writeFailed) return memory;
  try {
    return readStoredTheme(window.localStorage);
  } catch {
    return memory;
  }
}

function applyTheme(theme: Theme) {
  const html = document.documentElement;
  if (theme === "system") html.removeAttribute("data-theme");
  else html.setAttribute("data-theme", theme);
}

// 다른 탭에서 바꾼 것도 따라감
function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    writeFailed = false;
    const next = read();
    memory = next;
    applyTheme(next);
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function setTheme(theme: Theme) {
  memory = theme;
  try {
    writeFailed = !writeStoredTheme(theme, window.localStorage);
  } catch {
    writeFailed = true;
  }
  applyTheme(theme);
  listeners.forEach((listener) => listener());
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "system");
}
