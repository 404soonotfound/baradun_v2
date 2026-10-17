import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";

// 전역 404: 루트 레이아웃이 언어별로 둘이라 한 파일로 두 언어를 함께 표시
// 실제 화면(SYS 404)은 BRD-38
export const metadata: Metadata = {
  title: "페이지를 찾을 수 없어요 · Page not found",
};

export default function GlobalNotFound() {
  return (
    <html lang="ko">
      <body>
        <main>
          <h1>페이지를 찾을 수 없어요</h1>
          <p>
            <Link href="/">홈으로</Link>
          </p>
          <h2 lang="en">Page not found</h2>
          <p lang="en">
            <a href="/en/">Go to home</a>
          </p>
        </main>
      </body>
    </html>
  );
}
