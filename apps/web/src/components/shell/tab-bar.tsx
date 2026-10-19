"use client";

import { Compass, House, Settings, Star, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

import { cn } from "@/lib/cn";
import { type Locale, localizedPath } from "@/lib/i18n";
import { TABS, type TabKey, isTabActive } from "@/lib/nav";

// 하단 탭 (노션 3장 TabBar): 탭 영역 60 + 아래 안전 영역(최소 14), 아이콘 21 + 글자 11, 선택 = 파랑 굵게
// 화면 바닥에 고정. PC(lg 이상)에서는 숨기고 상단 내비 노출됨
const ICONS: Record<TabKey, LucideIcon> = {
  home: House,
  explore: Compass,
  favorites: Star,
  settings: Settings,
};

export function TabBar() {
  const pathname = usePathname();
  const locale = useLocale() as Locale;
  const t = useTranslations("nav");

  return (
    <nav
      aria-label={t("main")}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border-default bg-bg-surface pb-[max(14px,env(safe-area-inset-bottom))] lg:hidden"
    >
      <ul className="mx-auto flex h-tabbar max-w-[640px]">
        {TABS.map(({ key, path }) => {
          const Icon = ICONS[key];
          const active = isTabActive(pathname, path, locale);
          return (
            <li key={key} className="flex-1">
              <Link
                href={localizedPath(locale, path)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-full min-h-touch flex-col items-center justify-center gap-1 text-[11px] leading-none",
                  active ? "font-bold text-brand-default" : "text-text-muted",
                )}
              >
                <Icon
                  aria-hidden="true"
                  size={21}
                  strokeWidth={active ? 2.4 : 2}
                />
                {t(key)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
