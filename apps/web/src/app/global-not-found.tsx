import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SearchX } from "lucide-react";
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
    <section lang={locale} className="flex flex-col items-center gap-3">
      <Heading className="text-title-xl text-text-default">
        {t("title")}
      </Heading>
      <div className="flex flex-col gap-1">
        <p className="text-body-m text-text-body">{t("body")}</p>
        <p className="text-body-m text-text-body">{t("next")}</p>
      </div>
      <div className="flex w-full flex-col gap-2 pt-2">
        <Button asChild>
          <Link href={localizedPath(locale, "/search/")}>{t("search")}</Link>
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
      <main className="mx-auto flex min-h-dvh w-full max-w-[480px] flex-col justify-center gap-8 px-gutter py-10 text-center">
        <span
          aria-hidden="true"
          className="flex size-[60px] items-center justify-center self-center rounded-full bg-bg-subtle text-text-muted"
        >
          <SearchX size={26} />
        </span>
        <Block locale="ko" t={ko} heading="h1" />
        <hr className="border-border-default" />
        <Block locale="en" t={en} heading="h2" />
      </main>
    </RootDocument>
  );
}
