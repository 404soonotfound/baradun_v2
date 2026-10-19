import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  LOCALES,
  LOCALE_NAMES,
  alternatesFor,
  localizedPath,
} from "@/lib/i18n";

// 홈 (임시): 실제 화면은 BRD-26
export const metadata: Metadata = {
  alternates: alternatesFor("ko", "/"),
};

export default async function Home() {
  // 페이지와 레이아웃은 따로 그려질 수 있어서 페이지마다 언어를 알려 줘요.
  const t = await getTranslations({ locale: "ko" });

  return (
    <main>
      <h1>{t("meta.siteName")}</h1>
      <p>{t("home.preparing")}</p>
      {/* 지금 언어를 뺀 나머지 언어로 가는 링크. 언어가 늘어도 이 코드는 그대로예요. */}
      <nav aria-label={t("common.languages")}>
        {LOCALES.filter((locale) => locale !== "ko").map((locale) => (
          <Link
            key={locale}
            href={localizedPath(locale, "/")}
            hrefLang={locale}
            lang={locale}
          >
            {LOCALE_NAMES[locale]}
          </Link>
        ))}
      </nav>
    </main>
  );
}
