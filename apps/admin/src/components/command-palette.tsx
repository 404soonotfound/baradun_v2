"use client";

import { Search, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { messages } from "@/lib/messages";

// ⌘K 찾기 (GH-450, 시안 4차 V7). 지금은 '화면' 묶음만: 메뉴 화면 이름으로 찾아 엶
// 해변·문의 찾기(V7의 해변·문의 묶음)는 찾기 API가 없어 넣지 않음
// - <dialog> 모달이 포커스를 가두고 Esc로 닫힘. 바깥(배경) 누르기도 닫음. 닫히면 연 단추로 포커스가 돌아감
// - 입력 칸은 combobox, 결과는 listbox. ↑↓로 고르고 Enter로 엶(aria-activedescendant)

const t = messages.nav;

export interface PaletteItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

// 공백을 빼고 비교(한국어 이름 '수집현황'으로 찾아도 맞게)
const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

export function CommandPalette({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: readonly PaletteItem[];
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const found = items.filter((item) => norm(item.label).includes(norm(query)));
  const current = Math.min(active, Math.max(0, found.length - 1));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  const close = () => {
    setQuery("");
    setActive(0);
    onClose();
  };

  const go = (item: PaletteItem | undefined) => {
    if (!item) return;
    close();
    router.push(item.href);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (found.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + found.length) % found.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(found[current]);
    }
  };

  const optionId = (i: number) => `${id}-option-${i}`;
  return (
    <dialog
      ref={ref}
      aria-label={t.searchTitle}
      onClose={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="mx-auto mt-[120px] w-[600px] max-w-[calc(100vw-32px)] rounded-admin-box border border-border-default bg-bg-surface p-0 text-text-default shadow-floating backdrop:bg-[rgb(11_26_44/0.4)]"
    >
      {open && (
        <div className="flex flex-col">
          <div className="flex items-center gap-2.5 border-b border-border-default px-4">
            <Search
              aria-hidden="true"
              className="size-4 shrink-0 text-text-muted"
            />
            <input
              autoFocus
              type="text"
              role="combobox"
              aria-label={t.searchPlaceholder}
              aria-expanded={found.length > 0}
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={
                found.length > 0 ? optionId(current) : undefined
              }
              placeholder={t.searchPlaceholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              className="h-[52px] min-w-0 flex-1 bg-transparent text-title-s font-normal text-text-default outline-none placeholder:text-text-muted"
            />
            <button
              type="button"
              onClick={close}
              aria-label={t.searchClose}
              className="rounded-admin-badge border border-border-strong px-1.5 text-caption font-semibold text-text-body"
            >
              Esc
            </button>
          </div>
          <div className="max-h-[50vh] overflow-y-auto p-2">
            <p
              id={`${id}-group`}
              className="px-2 pt-1 pb-1.5 text-caption font-medium text-text-muted"
            >
              {t.searchGroup}
            </p>
            <ul
              id={`${id}-list`}
              role="listbox"
              aria-labelledby={`${id}-group`}
              className="flex flex-col"
            >
              {found.map((item, i) => (
                <li
                  key={item.href}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === current}
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(item)}
                  className={`flex min-h-touch cursor-pointer items-center gap-2.5 rounded-admin-control px-2.5 text-body font-medium lg:min-h-admin-control ${
                    i === current
                      ? "bg-bg-page text-text-default"
                      : "text-text-body"
                  }`}
                >
                  <item.icon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-text-muted"
                  />
                  {item.label}
                </li>
              ))}
            </ul>
            {found.length === 0 && (
              <p
                role="status"
                className="px-2 py-3 text-body-s text-text-muted"
              >
                {t.searchEmpty}
              </p>
            )}
          </div>
          <p className="border-t border-border-default bg-bg-page px-4 py-2 text-caption text-text-muted">
            {t.searchHint}
          </p>
        </div>
      )}
    </dialog>
  );
}
