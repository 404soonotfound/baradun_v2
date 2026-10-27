import { ChevronRight, Info } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { localizedPath, type Locale } from "@/lib/i18n";

// '무엇을 확인해서 보여주나요?' → 안전·데이터 안내 (노션 2장 HOME 10 · 3장 GuideLink)
export function GuideLink({ locale }: { locale: Locale }) {
  const t = useTranslations("home.guide");
  return (
    <Link
      href={localizedPath(locale, "/guide/")}
      className="flex min-h-touch items-center gap-3 rounded-card bg-brand-weak px-3.5 py-[13px]"
    >
      <span
        aria-hidden="true"
        className="flex size-[34px] shrink-0 items-center justify-center rounded-icon bg-bg-surface text-brand-default"
      >
        <Info size={17} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body-s font-bold text-text-default">
          {t("title")}
        </span>
        <span className="text-caption text-text-body">{t("body")}</span>
      </span>
      <ChevronRight aria-hidden="true" size={16} className="shrink-0" />
    </Link>
  );
}
