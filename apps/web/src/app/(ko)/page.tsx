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

// 홈 (임시): 실제 화면은 BRD-26
export const metadata: Metadata = {
  alternates: alternatesFor("ko", "/"),
};

export default async function Home() {
  // 페이지와 레이아웃은 따로 그려질 수 있어서 페이지마다 언어를 알려 줌.
  const t = await getTranslations({ locale: "ko" });

  return (
    <>
      {/* 해변 목록은 빌드 때 서버에서 만들어 props로 넘김. 상태는 브라우저가 따로 받음(G4) */}
      <HomeScreen locale="ko" beaches={listBeachSummaries("ko")} />
      {/* 지금 언어를 뺀 나머지 언어로 가는 링크. 언어가 늘어도 이 코드는 그대로임. */}
      <nav className="mt-6" aria-label={t("common.languages")}>
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
    </>
  );
}
