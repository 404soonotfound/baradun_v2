import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  LOCALES,
  LOCALE_NAMES,
  alternatesFor,
  localizedPath,
} from "@/lib/i18n";
import { ActivityTiles } from "@/components/activity-tiles";

// Home (temporary): real screen in BRD-26
export const metadata: Metadata = {
  alternates: alternatesFor("en", "/"),
};

export default async function HomeEn() {
  // 언어를 직접 넘김. 빠뜨리면 한국어 문구가 나옴.
  const t = await getTranslations({ locale: "en" });

  return (
    <>
      <h1 className="text-title-xl">{t("meta.siteName")}</h1>
      <p className="mt-2 text-text-body">{t("home.preparing")}</p>
      <div className="mt-6">
        <ActivityTiles />
      </div>
      {/* 지금 언어를 뺀 나머지 언어로 가는 링크. 언어가 늘어도 이 코드는 그대로임. */}
      <nav className="mt-6" aria-label={t("common.languages")}>
        {LOCALES.filter((locale) => locale !== "en").map((locale) => (
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
    </>
  );
}
