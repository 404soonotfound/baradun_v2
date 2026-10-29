import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  LOCALES,
  LOCALE_NAMES,
  alternatesFor,
  localizedPath,
} from "@/lib/i18n";
import { HomeScreen } from "@/components/home/home-screen";
import { listBeachSummaries } from "@/lib/beaches";
import { hasDevSampleSnapshot } from "@/lib/dev-sample";
// Home (BRD-26)
export const metadata: Metadata = {
  alternates: alternatesFor("en", "/"),
};

export default async function HomeEn() {
  // 언어를 직접 넘김. 빠뜨리면 한국어 문구가 나옴.
  const t = await getTranslations({ locale: "en" });

  return (
    <>
      {/* 해변 목록은 빌드 때 서버에서 만들어 props로 넘김. 상태는 브라우저가 따로 받음(G4) */}
      <HomeScreen
        locale="en"
        beaches={listBeachSummaries("en")}
        sampleSnapshot={hasDevSampleSnapshot()}
      />
      {/* 지금 언어를 뺀 나머지 언어로 가는 링크. 언어가 늘어도 이 코드는 그대로임. */}
      {/* PC는 홈 본문 선(64px)에 맞춤(본문 여백 40 + 24, home-screen과 같음) */}
      <nav className="mt-6 lg:px-6" aria-label={t("common.languages")}>
        {LOCALES.filter((locale) => locale !== "en").map((locale) => (
          <Link
            key={locale}
            href={localizedPath(locale, "/")}
            hrefLang={locale}
            lang={locale}
            // 글자만 있는 링크라 누르는 영역을 44px로(BRD-39)
            className="inline-flex min-h-touch min-w-touch items-center"
          >
            {LOCALE_NAMES[locale]}
          </Link>
        ))}
      </nav>
    </>
  );
}
