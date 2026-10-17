import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "바라던 바다 — 오늘의 바다수영 판단",
  description:
    "공식 통제 정보와 현재 관측 데이터를 바탕으로 바다수영 판단을 돕습니다.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
