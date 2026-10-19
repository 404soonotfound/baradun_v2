import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { RootDocument } from "@/components/root-document";
import { SITE_URL } from "@/lib/i18n";
import { AppShell } from "@/components/shell/app-shell";

import "../globals.css";

// 한국어 루트 레이아웃: 접두어 없는 모든 주소 (/, /spots/…, /search …)
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "ko", namespace: "meta" });
  return {
    metadataBase: SITE_URL, // hreflang 절대 주소의 기준
    title: { default: t("siteName"), template: `%s · ${t("siteName")}` }, //하위 페이지 제목은 "탐색 · 바라던 바다"처럼
    description: t("description"),
  };
}

export default function KoRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RootDocument locale="ko">
      <AppShell locale="ko">{children}</AppShell>
    </RootDocument>
  );
}
