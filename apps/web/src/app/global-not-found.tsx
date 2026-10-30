import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Search } from "lucide-react";
import { RootDocument } from "@/components/root-document";
import { Button } from "@/components/ui/button";
import { HEAD_ICONS } from "@/lib/app-icons";
import { localizedPath, type Locale } from "@/lib/i18n";
import { sharedViewport } from "@/lib/viewport";
import "./globals.css";

// 전역 404 (SYS 404, BRD-38 · 노션 2장 SYS '404(해변 검색하기 / 홈으로)')
// 루트 레이아웃이 언어별로 둘이라 전역 404 파일 하나로 두 언어를 함께 표시(정적 내보내기는 out/404.html 하나)
// 레이아웃을 거치지 않으므로 globals.css·테마 스크립트(RootDocument)·viewport·아이콘을 여기서 직접 넣음
// 노출을 끈 해변의 상세 주소도 이 화면(노션 2장 운영자 화면)
async function bothLocales() {
  return Promise.all([
    getTranslations({ locale: "ko", namespace: "notFound" }),
    getTranslations({ locale: "en", namespace: "notFound" }),
  ]);
}

export async function generateMetadata(): Promise<Metadata> {
  const [ko, en] = await bothLocales();
  return { title: `${ko("title")} · ${en("title")}`, icons: HEAD_ICONS };
}

export const viewport = sharedViewport;

type Messages = Awaited<ReturnType<typeof bothLocales>>[number];

// 한 언어 묶음: 제목 → 이유 → 다음 행동 → 해변 검색하기(주요) · 홈으로
// Figma L14 188:371: 제목 20·굵기 700 → 본문 14.5/21 → 버튼 52 둘(사이 8), 묶음 안 간격 14 (BRD-129)
function Block({
  locale,
  t,
  heading: Heading,
}: {
  locale: Locale;
  t: Messages;
  heading: "h1" | "h2";
}) {
  return (
    <section lang={locale} className="flex flex-col items-center gap-3.5">
      <Heading className="text-title-l font-bold text-text-default">
        {t("title")}
      </Heading>
      <div className="text-[14.5px]/[21px] text-text-body">
        <p>{t("body")}</p>
        <p>{t("next")}</p>
      </div>
      <div className="flex w-full flex-col gap-2">
        <Button asChild className="gap-1.5">
          <Link href={localizedPath(locale, "/search/")}>
            <Search aria-hidden="true" size={16} />
            {t("search")}
          </Link>
        </Button>
        <Button asChild variant="secondary">
          <Link href={localizedPath(locale, "/")}>{t("home")}</Link>
        </Button>
      </div>
    </section>
  );
}

export default async function GlobalNotFound() {
  const [ko, en] = await bothLocales();

  return (
    <RootDocument locale="ko">
      {/* 아이콘 상자 76·모서리 24(브랜드 약한 면 + 브랜드 돋보기 34), 좌우 여백 28 (Figma 188:372).
          아이콘과 첫 묶음 사이는 14(gap-8에서 18을 뺌), 두 언어 묶음 사이는 구분선 */}
      <main className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col justify-center gap-8 px-7 py-10 text-center">
        <span
          aria-hidden="true"
          className="-mb-[18px] flex size-[76px] items-center justify-center self-center rounded-[24px] bg-brand-weak text-brand-default"
        >
          <Search size={34} strokeWidth={2.55} absoluteStrokeWidth />
        </span>
        <Block locale="ko" t={ko} heading="h1" />
        <hr className="border-border-default" />
        <Block locale="en" t={en} heading="h2" />
      </main>
    </RootDocument>
  );
}
