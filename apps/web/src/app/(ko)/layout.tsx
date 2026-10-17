import type { Metadata } from "next";
import { SITE_URL } from "@/lib/i18n";
import "../globals.css";

// 한국어 루트 레이아웃: 접두어 없는 모든 주소 (/, /spots/…, /search …)
export const metadata: Metadata = {
  metadataBase: SITE_URL, // hreflang 절대 주소의 기준
  title: "바라던 바다", // 임시: 문구 키로 옮길 예정 (BRD-22)
  description: "공식 특보와 해양 관측 정보를 해변별로 보여줘요.",
};

export default function KoRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
