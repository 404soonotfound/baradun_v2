"use client";

import { Search, Settings } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/cn";
import { localizedPath } from "@/lib/i18n";
import { TABS, isTabActive } from "@/lib/nav";
import { useTabNavigation } from "@/lib/use-tab-navigation";

// 상단 내비 (노션 1장 'PC 흐름', 3장 TopNav): 높이 64, 현재 메뉴는 아래 2px 파란 줄
// 홈 · 탐색 · 즐겨찾기 + 검색 + 설정. 업데이트 상태는 데이터 연결 이슈에서 추가 예정
// 메뉴(설정 포함)는 하단 탭과 같은 이동 규칙(마지막 상태·맨 위로) 사용. PC(lg 이상)에서만 표시
export function TopNav() {
  const t = useTranslations("nav");
  const tMeta = useTranslations("meta");
  const { pathname, locale, current, hrefFor, onTabClick } = useTabNavigation();
  const menu = TABS.filter((tab) => tab.key !== "settings");
  const searchActive = isTabActive(pathname, "/search/", locale);

  return (
    <header className="sticky top-0 z-40 hidden h-16 border-b border-border-default bg-bg-surface lg:block">
      {/* 높이 64는 아래 테두리 1px 포함 (header에 h-16, 안쪽은 h-full) */}
      <div className="mx-auto flex h-full max-w-[1280px] items-center gap-8 px-10">
        <Link
          href={localizedPath(locale, "/")}
          className="text-title-m text-text-default"
        >
          {tMeta("siteName")}
        </Link>

        <nav aria-label={t("main")} className="h-full">
          <ul className="flex h-full gap-6">
            {menu.map(({ key }) => {
              const active = key === current;
              return (
                <li key={key} className="h-full">
                  <Link
                    href={hrefFor(key)}
                    scroll={false}
                    onClick={(event) => onTabClick(event, key)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-full items-center border-b-2 text-title-s",
                      active
                        ? "border-brand-default text-brand-default"
                        : "border-transparent text-text-body hover:text-text-default",
                    )}
                  >
                    {t(key)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link
            href={localizedPath(locale, "/search/")}
            aria-current={searchActive ? "page" : undefined}
            className={cn(
              "flex h-search items-center gap-2 rounded-full border border-border-strong px-4 text-body text-text-muted",
              searchActive && "border-brand-default",
            )}
          >
            <Search aria-hidden="true" size={18} />
            {t("search")}
          </Link>
          <Link
            href={hrefFor("settings")}
            scroll={false}
            onClick={(event) => onTabClick(event, "settings")}
            aria-current={current === "settings" ? "page" : undefined}
            aria-label={t("settings")}
            className={cn(
              "flex size-touch items-center justify-center rounded-full hover:bg-bg-subtle",
              current === "settings" ? "text-brand-default" : "text-text-body",
            )}
          >
            <Settings aria-hidden="true" size={21} />
          </Link>
        </div>
      </div>
    </header>
  );
}
