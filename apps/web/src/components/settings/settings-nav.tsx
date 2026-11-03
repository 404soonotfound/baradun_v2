"use client"; // 지금 주소로 고른 줄을 표시(usePathname)

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { localizedPath, type Locale } from "@/lib/i18n";

// 설정 PC 왼쪽 목록 (Figma 184:1102). 설정 화면과 안내·문의·약관·출처 화면이 같이 씀(PC는 같은 좌우 배치)
// 묶음(위치·화면·기기 데이터)은 설정 화면 안에서는 버튼(onPanel), 다른 화면에서는 설정 주소 + #묶음 링크
// 모바일은 숨김(설정은 묶음이 한 줄로 이어지고, 다른 화면은 뒤로 가기로 설정에 돌아감)

export type SettingsPanel = "location" | "display" | "device";
export const SETTINGS_PANELS: readonly SettingsPanel[] = [
  "location",
  "display",
  "device",
];

const PAGES = [
  { href: "/guide/", key: "guide" },
  { href: "/settings/inquiry/", key: "inquiry" },
  { href: "/terms/", key: "terms" },
  { href: "/about/data/", key: "dataSources" },
] as const;

// 설정 화면과 하위 화면이 같이 쓰는 PC 좌우 배치(가운데 최대 1036 · 왼쪽 목록 260 + 오른쪽 내용)
export const SETTINGS_WIDTH = "lg:mx-auto lg:w-full lg:max-w-[1036px]";
export const SETTINGS_COLUMNS =
  "lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start lg:gap-8";

const ITEM =
  "flex min-h-touch w-full items-center rounded-[10px] px-3 text-left text-body text-text-default hover:bg-bg-subtle";
const CURRENT =
  "bg-brand-weak font-bold text-brand-default hover:bg-brand-weak";

export function SettingsNav({
  locale,
  panel,
  onPanel,
}: {
  locale: Locale;
  panel?: SettingsPanel; // 설정 화면에서 고른 묶음
  onPanel?: (next: SettingsPanel) => void; // 없으면 묶음 줄은 설정 화면 링크
}) {
  const t = useTranslations("settings");
  const tp = useTranslations("pages");
  const pathname = usePathname();

  function panelItem(key: SettingsPanel, label: string) {
    const current = panel === key;
    if (onPanel) {
      return (
        <button
          type="button"
          onClick={() => onPanel(key)}
          aria-current={current ? "true" : undefined}
          className={cn(ITEM, current && CURRENT)}
        >
          {label}
        </button>
      );
    }
    return (
      <Link
        href={`${localizedPath(locale, "/settings/")}#${key}`}
        className={ITEM}
      >
        {label}
      </Link>
    );
  }

  const item = (key: string, node: ReactNode) => <li key={key}>{node}</li>;

  return (
    <nav
      aria-label={t("groupsLabel")}
      className="hidden lg:sticky lg:top-24 lg:block"
    >
      <ul className="flex flex-col rounded-card bg-bg-surface p-2 shadow-card">
        {item("location", panelItem("location", t("location.title")))}
        {item("display", panelItem("display", t("display.title")))}
        {PAGES.map((page) => {
          const href = localizedPath(locale, page.href);
          const current = pathname === href || `${pathname}/` === href;
          return item(
            page.href,
            <Link
              href={href}
              aria-current={current ? "page" : undefined}
              className={cn(ITEM, current && CURRENT)}
            >
              {tp(page.key)}
            </Link>,
          );
        })}
        {item("device", panelItem("device", t("info.device")))}
      </ul>
    </nav>
  );
}

// 안내·문의·약관·출처 화면을 PC에서 설정과 같은 좌우 배치(왼쪽 목록 260 + 오른쪽 내용)로 감쌈. 모바일은 내용만
// 내용 부품의 가운데 정렬(mx-auto)·폭 제한(640)은 PC에서 풀어 설정 묶음처럼 오른쪽 칸을 꽉 채움
export function SettingsLayout({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  return (
    <div className={cn(SETTINGS_WIDTH, SETTINGS_COLUMNS)}>
      <SettingsNav locale={locale} />
      <div className="min-w-0 lg:*:mx-0 lg:*:max-w-none">{children}</div>
    </div>
  );
}
