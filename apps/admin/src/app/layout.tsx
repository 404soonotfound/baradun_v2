import "@fontsource-variable/noto-sans-kr";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeSync } from "@/components/theme-sync";
import { AuthProvider } from "@/lib/auth/provider";
import { messages } from "@/lib/messages";
import { THEME_INIT_SCRIPT } from "@/lib/theme-init";
import "./globals.css";

// 모든 페이지 검색 노출 차단(아키텍처 18.7). robots.txt·응답 헤더(X-Robots-Tag)와 함께 막음
export const metadata: Metadata = {
  title: messages.meta.title,
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <body>
        {/* body 맨 앞의 인라인 스크립트는 첫 그리기 전에 실행됨. Trusted Types 정책이 <head> 맨 앞이라 <head>에 두지 않음 */}
        <script>{THEME_INIT_SCRIPT}</script>
        <ThemeSync />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
