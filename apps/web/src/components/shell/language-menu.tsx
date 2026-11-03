"use client";

import { Check, ChevronDown, ChevronUp, Globe } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useId, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import { LOCALE_NAMES, LOCALES, type Locale } from "@/lib/i18n";
import { languageSwitchHref, setLanguageChoice } from "@/lib/language-choice";

// 푸터 언어 고르기. 누르면 위로 목록이 열리고, 고르면 같은 화면의 그 언어 주소로 이동(언어마다 주소가 따로, /·/en)
// 모바일(row): 왼쪽 '언어' + 오른쪽 상자, PC(inline): '언어: 한국어' 한 줄
// 목록은 링크(메뉴 역할 아님). Esc·바깥 누르기로 닫히고 Esc는 버튼으로 포커스를 돌림
// 고른 언어는 기기에 저장해 첫 방문 언어 안내를 다시 띄우지 않음(BRD-48). 기기 언어로 자동 이동하지 않음
type Props = { locale: Locale; variant: "row" | "inline" };

// useSearchParams는 정적 HTML을 만들 때 주소를 몰라 Suspense로 감쌈. 그동안은 매개변수 없이 같은 화면 주소
export function LanguageMenu(props: Props) {
  return (
    <Suspense fallback={<Menu {...props} search="" />}>
      <WithSearch {...props} />
    </Suspense>
  );
}

function WithSearch(props: Props) {
  // 언어를 바꿔도 검색어(?q=)·문의 맥락(?beach=) 같은 지금 주소의 매개변수는 그대로 넘김
  const search = useSearchParams().toString();
  return <Menu {...props} search={search} />;
}

function Menu({ locale, variant, search }: Props & { search: string }) {
  const t = useTranslations("footer");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const labelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const Chevron = open ? ChevronUp : ChevronDown;
  const row = variant === "row";

  return (
    <div
      ref={rootRef}
      // 포커스가 목록 밖 요소로 옮겨가면(Tab) 닫음. 옮겨간 곳이 없으면(relatedTarget null) 두고 바깥 누르기 처리에 맡김
      // Safari는 링크를 눌러도 포커스를 주지 않아, null에서 닫으면 누르는 도중 목록이 사라져 고른 링크가 열리지 않음
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && !rootRef.current?.contains(next)) setOpen(false);
      }}
      className={cn(
        "relative",
        row && "flex items-center justify-between gap-3",
      )}
    >
      {row && (
        <span
          id={labelId}
          className="flex items-center gap-2 text-body font-bold text-text-default"
        >
          <Globe aria-hidden="true" size={18} />
          {t("language")}
        </span>
      )}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={row ? `${labelId} ${listId}-value` : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex min-h-touch items-center gap-2 text-text-body",
          row
            ? "min-w-[176px] justify-between rounded-button border border-border-strong bg-bg-surface px-4 text-body text-text-default"
            : "rounded-button px-2 text-body-s hover:text-text-default",
        )}
      >
        {!row && <Globe aria-hidden="true" size={16} />}
        <span id={`${listId}-value`}>
          {row
            ? LOCALE_NAMES[locale]
            : t("languageValue", { name: LOCALE_NAMES[locale] })}
        </span>
        <Chevron aria-hidden="true" size={row ? 18 : 16} />
      </button>
      <ul
        id={listId}
        hidden={!open}
        className="absolute right-0 bottom-full z-30 mb-2 flex w-[200px] flex-col gap-1 rounded-card border border-border-default bg-bg-surface p-2 shadow-raised"
      >
        {LOCALES.map((value) => (
          <li key={value}>
            <Link
              href={languageSwitchHref(value, pathname, search)}
              hrefLang={value}
              lang={value}
              onClick={() => {
                setLanguageChoice(value);
                setOpen(false);
              }}
              aria-current={value === locale ? "true" : undefined}
              className={cn(
                "flex min-h-touch items-center justify-between gap-2 rounded-[10px] px-3 text-body hover:bg-bg-subtle",
                value === locale
                  ? "font-bold text-brand-default"
                  : "text-text-default",
              )}
            >
              {LOCALE_NAMES[value]}
              {/* 지금 언어는 굵은 글자 + ✓(색만으로 구분하지 않음) */}
              {value === locale && <Check aria-hidden="true" size={18} />}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
