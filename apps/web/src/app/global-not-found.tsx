import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { RootDocument } from "@/components/root-document";
import "./globals.css";

// 전역 404: 루트 레이아웃이 언어별로 둘이라 한 파일로 두 언어를 함께 표시
// 실제 화면(SYS 404)은 BRD-38
async function bothLocales() {
  return Promise.all([
    getTranslations({ locale: "ko", namespace: "notFound" }),
    getTranslations({ locale: "en", namespace: "notFound" }),
  ]);
}

export async function generateMetadata(): Promise<Metadata> {
  const [ko, en] = await bothLocales();
  return { title: `${ko("title")} · ${en("title")}` };
}

export default async function GlobalNotFound() {
  const [ko, en] = await bothLocales();

  return (
    <RootDocument locale="ko">
      <main>
        <h1>{ko("title")}</h1>
        <p>
          <Link href="/">{ko("home")}</Link>
        </p>
        <h2 lang="en">{en("title")}</h2>
        <p lang="en">
          <a href="/en/">{en("home")}</a>
        </p>
      </main>
    </RootDocument>
  );
}
