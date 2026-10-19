import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { LOCALES, type Locale } from "@/lib/i18n";

// 문구 키 설정 (BRD-22)
// 주소에 [locale] 구간 없음(경로 그룹 (ko)·(en)). 그래서 각 레이아웃·페이지가
// ("ko" | "en")로 언어를 알려 주고, 여기서는 그 값을 받음
// getTranslations({ locale: "en" })처럼 직접 넘긴 값도 requestLocale로 들어옴.
const DEFAULT_LOCALE: Locale = "ko";

export default getRequestConfig(async ({ locale }) => {
  const resolved = hasLocale(LOCALES, locale) ? locale : DEFAULT_LOCALE;

  return {
    locale: resolved,
    messages: (await import(`../../messages/${resolved}.json`)).default,
    timeZone: "Asia/Seoul",
  };
});
