import type { Metadata } from "next";
import type { ReactNode } from "react";
import { messages } from "@/lib/messages";

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
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
