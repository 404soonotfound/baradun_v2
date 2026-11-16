"use client";

import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { STATUS } from "@/components/beach-row";
import { badgeTone } from "@/lib/badge-tone";
import { cn } from "@/lib/cn";
import type { FavoritesSort } from "@/lib/favorites-sort";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import type { StatusCount } from "@/lib/status-count";

// 즐겨찾기·최근 본 요약 한 줄 (GH-530 · 결정 기록 29장 D29-3·D29-6, 시안 S_FAVP4·S_FAVP4R·S_FAVM4)
// 즐겨찾기: "n곳 · 사유별 개수 · HH:MM 업데이트 · 거리는 내 위치 기준" + 오른쪽 '정렬 상태 먼저 ⌄'
// 최근 본: "최근 본 n곳 · 최근에 본 순 · 사유별 개수 · HH:MM 업데이트 · 거리는 내 위치 기준" + 오른쪽 '모두 지우기'
// 오래된 정보가 섞이면 탐색 요약 줄과 같이 'HH:MM 확인 · 이후 확인 못 함'을 붙임

const SORT_OPTIONS: readonly FavoritesSort[] = ["status", "added"];

export function FavoritesSummary({
  tab,
  total,
  counts,
  time,
  stale,
  nowMs,
  hasDistance,
  sort,
  onSortChange,
  onClearRecent,
}: {
  tab: "favorites" | "recent";
  total: number;
  counts: readonly StatusCount[];
  time: string | null;
  stale: { confirmedAt: string | null } | null;
  nowMs: number;
  hasDistance: boolean;
  sort: FavoritesSort;
  onSortChange: (next: FavoritesSort) => void;
  onClearRecent: () => void;
}) {
  const t = useTranslations();
  const { badgeText, confirmedUntilText } = useBadgeText();

  return (
    <div className="flex min-h-touch items-center justify-between gap-x-3 gap-y-1">
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-caption text-text-muted">
        <span className="text-body-s font-bold text-text-default lg:text-body">
          {tab === "favorites"
            ? t("favorites.summary.count", { count: total })
            : t("favorites.summary.recentCount", { count: total })}
        </span>
        {tab === "recent" && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true">·</span>
            <span>{t("favorites.summary.recentOrder")}</span>
          </span>
        )}
        {counts.map((item) => {
          const tone = STATUS[badgeTone(item.label)];
          const name = badgeText(item.label);
          return (
            <span
              key={`${item.category}|${name}`}
              className="flex items-center gap-1.5"
            >
              <span aria-hidden="true">·</span>
              <span
                className={cn(
                  "inline-flex items-center gap-1 font-bold",
                  tone.text,
                )}
              >
                <span aria-hidden="true">{tone.icon}</span>
                {name} {item.count}
              </span>
            </span>
          );
        })}
        {time && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true">·</span>
            <span>{t("explore.summary.updated", { time })}</span>
          </span>
        )}
        {stale && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true">·</span>
            <span>{confirmedUntilText(stale.confirmedAt, nowMs)}</span>
          </span>
        )}
        {hasDistance && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true">·</span>
            <span>{t("explore.distanceFromMe")}</span>
          </span>
        )}
      </p>

      {tab === "favorites" ? (
        <FavoritesSortMenu value={sort} onChange={onSortChange} />
      ) : (
        <button
          type="button"
          onClick={onClearRecent}
          aria-label={t("favorites.recent.clearLabel")}
          className="flex min-h-touch min-w-touch shrink-0 items-center justify-end px-1 text-caption font-medium text-text-body underline underline-offset-2 hover:text-text-default"
        >
          {t("favorites.recent.clear")}
        </button>
      )}
    </div>
  );
}

function FavoritesSortMenu({
  value,
  onChange,
}: {
  value: FavoritesSort;
  onChange: (next: FavoritesSort) => void;
}) {
  const t = useTranslations("favorites.sort");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

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

  return (
    <div
      ref={rootRef}
      // Safari가 버튼을 눌러도 relatedTarget을 주지 않는 경우를 대비해 null이면 바깥 누르기 처리에 맡김
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && !rootRef.current?.contains(next)) setOpen(false);
      }}
      className="relative shrink-0"
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((prev) => !prev)}
        className="flex min-h-touch min-w-touch items-center justify-end gap-1 px-1 text-caption font-medium text-text-body hover:text-text-default"
      >
        {t.rich("button", {
          value: t(value),
          label: (chunks) => <span className="max-lg:sr-only">{chunks}</span>,
        })}
        <Chevron aria-hidden="true" size={14} className="shrink-0" />
      </button>
      <ul
        id={listId}
        aria-label={t("label")}
        hidden={!open}
        className="absolute top-full right-0 z-30 mt-1 flex w-[148px] flex-col gap-0.5 rounded-card border border-border-default bg-bg-surface p-1.5 shadow-raised"
      >
        {SORT_OPTIONS.map((option) => {
          const selected = option === value;
          return (
            <li key={option}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                  buttonRef.current?.focus();
                }}
                className={cn(
                  "flex min-h-touch w-full items-center justify-between gap-2 rounded-[10px] px-3 text-left text-body-s hover:bg-bg-subtle",
                  selected
                    ? "bg-brand-weak/50 font-bold text-brand-default"
                    : "text-text-default",
                )}
              >
                {t(option)}
                {selected && <Check aria-hidden="true" size={15} />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
