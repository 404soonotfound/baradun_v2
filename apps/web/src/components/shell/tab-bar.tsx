"use client";

import { Compass, House, Settings, Star, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/cn";
import { TABS, type TabKey, showsTabBar } from "@/lib/nav";
import { useTabNavigation } from "@/lib/use-tab-navigation";

// 하단 탭 (노션 3장 TabBar): 전체 74 = 탭 60 + 아래 여백 최소 14, 아이콘 21 + 글자 11, 선택 = 파랑 굵게
// 화면 바닥에 고정. PC(lg 이상)에서는 숨기고 상단 내비가 대신함
// 이동 규칙(마지막 상태·맨 위로)은 useTabNavigation 담당
const ICONS: Record<TabKey, LucideIcon> = {
  home: House,
  explore: Compass,
  favorites: Star,
  settings: Settings,
};

export function TabBar() {
  const t = useTranslations("nav");
  const { pathname, locale, current, hrefFor, onTabClick } = useTabNavigation();

  // 상세·문의에서는 숨김 (노션 2장). 훅은 이 return보다 위에 위치(훅 규칙)
  if (!showsTabBar(pathname, locale)) return null;

  return (
    <nav
      aria-label={t("main")}
      // 위 구분선은 테두리 대신 안쪽 그림자: 테두리 1px이 높이에 더해져 75가 되는 것 방지(노션 74)
      className="fixed inset-x-0 bottom-0 z-40 bg-bg-surface pb-[max(14px,env(safe-area-inset-bottom))] shadow-[inset_0_1px_0_var(--color-border-default)] lg:hidden"
    >
      <ul className="mx-auto flex h-tabbar max-w-[640px]">
        {TABS.map(({ key }) => {
          const Icon = ICONS[key];
          const active = key === current;
          return (
            <li key={key} className="flex-1">
              <Link
                href={hrefFor(key)}
                scroll={false}
                onClick={(event) => onTabClick(event, key)}
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
