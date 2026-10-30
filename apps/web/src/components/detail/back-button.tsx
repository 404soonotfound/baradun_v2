"use client";

import { ChevronLeft, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/cn";
import { type Locale, localizedPath } from "@/lib/i18n";
import { cameFromInApp } from "@/lib/tab-memory";

// 상세의 뒤로 (노션 1장: 진입한 화면으로, 공유 링크로 들어왔으면 HOME)
// 데이터 문의(BRD-37)처럼 바로 들어왔을 때 갈 곳이 홈이 아닌 화면은 fallback으로 줌
// close면 ✕ 모양 + '닫기'(데이터 문의 Figma 179:351 닫기 11px). 가는 곳은 뒤로와 같음
export function BackButton({
  locale,
  fallback = "/",
  labelWide = false,
  close = false,
  className,
}: {
  locale: Locale;
  fallback?: string;
  close?: boolean;
  // PC(lg)에서 '‹ 뒤로' 글자 링크 모양으로(상세 Figma 183:785). 모바일은 그대로 44px 아이콘
  labelWide?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const t = useTranslations("nav");

  return (
    <button
      type="button"
      aria-label={close ? t("close") : t("back")}
      onClick={() =>
        cameFromInApp()
          ? router.back()
          : router.push(localizedPath(locale, fallback))
      }
      className={cn(
        "flex size-touch shrink-0 items-center justify-center rounded-full hover:bg-bg-subtle",
        labelWide &&
          "lg:h-9 lg:w-auto lg:gap-1 lg:rounded-none lg:text-body-s lg:text-text-body lg:hover:bg-transparent lg:hover:underline",
        className,
      )}
    >
      {close ? (
        <X
          aria-hidden="true"
          size={11}
          strokeWidth={1.67}
          absoluteStrokeWidth
        />
      ) : (
        <ChevronLeft
          aria-hidden="true"
          size={labelWide ? 22 : 24}
          className={cn(labelWide && "lg:size-[15px]")}
        />
      )}
      {labelWide && <span className="hidden lg:inline">{t("back")}</span>}
    </button>
  );
}
