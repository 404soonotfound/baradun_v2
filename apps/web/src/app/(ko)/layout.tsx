import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { RootDocument } from "@/components/root-document";
import { siteUrl } from "@/lib/site-url";
import { AppShell } from "@/components/shell/app-shell";
import { siteShareMetadata } from "@/lib/share-meta";
import { sharedViewport } from "@/lib/viewport";

import "../globals.css";

// 한국어 루트 레이아웃: 접두어 없는 모든 주소 (/, /spots/…, /search …)
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: "ko", namespace: "meta" });
  const share = await getTranslations({ locale: "ko", namespace: "share" });
  return {
    metadataBase: siteUrl(), // hreflang·og:image 절대 주소의 기준. 값이 없거나 틀리면 빌드 실패
    // 공유 미리보기 기본값: 모든 페이지가 자체 공통 일러스트(BRD-105). 상세는 이름·지역을 더해 덮어씀
    ...siteShareMetadata("ko", {
      siteName: t("siteName"),
      illustrationAlt: share("ogIllustration"),
    }),
    title: { default: t("siteName"), template: `%s · ${t("siteName")}` }, //하위 페이지 제목은 "탐색 · 바라던 바다"처럼
    description: t("description"),
    // 홈 화면에 추가한 iOS 앱을 standalone으로 염(BRD-42). 안전 영역은 app-shell의 standalone: 클래스가 비움
    appleWebApp: { capable: true, title: t("siteName") },
  };
}

// Next가 이 이름을 보고 <meta name="viewport">·theme-color를 만들어줌
export const viewport = sharedViewport;

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
