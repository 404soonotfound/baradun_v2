"use client";

import { ChevronLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { type Locale, localizedPath } from "@/lib/i18n";
import { cameFromInApp } from "@/lib/tab-memory";

// 상세의 뒤로 (노션 1장: 진입한 화면으로, 공유 링크로 들어왔으면 HOME)
export function BackButton({ locale }: { locale: Locale }) {
  const router = useRouter();
  const t = useTranslations("nav");

  return (
    <button
      type="button"
      aria-label={t("back")}
      onClick={() =>
        cameFromInApp()
          ? router.back()
          : router.push(localizedPath(locale, "/"))
      }
      className="flex size-touch shrink-0 items-center justify-center rounded-full hover:bg-bg-subtle"
    >
      <ChevronLeft aria-hidden="true" size={24} />
    </button>
  );
}
