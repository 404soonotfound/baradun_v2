"use client";

import { Clock, X } from "lucide-react";
import { useTranslations } from "next-intl";

import type { RecentSearch } from "@/lib/recent-search";

// 최근 검색 (BRD-31 · GH-531 결정 기록 29장 D29-5, 시안 S_SRC0P2)
// 제목 + 오른쪽 '모두 지우기' → 42px 칩(시계 + 검색어). 칩을 누르면 그 검색어로 다시 찾음
// 하나씩 지우기(✕)는 지금 동작이라 남김(칩 안 오른쪽, 누르는 영역 44px). 저장 규칙(최대 10개 · 기기 저장)은 그대로
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
    <section aria-labelledby="search-recent" className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 id="search-recent" className="text-title-m text-text-default">
          {t("title")}
        </h2>
        {/* 누르는 영역 44는 위아래 음수 여백으로 줄 높이를 늘리지 않고 둠 */}
        <button
          type="button"
          onClick={onClear}
          className="-my-2.5 -mr-2 flex min-h-touch items-center px-2 text-label-s text-text-muted underline underline-offset-2 hover:text-text-default"
        >
          {t("clear")}
        </button>
      </div>
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li
            key={item.q}
            className="flex h-[42px] items-center rounded-full border border-border-strong bg-bg-surface"
          >
            <button
              type="button"
              onClick={() => onPick(item.q)}
              className="flex h-full min-w-0 items-center gap-1.5 rounded-l-full pl-4 text-[13.5px] text-text-body hover:text-text-default"
            >
              <Clock
                aria-hidden="true"
                size={14}
                className="shrink-0 text-text-muted"
              />
              <span className="max-w-[12rem] truncate">{item.q}</span>
            </button>
            <button
              type="button"
              aria-label={t("remove", { query: item.q })}
              onClick={() => onRemove(item.q)}
              className="relative mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-text-muted before:absolute before:-inset-1.5 before:content-[''] hover:bg-bg-subtle"
            >
              <X aria-hidden="true" size={13} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
