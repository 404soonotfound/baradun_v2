import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { RootDocument } from "@/components/root-document";
import { AppShell } from "@/components/shell/app-shell";
import { HEAD_ICONS } from "@/lib/app-icons";
import { siteShareMetadata } from "@/lib/share-meta";
import { siteUrl } from "@/lib/site-url";
import { sharedViewport } from "@/lib/viewport";
import "../globals.css";

// 영어 루트 레이아웃: /en 아래 모든 주소
// 영어 문구는 messages/en.json(BRD-48 검토), 해변·지역 영어 이름은 data/beaches의 en 값을 그대로 씀
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "en", namespace: "meta" });
  const share = await getTranslations({ locale: "en", namespace: "share" });
  return {
    metadataBase: siteUrl(), // hreflang·og:image 절대 주소의 기준. 값이 없거나 틀리면 빌드 실패
    // 공유 미리보기 기본값: 모든 페이지가 자체 공통 일러스트(BRD-105). 상세는 이름·지역을 더해 덮어씀
    ...siteShareMetadata("en", {
      siteName: t("siteName"),
      illustrationAlt: share("ogIllustration"),
    }),
    title: { default: t("siteName"), template: `%s · ${t("siteName")}` },
    description: t("description"),
    // 홈 화면에 추가한 iOS 앱을 standalone으로 염(BRD-42). 안전 영역은 app-shell의 standalone: 클래스가 비움
    appleWebApp: { capable: true, title: t("siteName") },
    icons: HEAD_ICONS, // favicon·Apple touch 아이콘(BRD-106)
  };
}

// 한국어 레이아웃과 같은 viewport(viewport-fit=cover·theme-color)
export const viewport = sharedViewport;

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
