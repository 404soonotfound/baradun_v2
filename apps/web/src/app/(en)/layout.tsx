import type { Metadata } from "next";
import { SITE_URL } from "@/lib/i18n";
import "../globals.css";

// 영어 루트 레이아웃: /en 아래 모든 주소
export const metadata: Metadata = {
  metadataBase: SITE_URL, // hreflang 절대 주소의 기준
  title: "Baradun Bada", // 임시: 영어 이름·문구는 번역 작업에서 확정 (BRD-48)
  description: "Official marine warnings and sea observations by beach.",
};

export default function EnRootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
