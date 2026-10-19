import type { Locale } from "@/lib/i18n";

// 화면 틀의 메뉴 (노션 1장 '이동 규칙'·'PC 흐름', 3장 TabBar·TopNav) (BRD-24)
// 하단 탭(모바일)과 상단 내비(PC)가 같은 목록 사용. 순서 = 화면 순서
export const TABS = [
  { key: "home", path: "/" },
  { key: "explore", path: "/explore/" },
  { key: "favorites", path: "/favorites/" },
  { key: "settings", path: "/settings/" },
] as const;

export type TabKey = (typeof TABS)[number]["key"];

// 언어 접두어("/en")와 끝 "/"를 뗀 주소. 비교 기준
//   "/en/settings/inquiry/" → "/settings/inquiry",  "/" → "/"
export function basePath(pathname: string, locale: Locale): string {
  const noLocale =
    locale === "en" ? pathname.replace(/^\/en(?=\/|$)/, "") : pathname;
  const trimmed = noLocale.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

// 지금 주소가 이 탭에 속하는지 판정. "/en" 접두어와 끝 "/"를 떼고 비교
// 하위 주소도 같은 탭(예: /settings/inquiry/ → 설정 탭)
export function isTabActive(
  pathname: string,
  tabPath: string,
  locale: Locale,
): boolean {
  const strip = (p: string) => basePath(p, locale);
  const current = strip(pathname); // 지금 주소   예: "/en/settings/inquiry/" → "/settings/inquiry"
  const target = strip(tabPath); //   탭 주소     예: "/settings/" → "/settings"

  // 홈 탭: 정확히 "/"일 때만 선택
  // (모든 주소가 "/"로 시작해서, 아래 startsWith로 보면 항상 홈이 선택되는 문제 방지)
  if (target === "/") return current === "/";

  // 그 외 탭: 같은 주소이거나, 그 아래 주소이면 선택
  //   "/settings"          → 설정 ✓ (같은 주소)
  //   "/settings/inquiry"  → 설정 ✓ ("/settings/"로 시작)
  //   "/settingsx"         → 설정 ✗ (끝에 "/"를 붙여 비교해서 이름만 비슷한 주소는 제외)
  return current === target || current.startsWith(`${target}/`);
}

// 지금 주소가 속한 탭. 탭에 속하지 않는 주소(/search/, /spots/…)는 null
export function tabOf(pathname: string, locale: Locale): TabKey | null {
  return (
    TABS.find((tab) => isTabActive(pathname, tab.path, locale))?.key ?? null
  );
}

// 하단 탭을 보여 주는 화면인지 (노션 2장: 상세·시트·문의에서는 숨김)
// 시트는 주소가 없어 여기서 다루지 않음(시트가 화면을 덮음)
export function showsTabBar(pathname: string, locale: Locale): boolean {
  const path = basePath(pathname, locale);
  return !path.startsWith("/spots/") && path !== "/settings/inquiry";
}
