"use client";

import { Clock, X } from "lucide-react";
import { useTranslations } from "next-intl";

import type { RecentSearch } from "@/lib/recent-search";

// 최근 검색 (BRD-31 · 노션 2장 SRCH '입력 전: 최근 검색(개별·전체 지우기)')
// 항목을 누르면 그 검색어로 다시 찾음. ✕는 항목 옆(누르는 영역 44px)
export function RecentSearches({
  items,
  onPick,
  onRemove,
  onClear,
}: {
  items: readonly RecentSearch[];
  onPick: (query: string) => void;
  onRemove: (query: string) => void;
  onClear: () => void;
}) {
  const t = useTranslations("search.recent");
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="search-recent" className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <h2 id="search-recent" className="text-title-s text-text-default">
          {t("title")}
        </h2>
        <button
          type="button"
          onClick={onClear}
          className="-mr-2 flex min-h-touch items-center px-2 text-body-s text-text-muted underline"
        >
          {t("clear")}
        </button>
      </div>
      <ul>
        {items.map((item) => (
          <li key={item.q} className="flex items-center">
            <button
              type="button"
              onClick={() => onPick(item.q)}
              className="flex min-h-touch min-w-0 flex-1 items-center gap-2.5 text-left text-body text-text-body"
            >
              <Clock
                aria-hidden="true"
                size={16}
                className="shrink-0 text-text-muted"
              />
              <span className="truncate">{item.q}</span>
            </button>
            <button
              type="button"
              aria-label={t("remove", { query: item.q })}
              onClick={() => onRemove(item.q)}
              className="flex size-touch shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-bg-subtle"
            >
              <X aria-hidden="true" size={16} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
