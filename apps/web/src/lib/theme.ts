import { useSyncExternalStore } from "react";

import { THEME_STORAGE_KEY } from "@/lib/display-init";

// 화면 테마 (노션 4장: 시스템·라이트·다크, 기본은 시스템, 그리기 전에 결정)
// 고른 값은 이 기기에만 저장함. 설정 화면(설정 /settings, BRD-36)에서 바꿈.
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
// 그리기 전에 붙이는 스크립트와 저장 키는 lib/display-init.ts(서버 부품도 읽음)

// ── 설정 화면용 저장소 (lib/explore-view.ts와 같은 틀) ──
let memory: Theme = "system"; // 저장소를 못 쓰는 환경 대비
let writeFailed = false; // 쓰기가 실패한 뒤에는 memory를 읽음(옛 값이 방금 고른 값을 덮지 않게)
const listeners = new Set<() => void>();

function isTheme(value: unknown): value is Theme {
  return (THEMES as readonly unknown[]).includes(value);
}

function read(): Theme {
  if (writeFailed) return memory;
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    return memory;
  }
}

// 다른 탭에서 바꾼 것도 따라감(그 탭의 화면 색도 바꿈)
function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    applyTheme(read());
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

// <html data-theme> 갱신. 시스템이면 속성을 지움(토큰 CSS가 기기 설정을 따름)
function applyTheme(theme: Theme) {
  const html = document.documentElement;
  if (theme === "system") html.removeAttribute("data-theme");
  else html.setAttribute("data-theme", theme);
}

export function setTheme(theme: Theme) {
  memory = theme;
  try {
    if (theme === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, theme);
    writeFailed = false;
  } catch {
    writeFailed = true; // 이번 방문 동안은 memory 값
  }
  applyTheme(theme);
  listeners.forEach((listener) => listener());
}

// 서버(정적 HTML)는 저장 값을 몰라 시스템, 브라우저에서는 저장된 값
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "system");
}
