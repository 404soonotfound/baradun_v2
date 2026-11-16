"use client";

import { MapPin, Search } from "lucide-react";
import { useTranslations } from "next-intl";

import { ReasonBadge } from "@/components/reason-badge";
import { BeachThumb } from "@/components/search/beach-thumb";
import { Highlighted } from "@/components/search/search-result-row";
import { Skeleton } from "@/components/ui/skeleton";
import type { BeachSummary } from "@/lib/beach-summary";
import { cn } from "@/lib/cn";
import type { BeachView } from "@/lib/snapshot/view";

// 입력 중 제안 (GH-531 · 결정 기록 29장 D29-7, 시안 S_SRCQ)
// 검색 칸 아래 떠 있는 목록: 지역 먼저 → 해변 4곳(가까운 순, 위치가 없으면 찾은 순) → '결과 n곳 모두 보기' → 키보드 안내
// 콤보박스(검색 칸) + 목록상자 패턴: 포커스는 검색 칸에 두고 aria-activedescendant로 고른 줄을 알림(↑↓ · Enter · Esc)
// 줄은 링크가 아니라 option. 누르면 부르는 쪽이 이동·지역 결과·모두 보기를 처리

export type SuggestRegion = {
  key: string;
  label: string; // "강원 양양군"
  detail: string; // "해변 21곳 · 강원북부앞바다"
};
export type SuggestBeach = {
  id: string;
  name: string;
  photo: BeachSummary["photo"];
  meta: string; // "강원 양양군 · 20.3km"
  view: BeachView;
};
// 키보드로 고르는 순서 그대로의 줄 목록(지역 → 해변 → 모두 보기)
export type SuggestOption =
  | { kind: "region"; region: SuggestRegion }
  | { kind: "beach"; beach: SuggestBeach }
  | { kind: "all" };

export function optionId(listId: string, index: number): string {
  return `${listId}-${index}`;
}

export function SearchSuggestions({
  id,
  query,
  options,
  total,
  located,
  clearNote,
  active,
  onPick,
  onHover,
}: {
  id: string;
  query: string;
  options: readonly SuggestOption[];
  total: number; // 검색어에 맞는 해변 전체 수
  located: boolean; // 위치가 있어 해변 줄이 가까운 순인지
  // 해변 줄의 '특보 없음' 근거(범위·기관·확인 시각). '특보 없음' 칩이 없으면 null
  clearNote: string | null;
  active: number; // 고른 줄(키보드·마우스). 없으면 -1
  onPick: (option: SuggestOption) => void;
  onHover: (index: number) => void;
}) {
  const t = useTranslations("search.suggest");
  const row = (index: number, extra?: string) => ({
    id: optionId(id, index),
    role: "option" as const,
    "aria-selected": index === active,
    // 누를 때 검색 칸의 포커스를 잃지 않게(blur로 목록이 닫히지 않게)
    onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
    onMouseEnter: () => onHover(index),
    onClick: () => onPick(options[index]!),
    className: cn(
      "flex min-h-touch cursor-pointer items-center gap-3 px-4",
      index === active &&
        "bg-brand-weak shadow-[inset_3px_0_0_var(--color-brand-default)]",
      extra,
    ),
  });

  const indexed = options.map((option, index) => ({ option, index }));
  const regionRows = indexed.filter(({ option }) => option.kind === "region");
  const beachRows = indexed.filter(({ option }) => option.kind === "beach");
  const allRow = indexed.find(({ option }) => option.kind === "all");

  // 묶음(지역·해변): 목록상자 안 group + 화면에만 보이는 묶음 이름(이름은 aria-label로 알림)
  function group(
    label: string,
    rows: typeof indexed,
    render: (item: (typeof indexed)[number]) => React.ReactNode,
  ) {
    if (rows.length === 0) return null;
    return (
      <div
        role="group"
        aria-label={label}
        className="border-b border-border-default"
      >
        <div
          aria-hidden="true"
          className="px-4 pt-2.5 pb-1 text-[11.5px] text-text-muted"
        >
          {label}
        </div>
        {rows.map(render)}
      </div>
    );
  }

  return (
    <div className="absolute inset-x-0 top-full z-30 mt-2 overflow-hidden rounded-card bg-bg-surface shadow-floating">
      <div id={id} role="listbox" aria-label={t("label")}>
        {group(t("regionHeading"), regionRows, ({ option, index }) =>
          option.kind === "region" ? (
            <div key={option.region.key} {...row(index, "py-2")}>
              <MapPin
                aria-hidden="true"
                size={18}
                className="mx-2 shrink-0 text-brand-default"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body-s text-text-default">
                  <Highlighted text={option.region.label} query={query} />
                </span>
                <span className="text-caption text-text-muted">
                  {option.region.detail}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="shrink-0 text-caption font-bold text-brand-default"
              >
                {t("regionAction")}
              </span>
            </div>
          ) : null,
        )}
        {group(
          located
            ? t("beachHeadingNear", { shown: beachRows.length, total })
            : t("beachHeading", { shown: beachRows.length, total }),
          beachRows,
          ({ option, index }) =>
            option.kind === "beach" ? (
              <div key={option.beach.id} {...row(index, "py-1.5")}>
                <BeachThumb
                  photo={option.beach.photo}
                  className="h-10 w-11 rounded-[10px]"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body-s text-text-default">
                    <Highlighted text={option.beach.name} query={query} />
                  </span>
                  <span className="truncate text-caption text-text-muted">
                    <Highlighted text={option.beach.meta} query={query} />
                  </span>
                </span>
                {option.beach.view.kind === "ready" ? (
                  <ReasonBadge label={option.beach.view.badge} size="sm" />
                ) : (
                  <Skeleton className="h-badge w-16 rounded-badge" />
                )}
              </div>
            ) : null,
        )}
        {allRow && (
          <div {...row(allRow.index, "text-body-s")}>
            <Search
              aria-hidden="true"
              size={16}
              className="shrink-0 text-brand-default"
            />
            <span className="font-bold text-brand-default">
              {t("all", { query: query.trim(), count: total })}
            </span>
          </div>
        )}
      </div>
      {clearNote && (
        <p className="border-t border-border-default px-4 py-2 text-caption text-text-muted">
          {clearNote}
        </p>
      )}
      <p
        aria-hidden="true"
        className="border-t border-border-default bg-bg-subtle px-4 py-2 text-caption text-text-muted"
      >
        {t("keys")}
      </p>
    </div>
  );
}
