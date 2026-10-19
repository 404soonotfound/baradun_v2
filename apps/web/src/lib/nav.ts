import type { Locale } from "@/lib/i18n";

// 모바일 메뉴와 상단 PC 메뉴 통일
export const TABS = [
  { key: "home", path: "/" },
  { key: "explore", path: "/explore/" },
  { key: "favorites", path: "/favorites/" },
  { key: "settings", path: "/settings/" },
] as const;

export type TabKey = (typeof TABS)[number]["key"];

// 현재 주소가 탭에 속하는지 "/en" 접두어와 "/" 빼고 비교
export function isTabActive(
  pathname: string,
  tabPath: string,
  locale: Locale,
): boolean {
  const strip = (p: string) => {
    const noLocale = locale === "en" ? p.replace(/^\/en(?=\/|$)/, "") : p;
    const trimmed = noLocale.replace(/\/+$/, "");
    return trimmed === "" ? "/" : trimmed;
  };

  const current = strip(pathname);
  const target = strip(tabPath);
  // 홈은 모든 경로의 접두어라 정확히 일치할 때만 활성
  if (target === "/") {
    return current === "/";
  }
  // 하위 경로도 같은 탭으로 보되, "/explore"가 "/explorer"에 걸리지 않게 "/"까지 비교
  return current === target || current.startsWith(`${target}/`);
}
