import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { RootDocument } from "@/components/root-document";
import { SITE_URL } from "@/lib/i18n";
import "../globals.css";

// 영어 루트 레이아웃: /en 아래 모든 주소
// 영어 이름·문구는 번역 작업에서 확정해요 (BRD-48). 지금 en.json은 초안이에요.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "en", namespace: "meta" });
  return {
    metadataBase: SITE_URL, // hreflang 절대 주소의 기준
    title: t("siteName"),
    description: t("description"),
  };
}

export default function EnRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  getTranslations({ locale: "en" });
  return <RootDocument locale="en">{children}</RootDocument>;
}
