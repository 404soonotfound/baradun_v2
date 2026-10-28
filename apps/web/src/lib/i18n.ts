// 언어 주소 도우미 (아키텍처 9.1: 한국어는 접두어 없음, 영어는 /en)
import type { Metadata } from "next";

export const LOCALES = ["ko", "en"] as const;
export type Locale = (typeof LOCALES)[number];

// 언어 이름은 그 언어로 씀(한국어 화면에서도 "English"). 번역하지 않는 값이라 문구 키가 아니라 여기 둠.
// 언어를 추가할 때: LOCALES·LOCALE_NAMES에 한 줄씩, messages/{언어}.json, 경로 그룹 (ja)/ja 같은 레이아웃
export const LOCALE_NAMES: Record<Locale, string> = {
  ko: "한국어",
  en: "English",
};

// 언어별 경로: localizedPath("en", "/spots/gyeongpo/") → "/en/spots/gyeongpo/"
export function localizedPath(locale: Locale, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return locale === "ko" ? clean : `/en${clean}`;
}

// 같은 페이지의 두 언어 주소를 서로 연결 (검색 엔진용 hreflang)
// path는 한국어 기준 경로 (예: "/", "/spots/gyeongpo/")
export function alternatesFor(
  locale: Locale,
  path: string,
): Metadata["alternates"] {
  return {
    canonical: localizedPath(locale, path),
    languages: {
      ko: localizedPath("ko", path),
      en: localizedPath("en", path),
      "x-default": localizedPath("ko", path), // 언어를 모를 때는 한국어
    },
  };
}
