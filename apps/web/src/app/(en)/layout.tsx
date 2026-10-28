import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { RootDocument } from "@/components/root-document";
import { AppShell } from "@/components/shell/app-shell";
import { SITE_URL } from "@/lib/i18n";
import "../globals.css";

// 영어 루트 레이아웃: /en 아래 모든 주소
// 영어 문구는 messages/en.json(BRD-48 검토), 해변·지역 영어 이름은 data/beaches의 en 값을 그대로 씀
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "en", namespace: "meta" });
  return {
    metadataBase: SITE_URL, // hreflang 절대 주소의 기준
    title: { default: t("siteName"), template: `%s · ${t("siteName")}` },
    description: t("description"),
    // 홈 화면에 추가한 iOS 앱을 standalone으로 염(BRD-42). 안전 영역은 app-shell의 standalone: 클래스가 비움
    appleWebApp: { capable: true, title: t("siteName") },
  };
}

export default function EnRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  getTranslations({ locale: "en" });
  return (
    <RootDocument locale="en">
      <AppShell locale="en">{children}</AppShell>
    </RootDocument>
  );
}
