import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { RootDocument } from "@/components/root-document";
import { SITE_URL } from "@/lib/i18n";
import "../globals.css";

// 한국어 루트 레이아웃: 접두어 없는 모든 주소 (/, /spots/…, /search …)
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "ko", namespace: "meta" });
  return {
    metadataBase: SITE_URL, // hreflang 절대 주소의 기준
    title: t("siteName"),
    description: t("description"),
  };
}

export default function KoRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  getTranslations({ locale: "ko" });
  return <RootDocument locale="ko">{children}</RootDocument>;
}
