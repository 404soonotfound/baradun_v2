"use client";

import { ChevronLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { type Locale, localizedPath } from "@/lib/i18n";
import { cameFromInApp } from "@/lib/tab-memory";

// 상세의 뒤로 (노션 1장: 진입한 화면으로, 공유 링크로 들어왔으면 HOME)
// 데이터 문의(BRD-37)처럼 바로 들어왔을 때 갈 곳이 홈이 아닌 화면은 fallback으로 줌
export function BackButton({
  locale,
  fallback = "/",
}: {
  locale: Locale;
  fallback?: string;
}) {
  const router = useRouter();
  const t = useTranslations("nav");

  return (
    <button
      type="button"
      aria-label={t("back")}
      onClick={() =>
        cameFromInApp()
          ? router.back()
          : router.push(localizedPath(locale, fallback))
      }
      className="flex size-touch shrink-0 items-center justify-center rounded-full hover:bg-bg-subtle"
    >
      <ChevronLeft aria-hidden="true" size={24} />
    </button>
  );
}
