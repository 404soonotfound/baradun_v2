"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import type { BeachName } from "@/lib/beach-names";
import {
  adjustReceivedCount,
  badgeOwner,
  setReceivedCount,
} from "@/lib/inquiry-badge";
import {
  BEACH_NONE,
  EMPTY_INQUIRY_FILTER,
  fetchInquiries,
  fetchInquiry,
  filterInquiries,
  hasActiveInquiryFilter,
  isKstToday,
  MEMO_MAX,
  previewText,
  REJECT_REASON_MAX,
  saveInquiry,
  INQUIRY_STATUSES,
  isInquiryStatus,
  kstDateTime,
  linesNormalized,
  PAGE_SIZE,
  redactionOf,
  retentionDate,
  shortId,
  type InquiryCounts,
  type InquiryDetail,
  type InquiryFilter,
  type InquiryPage,
  type InquiryPatch,
  type InquiryStatus,
  type InquirySummary,
  type ReceivedFilter,
  type Redaction,
} from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import { pageRows, pageWindow } from "@/lib/paging";
import { AdminShell } from "./admin-shell";
import {
  CELL_END,
  CELL_NAME,
  DataTable,
  Pager,
  TD,
  TH,
  TR,
} from "./data-table";
import { Button, Notice } from "./ui";

// 운영자 문의 목록·상세 (BRD-153, 화면 설계서 6장 ADM-INQ, 시안 4차 V20·VM6·VM7·E6·E11·VE6)
// - 목록: 상태 탭(첫 쪽에 온 상태별 수) + 표. 접수 먼저, 같은 상태 안에서는 최근 접수 순(서버가 정함)
// - 상세: 주소 ?id= 로 엶. PC(1024 이상)는 목록 옆 시트, 그보다 좁으면 목록 대신 상세 화면
// - 이 PR은 읽기만. 상태·메모 바꾸기는 다음 PR
// - 판단 상태는 바꾸지 않음(G1). 이메일·사진은 받지 않으므로 '받지 않아요' 고정(D13-1)

const t = messages.inquiries;

type Beaches = Readonly<Record<string, BeachName>>;

// 이 탭에서 저장한 결과. 목록(GSI)은 최종적 일관성이라 저장 직후 이전 상태를 줄 수 있어
// 목록 항목 version이 저장한 version보다 낮으면 저장한 상태로 보여 줌(오래된 응답이 저장 결과를 되돌리지 않게, D16-B4)
interface Saved {
  readonly status: InquiryStatus;
  readonly version: number;
  // 저장 전 상태와 저장 시각: 그 뒤에 받은 상태별 수가 아니면 탭 수를 이만큼 옮김
  readonly from: string;
  readonly at: number;
}
type SavedMap = Readonly<Record<string, Saved>>;

// 탭 수를 이 탭에서 저장한 만큼 옮김(서버 수는 GSI라 늦을 수 있음, D16-B4)
function adjustCounts(
  counts: InquiryCounts,
  countedAt: number,
  saved: SavedMap,
): InquiryCounts {
  const next = { ...counts };
  for (const mine of Object.values(saved)) {
    if (mine.at <= countedAt || mine.from === mine.status) continue;
    if (!isInquiryStatus(mine.from)) continue;
    next[mine.from] = Math.max(0, next[mine.from] - 1);
    next[mine.status] += 1;
  }
  return next;
}

function withSaved(item: InquirySummary, saved: SavedMap): InquirySummary {
  const mine = saved[item.inquiryId];
  return mine && mine.version > item.version
    ? { ...item, status: mine.status, version: mine.version }
    : item;
}

// 상태 배지: 글자로 상태를 말하고, 색·테두리 모양은 보조(색만으로 구분하지 않음)
// 확인 중은 점선 테두리라 색 없이도 구분됨(시안 V20·S3 배지)
const BADGE: Record<InquiryStatus, string> = {
  received: "bg-brand-weak text-brand-default ring-1 ring-brand-border",
  in_progress:
    "bg-status-stale-bg text-status-stale-fg outline-1 outline-status-stale-border outline-dashed -outline-offset-1",
  resolved: "bg-success-bg text-success-fg ring-1 ring-success-border",
  rejected: "bg-info-bg text-info-fg ring-1 ring-border-default",
};

// 모르는 상태 값은 숨기지 않고 그 값을 그대로 보여 줌(점선·흐린 글자)
function StatusBadge({ status }: { status: string }) {
  const known = isInquiryStatus(status);
  return (
    <span
      className={`inline-flex items-center rounded-admin-badge px-1.5 text-caption font-semibold whitespace-nowrap ${
        known
          ? BADGE[status]
          : "bg-bg-surface text-text-muted outline-1 outline-border-strong outline-dashed -outline-offset-1"
      }`}
    >
      {known ? t.status[status] : fill(t.unknownStatus, { status })}
    </span>
  );
}

function typeLabel(type: string): string {
  return type in t.type
    ? t.type[type as keyof typeof t.type]
    : fill(t.unknownType, { type });
}

function activityLabel(activity: string): string {
  return activity in t.activity
    ? t.activity[activity as keyof typeof t.activity]
    : fill(t.unknownActivity, { activity });
}

// 해변 이름표에 없는 ID도 숨기지 않고 ID를 그대로 보여 줌
function beachText(beachId: string | undefined, beaches: Beaches): string {
  if (!beachId) return t.noBeach;
  return beaches[beachId]?.name ?? fill(t.unknownBeach, { id: beachId });
}

function BeachActivity({
  item,
  beaches,
}: {
  item: InquirySummary;
  beaches: Beaches;
}) {
  const beach = item.beachId ? beaches[item.beachId] : undefined;
  return (
    <span>
      {beachText(item.beachId, beaches)}
      {item.activity && ` · ${activityLabel(item.activity)}`}
      {beach?.hidden && (
        <span className="ml-1.5 text-caption text-text-muted">
          ({t.hiddenBeach})
        </span>
      )}
    </span>
  );
}

// 실패: 무슨 일 → 영향 → 다음 행동. 오류 번호가 있으면 함께
function Failure({
  title,
  result,
  onRetry,
}: {
  title: string;
  result: Extract<OpsResult<unknown>, { ok: false }>;
  onRetry: () => void;
}) {
  if (result.code === "reauth") {
    // 다시 로그인 창에서 로그인하면 화면이 저절로 다시 읽음(generation)
    return <Notice tone="warn" title={t.reauth} role="alert" />;
  }
  return (
    <Notice tone="fail" title={title} role="alert">
      <p>{t.serverHint}</p>
      {"requestId" in result && result.requestId && (
        <p>{fill(t.requestId, { id: result.requestId })}</p>
      )}
      <Button
        variant="secondary"
        size="small"
        className="mt-2"
        onClick={onRetry}
      >
        {t.retry}
      </Button>
    </Notice>
  );
}

function detailHref(id: string): string {
  return `/inquiries/?id=${encodeURIComponent(id)}`;
}

// 열린 목록을 바깥 누르기·Esc로 닫음(Esc는 여는 버튼으로 포커스를 돌림, GH-458)
function useDismiss(
  open: boolean,
  setOpen: (next: boolean) => void,
  box: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", esc);
    };
  }, [open, setOpen, box, trigger]);
}

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

const CHIP_IDLE =
  "inline-flex min-h-touch items-center gap-1.5 rounded-admin-control border border-dashed border-border-strong bg-bg-surface px-2.5 text-body-s font-medium whitespace-nowrap text-text-body hover:bg-bg-page lg:h-9 lg:min-h-0";
const CHIP_ACTIVE_BOX =
  "inline-flex min-h-touch items-center overflow-hidden rounded-admin-control border border-brand-border bg-brand-weak text-body-s font-medium whitespace-nowrap text-brand-default lg:h-9 lg:min-h-0";
const MENU_ITEM =
  "flex min-h-touch items-center rounded-admin-control px-2.5 text-left text-body-s text-text-default hover:bg-bg-page aria-pressed:font-semibold aria-pressed:text-brand-default lg:min-h-admin-control";

function FilterChipTrigger({
  active,
  label,
  clearLabel,
  open,
  triggerRef,
  onToggle,
  onClear,
}: {
  active: boolean;
  label: string;
  clearLabel: string;
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  onClear: () => void;
}) {
  if (!active) {
    return (
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={CHIP_IDLE}
      >
        <PlusIcon />
        {label}
      </button>
    );
  }
  return (
    <div className={CHIP_ACTIVE_BOX}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-full items-center px-2.5 hover:bg-brand-border/20"
      >
        {label}
      </button>
      <button
        type="button"
        aria-label={clearLabel}
        onClick={onClear}
        className="flex h-full items-center border-l border-brand-border px-2 hover:bg-brand-border/20"
      >
        <ClearIcon />
      </button>
    </div>
  );
}

function TypeFilterMenu({
  value,
  types,
  onChange,
}: {
  value: string | null;
  types: readonly string[];
  onChange: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(open, setOpen, box, trigger);

  return (
    <div ref={box} className="relative">
      <FilterChipTrigger
        active={value !== null}
        label={
          value !== null
            ? fill(t.typeChip, { type: typeLabel(value) })
            : t.typeFilter
        }
        clearLabel={fill(t.clearFilter, { label: t.typeFilter })}
        open={open}
        triggerRef={trigger}
        onToggle={() => setOpen((v) => !v)}
        onClear={() => {
          onChange(null);
          setOpen(false);
        }}
      />
      {open && (
        <div
          role="group"
          aria-label={t.typeMenu}
          className="absolute top-full left-0 z-20 mt-1 flex min-w-48 flex-col rounded-admin-box border border-border-default bg-bg-surface p-1 shadow-floating"
        >
          <button
            type="button"
            aria-pressed={value === null}
            onClick={() => {
              onChange(null);
              setOpen(false);
              trigger.current?.focus();
            }}
            className={MENU_ITEM}
          >
            {t.typeAll}
          </button>
          {types.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={value === kind}
              onClick={() => {
                onChange(kind);
                setOpen(false);
                trigger.current?.focus();
              }}
              className={MENU_ITEM}
            >
              {typeLabel(kind)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BeachFilterMenu({
  value,
  options,
  onChange,
}: {
  value: string | null;
  options: readonly { readonly id: string; readonly label: string }[];
  onChange: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(open, setOpen, box, trigger);

  const selectedLabel =
    value === BEACH_NONE
      ? t.beachNoneOption
      : options.find((o) => o.id === value)?.label ?? value ?? "";

  return (
    <div ref={box} className="relative">
      <FilterChipTrigger
        active={value !== null}
        label={
          value !== null
            ? fill(t.beachChip, { beach: selectedLabel })
            : t.beachFilter
        }
        clearLabel={fill(t.clearFilter, { label: t.beachFilter })}
        open={open}
        triggerRef={trigger}
        onToggle={() => setOpen((v) => !v)}
        onClear={() => {
          onChange(null);
          setOpen(false);
        }}
      />
      {open && (
        <div
          role="group"
          aria-label={t.beachMenu}
          className="absolute top-full left-0 z-20 mt-1 flex max-h-64 min-w-48 flex-col overflow-y-auto rounded-admin-box border border-border-default bg-bg-surface p-1 shadow-floating"
        >
          <button
            type="button"
            aria-pressed={value === null}
            onClick={() => {
              onChange(null);
              setOpen(false);
              trigger.current?.focus();
            }}
            className={MENU_ITEM}
          >
            {t.beachAll}
          </button>
          <button
            type="button"
            aria-pressed={value === BEACH_NONE}
            onClick={() => {
              onChange(BEACH_NONE);
              setOpen(false);
              trigger.current?.focus();
            }}
            className={MENU_ITEM}
          >
            {t.beachNoneOption}
          </button>
          {options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              aria-pressed={value === opt.id}
              onClick={() => {
                onChange(opt.id);
                setOpen(false);
                trigger.current?.focus();
              }}
              className={MENU_ITEM}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function receivedChipText(filter: ReceivedFilter): string {
  if (filter.preset === "today") return t.receivedToday;
  if (filter.preset === "7d") return t.received7d;
  if (filter.preset === "30d") return t.received30d;
  const fmt = (v?: string) => (v ? v.replace("T", " ").slice(5) : "");
  return fill(t.receivedRangeLabel, {
    from: fmt(filter.from),
    to: fmt(filter.to),
  });
}

function ReceivedFilterMenu({
  value,
  onChange,
}: {
  value: ReceivedFilter | null;
  onChange: (next: ReceivedFilter | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value?.from ?? "");
  const [to, setTo] = useState(value?.to ?? "");
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(open, setOpen, box, trigger);

  const presets: readonly {
    readonly key: "today" | "7d" | "30d";
    readonly label: string;
  }[] = [
    { key: "today", label: t.receivedToday },
    { key: "7d", label: t.received7d },
    { key: "30d", label: t.received30d },
  ];

  return (
    <div ref={box} className="relative">
      <FilterChipTrigger
        active={value !== null}
        label={
          value !== null
            ? fill(t.receivedChip, { label: receivedChipText(value) })
            : t.receivedFilter
        }
        clearLabel={fill(t.clearFilter, { label: t.receivedFilter })}
        open={open}
        triggerRef={trigger}
        onToggle={() => setOpen((v) => !v)}
        onClear={() => {
          onChange(null);
          setFrom("");
          setTo("");
          setOpen(false);
        }}
      />
      {open && (
        <div
          role="group"
          aria-label={t.receivedMenu}
          className="absolute top-full left-0 z-20 mt-1 flex min-w-64 flex-col gap-1 rounded-admin-box border border-border-default bg-bg-surface p-2 shadow-floating"
        >
          <button
            type="button"
            aria-pressed={value === null}
            onClick={() => {
              onChange(null);
              setOpen(false);
              trigger.current?.focus();
            }}
            className={MENU_ITEM}
          >
            {t.receivedAll}
          </button>
          {presets.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={value?.preset === p.key}
              onClick={() => {
                onChange({ preset: p.key });
                setOpen(false);
                trigger.current?.focus();
              }}
              className={MENU_ITEM}
            >
              {p.label}
            </button>
          ))}
          <div className="mt-1 flex flex-col gap-2 border-t border-border-default pt-2">
            <span className="px-1 text-caption font-semibold text-text-muted">
              {t.receivedCustom}
            </span>
            <label className="flex flex-col gap-1 px-1 text-caption text-text-body">
              {t.receivedFrom}
              <input
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-8 rounded-admin-control border border-border-strong bg-bg-surface px-2 text-body-s text-text-default"
              />
            </label>
            <label className="flex flex-col gap-1 px-1 text-caption text-text-body">
              {t.receivedTo}
              <input
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-8 rounded-admin-control border border-border-strong bg-bg-surface px-2 text-body-s text-text-default"
              />
            </label>
            <Button
              size="small"
              disabled={from.trim() === "" && to.trim() === ""}
              onClick={() => {
                onChange({ preset: "custom", from, to });
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              {t.receivedApply}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// 상태 탭: 탭을 누르면 그 상태 첫 쪽부터 다시 읽음
function StatusTabs({
  status,
  counts,
  onChange,
}: {
  status: InquiryStatus | null;
  counts: InquiryCounts | null;
  onChange: (next: InquiryStatus | null) => void;
}) {
  const total = counts
    ? INQUIRY_STATUSES.reduce((sum, s) => sum + counts[s], 0)
    : null;
  const tabs: {
    key: InquiryStatus | null;
    label: string;
    count: number | null;
  }[] = [
    ...INQUIRY_STATUSES.map((s) => ({
      key: s,
      label: t.status[s],
      count: counts ? counts[s] : null,
    })),
    { key: null, label: t.all, count: total },
  ];
  return (
    <div
      role="group"
      aria-label={t.tabsLabel}
      className="mt-2 flex gap-6 overflow-x-auto border-b border-border-default"
    >
      {tabs.map((tab) => {
        const on = tab.key === status;
        return (
          <button
            key={tab.key ?? "all"}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(tab.key)}
            className={`-mb-px flex min-h-touch shrink-0 items-center gap-1.5 border-b-2 px-0.5 py-2 text-body font-medium whitespace-nowrap lg:min-h-admin-control ${
              on
                ? "border-brand-default text-brand-default"
                : "border-transparent text-text-muted hover:text-text-default"
            }`}
          >
            {tab.label}
            {tab.count !== null && (
              <span className="font-normal text-text-muted tabular-nums">
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function InquiryList({
  beaches,
  selectedId,
  saved,
  detailMessages,
  onOpen,
  onVisibleIds,
}: {
  beaches: Beaches;
  selectedId: string | null;
  saved: SavedMap;
  detailMessages: Readonly<Record<string, string>>;
  onOpen: (id: string) => void;
  onVisibleIds: (ids: readonly string[]) => void;
}) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const [status, setStatus] = useState<InquiryStatus | null>(null);
  const [filter, setFilter] = useState<InquiryFilter>(EMPTY_INQUIRY_FILTER);
  const [filterPage, setFilterPage] = useState(0);
  // 지나온 쪽의 cursor. 첫 쪽은 null. 이전으로 가면 하나 뺌
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  // 거르기 중 '다음 목록 더 불러오기'로 이어 붙인 추가 쪽
  const [extra, setExtra] = useState<{
    key: string;
    items: InquirySummary[];
    nextCursor: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // 상태별 수와 받은 시각(이 시각 뒤의 저장만 탭 수에 더함. 그 전 저장은 서버 수에 이미 들었을 수 있음)
  const [received, setReceived] = useState<{
    counts: InquiryCounts;
    at: number;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const cursor = cursors.at(-1) ?? null;
  // 받은 응답을 요청 조건과 함께 둠. 조건이 바뀌면 응답이 올 때까지 '불러오는 중'
  // 다시 로그인하면(generation이 늚) 'reauth'로 끝난 읽기를 저절로 다시 함
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  const owner = badgeOwner(snapshot);
  const key = `${status ?? "all"}|${cursor ?? ""}|${attempt}|${generation}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: OpsResult<InquiryPage>;
  } | null>(null);
  const result = loaded?.key === key ? loaded.result : null;

  useEffect(() => {
    let live = true;
    void fetchInquiries(() => session.accessToken(), {
      ...(status ? { status } : {}),
      ...(cursor ? { cursor } : {}),
    }).then((next) => {
      if (!live) return;
      setLoaded({ key, result: next });
      if (next.ok && next.body.counts) {
        setReceived({ counts: next.body.counts, at: Date.now() });
        if (owner) setReceivedCount(owner, next.body.counts.received);
      }
    });
    return () => {
      live = false;
    };
  }, [session, status, cursor, key, owner]);

  const changeStatus = (next: InquiryStatus | null) => {
    setStatus(next);
    setCursors([null]);
    setExtra(null);
    setFilterPage(0);
  };

  const updateFilter = (next: InquiryFilter) => {
    setFilter(next);
    setFilterPage(0);
  };

  const pageIndex = cursors.length - 1;
  const activeExtra = extra?.key === key ? extra : null;
  const rawLoadedItems = useMemo(() => {
    if (!result?.ok) return [];
    const base = result.body.items;
    return activeExtra ? [...base, ...activeExtra.items] : base;
  }, [result, activeExtra]);

  // 저장한 상태로 바꿔 보이고, 고른 탭과 맞지 않게 된 문의는 이 탭에서 뺌(예: 접수 탭에서 완료로 저장)
  const loadedItems = useMemo(
    () =>
      rawLoadedItems
        .map((item) => withSaved(item, saved))
        .filter((item) => !status || item.status === status),
    [rawLoadedItems, saved, status],
  );

  const lastNextCursor = activeExtra
    ? activeExtra.nextCursor
    : result?.ok
      ? result.body.nextCursor
      : null;

  const isFiltered = hasActiveInquiryFilter(filter);

  const filteredItems = useMemo(() => {
    if (!isFiltered) return loadedItems;
    return filterInquiries(loadedItems, filter, {
      beachName: (id) => beachText(id, beaches),
      typeLabel,
      activityLabel,
      messages: detailMessages,
    });
  }, [isFiltered, loadedItems, filter, beaches, detailMessages]);

  const items = useMemo(
    () =>
      isFiltered
        ? pageRows(filteredItems, filterPage, PAGE_SIZE)
        : loadedItems,
    [isFiltered, filteredItems, filterPage, loadedItems],
  );

  useEffect(() => {
    onVisibleIds(items.map((i) => i.inquiryId));
  }, [items, onVisibleIds]);

  const availableTypes = useMemo(() => {
    const known = Object.keys(t.type);
    const extras = loadedItems
      .map((i) => i.type)
      .filter((kind) => !known.includes(kind));
    return [...known, ...Array.from(new Set(extras))];
  }, [loadedItems]);

  const availableBeaches = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of loadedItems) {
      if (item.beachId && !map.has(item.beachId)) {
        map.set(item.beachId, beachText(item.beachId, beaches));
      }
    }
    return Array.from(map.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, "ko"));
  }, [loadedItems, beaches]);

  const loadMoreForFilter = () => {
    if (!lastNextCursor || loadingMore) return;
    setLoadingMore(true);
    const targetKey = key;
    void fetchInquiries(() => session.accessToken(), {
      ...(status ? { status } : {}),
      cursor: lastNextCursor,
    })
      .then((next) => {
        if (!next.ok) return;
        setExtra((prev) => {
          const prevItems = prev?.key === targetKey ? prev.items : [];
          return {
            key: targetKey,
            items: [...prevItems, ...next.body.items],
            nextCursor: next.body.nextCursor,
          };
        });
      })
      .finally(() => setLoadingMore(false));
  };

  const counts = received
    ? adjustCounts(received.counts, received.at, saved)
    : null;
  const total = counts
    ? status
      ? counts[status]
      : INQUIRY_STATUSES.reduce((sum, s) => sum + counts[s], 0)
    : null;
  const from = pageIndex * PAGE_SIZE + 1;
  const to = pageIndex * PAGE_SIZE + items.length;
  const totalPages =
    total !== null ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null;
  const filterWin = pageWindow(filteredItems.length, filterPage, PAGE_SIZE);

  return (
    <section aria-labelledby="inquiries-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h1
          id="inquiries-title"
          className="text-title-l font-semibold text-text-default"
        >
          {t.title}
        </h1>
        {snapshot.status !== "signed_out" && snapshot.pool === "demo" && (
          <span className="rounded-admin-badge bg-info-bg px-1.5 text-caption font-semibold text-info-fg ring-1 ring-border-default">
            {t.sample}
          </span>
        )}
        <p className="w-full text-body-s text-text-muted">{t.description}</p>
      </div>

      <StatusTabs status={status} counts={counts} onChange={changeStatus} />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-[260px]">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-muted"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            value={filter.query}
            onChange={(e) => updateFilter({ ...filter, query: e.target.value })}
            placeholder={t.searchPlaceholder}
            aria-label={t.searchLabel}
            className="h-touch w-full rounded-admin-control border border-border-strong bg-bg-surface pr-3 pl-8 text-body text-text-default shadow-card outline-none placeholder:text-text-muted focus:border-brand-default focus:ring-[3px] focus:ring-brand-border lg:h-9"
          />
        </div>
        <TypeFilterMenu
          value={filter.type}
          types={availableTypes}
          onChange={(type) => updateFilter({ ...filter, type })}
        />
        <BeachFilterMenu
          value={filter.beach}
          options={availableBeaches}
          onChange={(beach) => updateFilter({ ...filter, beach })}
        />
        <ReceivedFilterMenu
          value={filter.received}
          onChange={(receivedFilter) =>
            updateFilter({ ...filter, received: receivedFilter })
          }
        />
        {isFiltered && result?.ok && (
          <span className="ml-auto text-body-s text-text-muted tabular-nums">
            {fill(t.filteredCount, { count: filteredItems.length })}
          </span>
        )}
      </div>

      {result === null && (
        <p role="status" className="text-body-s text-text-muted">
          {t.loading}
        </p>
      )}
      {result && !result.ok && (
        <Failure
          title={t.listError}
          result={result}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      )}
      {/* 거르기 결과가 비었을 때: 아직 불러오지 않은 목록이 있으면 '문의 없음'으로 보이지 않게 안내 */}
      {result?.ok && isFiltered && filteredItems.length === 0 && (
        <div className="rounded-admin-box border border-border-default bg-bg-surface px-4 py-6 text-center">
          <p className="text-title-s font-semibold text-text-default">
            {t.emptyTitle}
          </p>
          <p className="mt-1 text-body-s text-text-muted">
            {lastNextCursor
              ? fill(t.emptyFilteredMore, { loaded: loadedItems.length })
              : t.emptyFiltered}
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {lastNextCursor && (
              <Button
                variant="secondary"
                size="small"
                disabled={loadingMore}
                onClick={loadMoreForFilter}
              >
                {loadingMore ? t.loadingMore : t.loadMore}
              </Button>
            )}
            <Button
              variant="secondary"
              size="small"
              onClick={() => updateFilter(EMPTY_INQUIRY_FILTER)}
            >
              {t.resetFilters}
            </Button>
          </div>
        </div>
      )}
      {/* 첫 쪽이 비면 '문의가 없어요'. 다음 쪽만 비면(그사이 지워짐·상태 경계) 이전으로 돌아가게 안내하고 쪽 넘기기는 남김 */}
      {result?.ok && !isFiltered && items.length === 0 && pageIndex === 0 && (
        <div className="rounded-admin-box border border-border-default bg-bg-surface px-4 py-6 text-center">
          <p className="text-title-s font-semibold text-text-default">
            {t.emptyTitle}
          </p>
          <p className="mt-1 text-body-s text-text-muted">
            {status
              ? fill(t.emptyStatus, { status: t.status[status] })
              : t.emptyAll}
          </p>
        </div>
      )}
      {result?.ok && !isFiltered && items.length === 0 && pageIndex > 0 && (
        <Notice tone="neutral" title={t.emptyPage} role="status" />
      )}
      {result?.ok && items.length > 0 && (
        <>
          {/* 태블릿·PC: 공통 표 */}
          <div className="hidden md:block">
            <DataTable
              caption={t.title}
              head={
                <>
                  <th scope="col" className={TH}>
                    {t.colStatus}
                  </th>
                  <th scope="col" className={TH}>
                    {t.colTypeContent}
                  </th>
                  <th scope="col" className={TH}>
                    {t.colBeach}
                  </th>
                  <th scope="col" className={`${TH} ${CELL_END}`}>
                    {t.colReceivedShort}
                  </th>
                </>
              }
            >
              {items.map((item) => {
                const on = item.inquiryId === selectedId;
                const preview = previewText(detailMessages[item.inquiryId]);
                return (
                  <tr
                    key={item.inquiryId}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("a, button")) return;
                      onOpen(item.inquiryId);
                    }}
                    className={`${TR} cursor-pointer ${
                      on ? "bg-brand-weak" : "hover:bg-bg-page"
                    }`}
                  >
                    <td
                      className={`${TD} ${
                        on
                          ? "shadow-[inset_3px_0_0_var(--color-brand-default)]"
                          : ""
                      }`}
                    >
                      <StatusBadge status={item.status} />
                    </td>
                    <td className={`${TD} max-w-md whitespace-normal`}>
                      <Link
                        href={detailHref(item.inquiryId)}
                        aria-current={on ? "true" : undefined}
                        aria-label={fill(t.open, {
                          type: typeLabel(item.type),
                          status: isInquiryStatus(item.status)
                            ? t.status[item.status]
                            : item.status,
                          received: kstDateTime(item.receivedAt),
                        })}
                        className={`${CELL_NAME} block underline-offset-2 hover:underline`}
                      >
                        {typeLabel(item.type)}
                      </Link>
                      <span
                        className="block max-w-[320px] truncate text-caption text-text-muted"
                        aria-hidden={preview === null ? "true" : undefined}
                      >
                        {preview ?? "\u00a0"}
                      </span>
                    </td>
                    <td className={TD}>
                      <BeachActivity item={item} beaches={beaches} />
                    </td>
                    <td
                      className={`${TD} ${CELL_END} text-caption text-text-muted tabular-nums`}
                    >
                      {kstDateTime(item.receivedAt)}
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          </div>

          {/* 모바일: 카드 목록(값은 빼지 않음) */}
          <ul className="flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface md:hidden">
            {items.map((item) => {
              const preview = previewText(detailMessages[item.inquiryId]);
              return (
                <li key={item.inquiryId}>
                  <Link
                    href={detailHref(item.inquiryId)}
                    className="flex min-h-touch flex-col gap-1 px-4 py-3 hover:bg-bg-page"
                  >
                    <span className="flex items-center gap-2 text-label-s text-text-muted">
                      <StatusBadge status={item.status} />
                      <span className="tabular-nums">
                        {kstDateTime(item.receivedAt)}
                      </span>
                    </span>
                    <span className="text-body font-medium text-text-default">
                      {typeLabel(item.type)}
                    </span>
                    <span
                      className="truncate text-caption text-text-muted"
                      aria-hidden={preview === null ? "true" : undefined}
                    >
                      {preview ?? "\u00a0"}
                    </span>
                    <span className="text-body-s text-text-body">
                      <BeachActivity item={item} beaches={beaches} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>

          <p className="text-caption text-text-muted">{t.n1FooterHint}</p>
        </>
      )}
      {result?.ok && isFiltered && filteredItems.length > 0 && (
        <div className="flex flex-col gap-2">
          <Pager
            label={t.pagination}
            total={filteredItems.length}
            page={filterWin.page}
            size={PAGE_SIZE}
            onPage={setFilterPage}
          />
          {lastNextCursor && (
            <div className="flex flex-wrap items-center gap-2 text-caption text-text-muted">
              <span>
                {fill(t.loadedFilterHint, { loaded: loadedItems.length })}
              </span>
              <Button
                variant="secondary"
                size="small"
                disabled={loadingMore}
                onClick={loadMoreForFilter}
              >
                {loadingMore ? t.loadingMore : t.loadMore}
              </Button>
            </div>
          )}
        </div>
      )}
      {result?.ok && !isFiltered && (items.length > 0 || pageIndex > 0) && (
        <nav
          aria-label={t.pagination}
          className="mt-1 flex items-center gap-2 text-label-s text-text-muted"
        >
          <span className="tabular-nums">
            {/* 빈 쪽은 범위를 보여 주지 않음(21–20처럼 거꾸로 되지 않게) */}
            {items.length > 0 &&
              (total !== null
                ? fill(t.range, { total, from, to })
                : fill(t.rangeNoTotal, { from, to }))}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            aria-disabled={pageIndex === 0}
            aria-label={fill(messages.table.prevLabel, { label: t.pagination })}
            onClick={() =>
              pageIndex > 0 && setCursors((c) => c.slice(0, -1))
            }
            className="inline-flex min-h-touch items-center justify-center rounded-admin-control border border-border-strong bg-bg-surface px-2.5 text-body-s font-medium whitespace-nowrap text-text-default shadow-card hover:bg-bg-page aria-disabled:cursor-not-allowed aria-disabled:opacity-45 lg:h-8 lg:min-h-0"
          >
            {t.prev}
          </button>
          {totalPages !== null && (
            <span aria-current="page" className="text-text-body tabular-nums">
              {fill(messages.table.pageOf, {
                page: pageIndex + 1,
                pages: totalPages,
              })}
            </span>
          )}
          <button
            type="button"
            aria-disabled={!result.body.nextCursor}
            aria-label={fill(messages.table.nextLabel, { label: t.pagination })}
            onClick={() => {
              const next = result.body.nextCursor;
              if (next) setCursors((c) => [...c, next]);
            }}
            className="inline-flex min-h-touch items-center justify-center rounded-admin-control border border-border-strong bg-bg-surface px-2.5 text-body-s font-medium whitespace-nowrap text-text-default shadow-card hover:bg-bg-page aria-disabled:cursor-not-allowed aria-disabled:opacity-45 lg:h-8 lg:min-h-0"
          >
            {t.next}
          </button>
        </nav>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 text-body">
      <dt className="shrink-0 text-text-muted">{label}</dt>
      <dd className="text-right text-text-default">{children}</dd>
    </div>
  );
}

// 바꿀 수 있는지: 운영자 풀의 편집·노출 변경 권한만. 서버가 요청마다 다시 확인함(D16-A7)
// 권한이 없어도 숨기지 않고 비활성 + 안내(10/16 결정)
function useEditBlock(): string | null {
  const snapshot = useSessionSnapshot();
  if (snapshot.status === "signed_out") return t.needEditor;
  if (snapshot.pool === "demo") return t.demoReadOnly;
  return snapshot.groups.some((g) => g === "editor" || g === "publisher")
    ? null
    : t.needEditor;
}

const charCount = (text: string) => [...text].length;

type SaveError =
  | { kind: "conflict" }
  | { kind: "replay" }
  | { kind: "expired" }
  | { kind: "reason" }
  | { kind: "failed"; requestId: string | null };

// 처리: 상태(접수·확인 중·완료·반려)·반려 이유·내부 메모 (D16-D5·D6, 시안 V20·E6 3~5·E11 6·8)
// - 화면 상태를 먼저 바꾸지 않음: 저장이 성공해야 상세를 다시 읽어 바뀐 값을 보여 줌
// - 같은 내용을 다시 보내면(응답을 못 받음) 같은 멱등 키 → 서버가 한 번만 저장
function InquiryActions({
  item,
  rebase,
  leftFooter,
  onSaved,
  onReload,
}: {
  item: InquiryDetail;
  // 내가 개인정보 가리기로 저장한 version 앞(from)·뒤(to). 상태·메모는 그대로라 쓰던 내용을 두고 기준만 옮김
  // 초안 기준이 from일 때만 옮김(이미 낡은 초안은 충돌 안내를 그대로 둠)
  rebase: { from: number; to: number } | null;
  leftFooter?: ReactNode;
  onSaved: (saved: Pick<Saved, "status" | "version">, from: string) => void;
  onReload: () => void;
}) {
  const session = useAuthSession();
  const block = useEditBlock();
  // 쓰는 중인 값의 기준이 된 상세. 상세를 다시 읽어도(다시 로그인·저장 뒤) 쓰던 내용을 조용히 지우지 않음
  const [base, setBase] = useState(item);
  const known = isInquiryStatus(base.status);
  const [status, setStatus] = useState<InquiryStatus | null>(
    known ? (base.status as InquiryStatus) : null,
  );
  const [reason, setReason] = useState(base.rejectReason ?? "");
  const [memo, setMemo] = useState(base.memo ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);
  const [copied, setCopied] = useState(false);
  // 내가 저장해 받은 version, 또는 '새 내용 불러오기'를 눌러 다음 상세를 그대로 받기로 함
  const [accept, setAccept] = useState<number | "next" | null>(null);
  // 마지막으로 보낸 내용과 그 멱등 키. 내용이 같으면 키를 다시 씀
  const attempt = useRef<{ body: string; key: string } | null>(null);

  const statusChanged = status !== null && status !== base.status;
  const reasonChanged =
    status === "rejected" && reason.trim() !== (base.rejectReason ?? "");
  // 공백만 남긴 메모는 '메모 없음'(null)과 같음 → 바뀐 내용으로 세지 않음
  const memoValue = memo.trim() === "" ? null : memo;
  const memoChanged = memoValue !== (base.memo ?? null);
  const changes =
    (statusChanged ? 1 : 0) + (reasonChanged ? 1 : 0) + (memoChanged ? 1 : 0);

  const adopt = (next: InquiryDetail) => {
    setBase(next);
    setStatus(
      isInquiryStatus(next.status) ? (next.status as InquiryStatus) : null,
    );
    setReason(next.rejectReason ?? "");
    setMemo(next.memo ?? "");
    setAccept(null);
    setError(null);
    // 멱등 키는 보낼 내용이 바뀌면 save()가 새로 만듦(여기서 ref를 건드리지 않음: 그리는 중에도 불림)
  };
  // 상세가 새 version으로 바뀜: 내가 저장했거나·불러오기를 눌렀거나·쓰던 게 없으면 새 값으로 바꿈
  // 쓰던 게 있는데 남이 바꿨으면 그대로 두고 아래에서 알림(저장하면 서버가 409로 막음)
  if (
    item.version !== base.version &&
    (accept === item.version || accept === "next" || changes === 0)
  ) {
    adopt(item);
  } else if (
    rebase !== null &&
    item.version === rebase.to &&
    base.version === rebase.from
  ) {
    setBase(item);
  }
  const stale = item.version !== base.version;

  const reasonMissing = status === "rejected" && reason.trim() === "";
  // 반려 이유는 반려일 때만 보내므로 길이도 그때만 봄
  const reasonTooLong =
    status === "rejected" && charCount(reason) > REJECT_REASON_MAX;
  const memoTooLong = charCount(memo) > MEMO_MAX;
  // 저장한 뒤 그 version을 다시 읽어 올 때까지 잠금(그사이 쓴 내용이 새 값으로 덮이지 않게)
  const waiting = typeof accept === "number";
  const disabled = block !== null || busy || waiting;

  const save = () => {
    if (block || busy || changes === 0) return;
    if (reasonMissing) {
      setError({ kind: "reason" });
      return;
    }
    if (reasonTooLong || memoTooLong) return;
    const patch: InquiryPatch = {
      // 쓰기 시작한 기준 version. 그사이 바뀌었으면 서버가 409로 막음(덮어쓰지 않음)
      version: base.version,
      // 반려 이유만 고쳐도 서버 규칙상 반려 상태와 함께 보냄
      ...(statusChanged || reasonChanged ? { status: status! } : {}),
      ...((statusChanged || reasonChanged) && status === "rejected"
        ? { rejectReason: reason.trim() }
        : {}),
      ...(memoChanged ? { memo: memoValue } : {}),
    };
    const body = JSON.stringify(patch);
    if (attempt.current?.body !== body) {
      attempt.current = { body, key: crypto.randomUUID() };
    }
    const { key } = attempt.current;
    setBusy(true);
    setError(null);
    void saveInquiry(() => session.accessToken(), item.inquiryId, patch, key)
      .then((result) => {
        if (result.ok) {
          attempt.current = null;
          setAccept(result.body.version);
          onSaved(
            {
              status: patch.status ?? (base.status as InquiryStatus),
              version: result.body.version,
            },
            base.status,
          );
          return;
        }
        if (result.code === "reauth") {
          // 다시 로그인 창이 뜸. 로그인한 뒤 같은 키로 다시 누르면 한 번만 저장됨
          setError({ kind: "failed", requestId: null });
        } else if (result.status === 409) {
          setError({
            kind:
              result.reason === "idempotency_mismatch" ? "replay" : "conflict",
          });
        } else if (result.status === 404) {
          setError({ kind: "expired" });
        } else if (result.status === 400 && result.field === "rejectReason") {
          setError({ kind: "reason" });
        } else {
          setError({
            kind: "failed",
            requestId: "requestId" in result ? result.requestId : null,
          });
        }
      })
      .finally(() => setBusy(false));
  };

  const fieldClass =
    "w-full rounded-admin-control border border-border-strong bg-bg-surface px-2.5 py-2 text-body text-text-default outline-none placeholder:text-text-muted focus:border-brand-default focus:ring-[3px] focus:ring-brand-border disabled:bg-bg-page disabled:text-text-muted";

  return (
    <section
      aria-labelledby="inquiry-actions"
      className="flex flex-col gap-5"
    >
      <h3 id="inquiry-actions" className="sr-only">
        {t.editTitle}
      </h3>
      {block && <Notice tone="neutral" title={block} />}

      <fieldset disabled={disabled} className="flex flex-col gap-2">
        <legend className="mb-1.5 text-body font-medium text-text-default">
          {t.statusLegend}
        </legend>
        <div className="grid grid-cols-4 divide-x divide-border-strong overflow-hidden rounded-admin-control border border-border-strong shadow-card">
          {INQUIRY_STATUSES.map((s) => (
            <label
              key={s}
              className="flex min-h-touch cursor-pointer items-center justify-center bg-bg-surface text-body-s font-medium text-text-body has-checked:bg-bg-page has-checked:font-semibold has-checked:text-text-default has-focus-visible:ring-[3px] has-focus-visible:ring-brand-border has-disabled:cursor-not-allowed lg:h-[34px] lg:min-h-0"
            >
              <input
                type="radio"
                name="inquiry-status"
                value={s}
                checked={status === s}
                onChange={() => {
                  setStatus(s);
                  setError(null);
                }}
                className="sr-only"
              />
              {t.status[s]}
            </label>
          ))}
        </div>
      </fieldset>

      {status === "rejected" && (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="reject-reason"
            className="text-body font-medium text-text-default"
          >
            {t.rejectReason}
          </label>
          <textarea
            id="reject-reason"
            rows={3}
            value={reason}
            disabled={disabled}
            aria-invalid={
              reasonMissing && error?.kind === "reason" ? true : undefined
            }
            aria-describedby="reject-reason-hint"
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
            className={fieldClass}
          />
          <p id="reject-reason-hint" className="text-label-s text-text-muted">
            {error?.kind === "reason" ? (
              <span className="text-danger-text">{t.rejectReasonRequired}</span>
            ) : reasonTooLong ? (
              <span className="text-danger-text">
                {fill(t.tooLong, {
                  max: REJECT_REASON_MAX,
                  count: charCount(reason),
                })}
              </span>
            ) : (
              t.rejectReasonHint
            )}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="inquiry-memo"
          className="flex items-center gap-1.5 text-body font-medium text-text-default"
        >
          <span>{t.memo}</span>
          <span className="text-body-s font-normal text-text-muted">
            {t.memoInternal}
          </span>
        </label>
        <textarea
          id="inquiry-memo"
          rows={4}
          value={memo}
          disabled={disabled}
          aria-describedby="inquiry-memo-hint"
          onChange={(e) => {
            setMemo(e.target.value);
            setError(null);
          }}
          className={fieldClass}
        />
        <p id="inquiry-memo-hint" className="text-label-s text-text-muted">
          {memoTooLong ? (
            <span className="text-danger-text">
              {fill(t.tooLong, { max: MEMO_MAX, count: charCount(memo) })}
            </span>
          ) : (
            t.memoHint
          )}
        </p>
      </div>

      {stale && (
        <Notice tone="warn" title={t.staleDraft} role="alert">
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="small"
              onClick={() => adopt(item)}
            >
              {t.reload}
            </Button>
            {memoChanged && (
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(memo)
                    .then(() => setCopied(true));
                }}
              >
                {copied ? t.copied : t.copyMemo}
              </Button>
            )}
          </div>
        </Notice>
      )}
      {error && error.kind !== "reason" && (
        <Notice
          tone={error.kind === "failed" ? "fail" : "warn"}
          title={
            error.kind === "conflict"
              ? t.conflictVersion
              : error.kind === "replay"
                ? t.conflictReplay
                : error.kind === "expired"
                  ? t.expired
                  : fill(t.saveFailed, {
                      status: known
                        ? t.status[base.status as InquiryStatus]
                        : base.status,
                    })
          }
          role="alert"
        >
          {error.kind === "failed" && (
            <>
              <p>{t.saveFailedHint}</p>
              {error.requestId && (
                <p>{fill(t.requestId, { id: error.requestId })}</p>
              )}
            </>
          )}
          {(error.kind === "conflict" || error.kind === "replay") && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="small"
                onClick={() => {
                  setAccept("next");
                  onReload();
                }}
              >
                {t.reload}
              </Button>
              {error.kind === "conflict" && memoChanged && (
                <Button
                  variant="secondary"
                  size="small"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(memo)
                      .then(() => setCopied(true));
                  }}
                >
                  {copied ? t.copied : t.copyMemo}
                </Button>
              )}
            </div>
          )}
        </Notice>
      )}

      {/* 시트 바닥 바(시안 V20 .w-df): 왼쪽 가리기(삭제 API 전까지 지우기 숨김), 오른쪽 바뀐 내용·저장 */}
      <div className="sticky bottom-0 -mx-6 -mb-5 flex flex-wrap items-center gap-2 border-t border-border-default bg-bg-surface px-6 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]">
        {leftFooter}
        <span className="flex-1" />
        <span className="text-caption text-text-muted" aria-live="polite">
          {busy || waiting
            ? t.saving
            : changes > 0
              ? fill(t.changes, { count: changes })
              : t.noChanges}
        </span>
        <Button
          size="small"
          disabled={disabled || changes === 0 || reasonTooLong || memoTooLong}
          onClick={save}
        >
          {t.save}
        </Button>
      </div>
    </section>
  );
}

// 개인정보 가리기(화면 설계서 6장 ADM-INQ: 내용에 이름·전화번호가 섞이면 그 부분을 지워 저장)
// - 읽기 전용 칸에서 선택한 부분을 서버가 '[가림]'으로 바꿈. 한 번에 한 부분, 확인을 거쳐 바로 저장
// - 원래 글은 되돌릴 수 없고 변경 이력에도 남기지 않음(D16-B5)
// - 상세가 새 version이 되면 key가 바뀌어 처음 상태로 돌아감
function InquiryMessage({
  item,
  mode,
  onModeChange,
  onRedacted,
  onReload,
}: {
  item: InquiryDetail;
  mode: "view" | "select" | "confirm";
  onModeChange: (next: "view" | "select" | "confirm") => void;
  onRedacted: (from: number, to: number) => void;
  onReload: () => void;
}) {
  const session = useAuthSession();
  const block = useEditBlock();
  const message = item.message ?? "";
  const [range, setRange] = useState<Redaction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SaveError | { kind: "changed" } | null>(
    null,
  );
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const shown = linesNormalized(message);
  // 고른 범위: 브라우저 select 이벤트(끌기·키보드·터치 모두)를 직접 들음
  // React onSelect는 마우스·키 입력 뒤에만 다시 읽어 일부 선택 변경을 놓침
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const read = () => {
      setRange(redactionOf(message, el.selectionStart, el.selectionEnd));
      setError(null);
    };
    el.addEventListener("select", read);
    return () => el.removeEventListener("select", read);
  }, [message, mode]);

  const close = () => {
    onModeChange("view");
    setRange(null);
    setError(null);
  };

  const redact = () => {
    if (!range || busy || block) return;
    const patch: InquiryPatch = { version: item.version, redactions: [range] };
    const body = JSON.stringify(patch);
    if (attempt.current?.body !== body) {
      attempt.current = { body, key: crypto.randomUUID() };
    }
    const { key } = attempt.current;
    setBusy(true);
    setError(null);
    void saveInquiry(
      () => session.accessToken(),
      item.inquiryId,
      patch,
      key,
    ).then(
      (result) => {
        // 성공하면 새 상세를 받아 이 칸이 다시 그려질 때까지 잠가 둠(같은 가리기를 두 번 누르지 않게)
        if (result.ok) {
          attempt.current = null;
          onRedacted(patch.version, result.body.version);
          return;
        }
        setBusy(false);
        if (result.code === "reauth") {
          setError({ kind: "failed", requestId: null });
        } else if (result.status === 409) {
          setError({
            kind:
              result.reason === "idempotency_mismatch" ? "replay" : "conflict",
          });
        } else if (result.status === 404) {
          setError({ kind: "expired" });
        } else if (result.status === 400 && result.field === "redactions") {
          setError({ kind: "changed" });
        } else {
          setError({
            kind: "failed",
            requestId: "requestId" in result ? result.requestId : null,
          });
        }
      },
      () => {
        // 토큰 읽기 등에서 예외가 나도 잠긴 채로 두지 않음
        setBusy(false);
        setError({ kind: "failed", requestId: null });
      },
    );
  };

  return (
    <section aria-label={t.message} className="flex flex-col gap-2">
      {mode === "view" ? (
        <p className="text-body leading-relaxed whitespace-pre-wrap text-text-default">
          {message}
        </p>
      ) : (
        <>
          <p id="redact-hint" className="text-body-s text-text-body">
            {t.redactHint}
          </p>
          <textarea
            readOnly
            aria-label={t.message}
            aria-describedby="redact-hint redact-selected"
            value={shown}
            rows={Math.min(10, shown.split("\n").length + 1)}
            disabled={mode === "confirm"}
            ref={area}
            className="w-full resize-y rounded-admin-control border border-border-strong bg-bg-surface px-2.5 py-2 text-body leading-relaxed text-text-default outline-none selection:bg-brand-border focus:border-brand-default focus:ring-[3px] focus:ring-brand-border disabled:bg-bg-page"
          />
          <p
            id="redact-selected"
            aria-live="polite"
            className="text-label-s break-all text-text-muted"
          >
            {range
              ? fill(t.redactSelected, {
                  count: [...range.text].length,
                  text: `“${range.text}”`,
                })
              : t.redactNone}
          </p>
        </>
      )}

      {error && (
        <Notice
          tone={error.kind === "failed" ? "fail" : "warn"}
          title={
            error.kind === "changed" || error.kind === "conflict"
              ? t.redactChanged
              : error.kind === "replay"
                ? t.conflictReplay
                : error.kind === "expired"
                  ? t.expired
                  : t.redactFailed
          }
          role="alert"
        >
          {error.kind === "failed" && error.requestId && (
            <p>{fill(t.requestId, { id: error.requestId })}</p>
          )}
          {(error.kind === "changed" ||
            error.kind === "conflict" ||
            error.kind === "replay") && (
            <div className="mt-2">
              <Button variant="secondary" size="small" onClick={onReload}>
                {t.reload}
              </Button>
            </div>
          )}
        </Notice>
      )}

      {mode === "confirm" && range && (
        <Notice
          tone="warn"
          title={fill(t.redactConfirm, { count: [...range.text].length })}
          role="alert"
        >
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="small" disabled={busy} onClick={redact}>
              {busy ? t.saving : t.redactConfirmButton}
            </Button>
            <Button
              variant="secondary"
              size="small"
              disabled={busy}
              onClick={() => onModeChange("select")}
            >
              {t.redactCancel}
            </Button>
          </div>
        </Notice>
      )}

      {mode === "select" && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="small" onClick={close}>
            {t.redactCancel}
          </Button>
          <Button
            size="small"
            disabled={!range}
            onClick={() => onModeChange("confirm")}
          >
            {t.redactApply}
          </Button>
        </div>
      )}
    </section>
  );
}

function SheetHeader({
  status,
  inquiryId,
  type,
  showClose,
  onClose,
}: {
  status: string;
  inquiryId: string;
  type: string;
  showClose: boolean;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-border-default px-6 pt-5 pb-4">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-caption text-text-muted">
          <StatusBadge status={status} />
          <span>
            {t.id}{" "}
            <span title={inquiryId} className="font-mono">
              {shortId(inquiryId)}
            </span>
          </span>
        </p>
        <h2
          id="inquiry-type"
          className="mt-1.5 text-title-m font-semibold text-text-default"
        >
          {typeLabel(type)}
        </h2>
      </div>
      {showClose && (
        <>
          <span className="mt-1 hidden text-caption text-text-muted lg:inline">
            {t.sheetShortcuts}
          </span>
          <button
            type="button"
            aria-label={t.close}
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-admin-control text-text-body hover:bg-bg-page"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}

function InquiryDetailView({
  id,
  beaches,
  showClose,
  onClose,
  onSaved,
  onMessageLoaded,
}: {
  id: string;
  beaches: Beaches;
  showClose: boolean;
  onClose: () => void;
  onSaved: (inquiryId: string, saved: Saved) => void;
  onMessageLoaded: (inquiryId: string, message: string) => void;
}) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const block = useEditBlock();
  const [attempt, setAttempt] = useState(0);
  const [redactMode, setRedactMode] = useState<"view" | "select" | "confirm">(
    "view",
  );
  // 다시 로그인하면(generation이 늚) 'reauth'로 끝난 읽기를 저절로 다시 함
  const owner = badgeOwner(snapshot);
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  const key = `${id}|${attempt}|${generation}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: OpsResult<InquiryDetail>;
  } | null>(null);
  // 마지막으로 성공한 상세. 다시 읽는 중이거나 다시 읽기가 실패해도 이 내용과 쓰던 처리 칸을 그대로 둠
  const [good, setGood] = useState<{
    id: string;
    detail: InquiryDetail;
  } | null>(null);
  const current = loaded?.key === key ? loaded.result : null;
  const kept = good?.id === id ? good.detail : null;
  const result: OpsResult<InquiryDetail> | null = current?.ok
    ? current
    : kept
      ? { ok: true, status: 200, body: kept }
      : current;
  // 앞서 받은 내용을 보이는 채로 다시 읽기만 실패함 → 내용 위에 실패만 알림
  const refreshFailure = kept && current && !current.ok ? current : null;
  // 저장 성공 안내. 다시 읽은 뒤에도 남김(다른 문의를 열면 사라짐)
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(
    null,
  );
  // 내가 개인정보 가리기로 저장한 version(처리 칸이 쓰던 내용을 두고 기준만 옮기게)
  const [redacted, setRedacted] = useState<{
    id: string;
    from: number;
    to: number;
  } | null>(null);

  useEffect(() => {
    let live = true;
    void fetchInquiry(() => session.accessToken(), id).then((next) => {
      if (!live) return;
      setLoaded({ key, result: next });
      if (next.ok) {
        setGood({ id, detail: next.body });
        if (!next.body.restricted && next.body.message !== undefined) {
          onMessageLoaded(id, next.body.message);
        }
      }
    });
    return () => {
      live = false;
    };
  }, [session, id, key, onMessageLoaded]);

  // 주소로 열었는데 없음(지워졌거나 90일 지남): 404
  if (result && !result.ok && result.status === 404) {
    return (
      <div className="flex flex-col items-start gap-2 px-6 py-6">
        <p className="text-title-s font-semibold text-text-default">
          {t.notFoundTitle}
        </p>
        <p className="text-body-s text-text-body">{t.notFoundBody}</p>
        <Button variant="secondary" size="small" onClick={onClose}>
          {t.backToList}
        </Button>
      </div>
    );
  }
  if (result && !result.ok) {
    return (
      <div className="px-6 py-6">
        <Failure
          title={t.detailError}
          result={result}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      </div>
    );
  }
  if (!result) {
    return (
      <p role="status" className="px-6 py-6 text-body-s text-text-muted">
        {t.loading}
      </p>
    );
  }

  const item = result.body;
  const beach = item.beachId ? beaches[item.beachId] : undefined;
  const messageText = item.message ?? "";

  const leftFooter = (
    <Button
      variant="secondary"
      size="small"
      disabled={
        block !== null ||
        item.restricted ||
        messageText === "" ||
        redactMode !== "view"
      }
      onClick={() => setRedactMode("select")}
    >
      {t.redactOpen}
    </Button>
  );

  return (
    <article
      aria-labelledby="inquiry-type"
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetHeader
        status={item.status}
        inquiryId={item.inquiryId}
        type={item.type}
        showClose={showClose}
        onClose={onClose}
      />

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-5">
        {refreshFailure &&
          (refreshFailure.status === 404 ? (
            <Notice tone="warn" title={t.notFoundTitle} role="alert">
              {t.notFoundBody}
            </Notice>
          ) : (
            <Failure
              title={t.detailError}
              result={refreshFailure}
              onRetry={() => setAttempt((n) => n + 1)}
            />
          ))}

        {item.legacy && (
          <Notice tone="neutral" title={t.legacyTitle}>
            {t.legacyBody}
          </Notice>
        )}

        {item.restricted ? (
          <Notice tone="neutral" title={t.restricted} />
        ) : (
          <InquiryMessage
            key={`${item.inquiryId}|${item.version}`}
            item={item}
            mode={redactMode}
            onModeChange={setRedactMode}
            onReload={() => {
              setNotice(null);
              setRedactMode("view");
              setAttempt((n) => n + 1);
            }}
            onRedacted={(from, to) => {
              setRedacted({ id, from, to });
              setRedactMode("view");
              setNotice({ id, text: t.redacted });
              setAttempt((n) => n + 1);
            }}
          />
        )}

        <dl className="divide-y divide-border-default border-t border-border-default">
          <Row label={t.beachActivity}>
            <BeachActivity item={item} beaches={beaches} />
            {beach && (
              <span className="ml-1 text-body-s text-text-muted">
                ({beach.region})
              </span>
            )}
            {item.type === "data_error" &&
              beach &&
              refreshFailure?.status !== 404 && (
                <Link
                  href={`/beaches/${item.beachId}/`}
                  aria-label={t.openBeach}
                  className="ml-1.5 font-medium text-brand-default underline underline-offset-2"
                >
                  {t.beachDetailShort}
                </Link>
              )}
          </Row>
          <Row label={t.received}>
            <span className="tabular-nums">
              {kstDateTime(item.receivedAt)}
              {isKstToday(item.receivedAt) ? ` · ${t.today}` : ""}
            </span>
          </Row>
          <Row label={t.retention}>
            {fill(t.retentionValue, { date: retentionDate(item.receivedAt) })}
          </Row>
          <Row label={t.contact}>{t.contactValue}</Row>
          {(item.restricted || item.updatedAt) && (
            <Row label={t.currentStatus}>
              <StatusBadge status={item.status} />
              {item.updatedAt && (
                <span className="ml-2 text-body-s text-text-muted">
                  {fill(t.updatedAt, { time: kstDateTime(item.updatedAt) })}
                </span>
              )}
            </Row>
          )}
        </dl>

        {notice?.id === id && (
          <Notice tone="success" title={notice.text} role="status" />
        )}

        {/* 보기 권한은 메모·반려 이유를 받지 않으므로 처리 칸을 그리지 않음(빈 칸을 실제 값처럼 보이지 않게) */}
        {item.restricted ? (
          <div className="sticky bottom-0 -mx-6 -mb-5 flex flex-wrap items-center gap-2 border-t border-border-default bg-bg-surface px-6 py-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]">
            {leftFooter}
          </div>
        ) : (
          <InquiryActions
            key={item.inquiryId}
            item={item}
            rebase={
              redacted?.id === id
                ? { from: redacted.from, to: redacted.to }
                : null
            }
            leftFooter={leftFooter}
            onReload={() => {
              setNotice(null);
              setAttempt((n) => n + 1);
            }}
            onSaved={(saved, from) => {
              onSaved(item.inquiryId, { ...saved, from, at: Date.now() });
              if (from === "received" && saved.status !== "received") {
                if (owner) adjustReceivedCount(owner, -1);
              } else if (from !== "received" && saved.status === "received") {
                if (owner) adjustReceivedCount(owner, 1);
              }
              setNotice({
                id,
                text:
                  saved.status !== from
                    ? fill(t.savedStatus, { status: t.status[saved.status] })
                    : t.savedMemo,
              });
              setAttempt((n) => n + 1);
            }}
          />
        )}
      </div>
    </article>
  );
}

// PC(1024 이상)인지. 정적 내보내기라 서버 렌더는 좁은 화면으로 보고 브라우저에서 다시 맞춤
const WIDE = "(min-width: 1024px)";
function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

// 닫힘 동작 시간(ms). 동작 줄이기를 켰으면 바로 닫음
const CLOSE_MS = 200;

// PC 상세: 목록 위에 뜨는 오른쪽 패널(모달 <dialog>). 목록은 움직이지 않고 뒤를 딤 처리함
// 열 때 오른쪽에서 밀려 들어오고 닫을 때 밀려 나감(@starting-style·allow-discrete). 동작 줄이기면 바로
// 포커스는 패널 안에 갇히고 Esc·바깥(딤) 누르기·닫기 버튼으로 닫음. 닫히면 포커스가 누른 줄로 돌아감
function DetailPanel({
  id,
  beaches,
  visibleIds,
  onNavigate,
  onClosed,
  onSaved,
  onMessageLoaded,
}: {
  id: string;
  beaches: Beaches;
  visibleIds: readonly string[];
  onNavigate: (nextId: string) => void;
  onClosed: () => void;
  onSaved: (inquiryId: string, saved: Saved) => void;
  onMessageLoaded: (inquiryId: string, message: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);
  const close = () => ref.current?.close();
  return (
    <dialog
      ref={ref}
      // 불러오는 중·실패에도 이름이 있게 고정 문구로 이름을 붙임
      aria-label={t.detailLabel}
      onClose={() => {
        // <dialog>는 닫힐 때 열기 전 포커스로 돌려주지만, Safari는 마우스로 누른 줄 링크에 포커스를 주지 않아
        // 돌아갈 곳이 문서 맨 앞이 됨 → 그 문의 줄 링크로 직접 돌려줌(목록은 패널 뒤에 그대로 있음)
        document
          .querySelector<HTMLAnchorElement>(
            `table a[href="${CSS.escape(detailHref(id))}"]`,
          )
          ?.focus();
        const reduce = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        window.setTimeout(onClosed, reduce ? 0 : CLOSE_MS);
      }}
      onKeyDown={(e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        const idx = visibleIds.indexOf(id);
        if (idx === -1) return;
        const nextIdx = e.key === "ArrowUp" ? idx - 1 : idx + 1;
        const nextId = visibleIds[nextIdx];
        if (nextId) {
          e.preventDefault();
          onNavigate(nextId);
        }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-[480px] max-w-full overflow-hidden border-l border-border-default bg-bg-surface p-0 text-text-default shadow-floating transition-[translate,overlay,display] transition-discrete duration-200 ease-out not-open:translate-x-full backdrop:bg-[rgb(11_26_44/0.4)] backdrop:transition-[opacity,overlay,display] backdrop:transition-discrete backdrop:duration-200 not-open:backdrop:opacity-0 starting:open:translate-x-full starting:open:backdrop:opacity-0 motion-reduce:transition-none motion-reduce:backdrop:transition-none"
    >
      <div className="flex h-full flex-col">
        <InquiryDetailView
          id={id}
          beaches={beaches}
          showClose={true}
          onClose={close}
          onSaved={onSaved}
          onMessageLoaded={onMessageLoaded}
        />
      </div>
    </dialog>
  );
}

function InquiriesBody({ beaches }: { beaches: Beaches }) {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id");
  const wide = useWide();
  const toList = useCallback(() => router.push("/inquiries/"), [router]);
  const openDetail = useCallback(
    (nextId: string) => router.push(detailHref(nextId)),
    [router],
  );
  const [saved, setSaved] = useState<SavedMap>({});
  const [detailMessages, setDetailMessages] = useState<
    Readonly<Record<string, string>>
  >({});
  const [visibleIds, setVisibleIds] = useState<readonly string[]>([]);
  const onSaved = useCallback(
    (inquiryId: string, next: Saved) =>
      setSaved((prev) => ({ ...prev, [inquiryId]: next })),
    [],
  );
  const onMessageLoaded = useCallback((inquiryId: string, message: string) => {
    setDetailMessages((prev) =>
      prev[inquiryId] === message ? prev : { ...prev, [inquiryId]: message },
    );
  }, []);

  return (
    <div className="px-4 py-5 md:px-10 md:pt-6 md:pb-10">
      {/* 좁은 화면: 상세를 열면 목록 대신 상세. PC: 목록은 그대로 두고 위에 패널 */}
      <div className={id && !wide ? "hidden" : undefined}>
        <InquiryList
          beaches={beaches}
          selectedId={id}
          saved={saved}
          detailMessages={detailMessages}
          onOpen={openDetail}
          onVisibleIds={setVisibleIds}
        />
      </div>
      {id && !wide && (
        <section aria-label={t.detailLabel} className="flex flex-col gap-3">
          <Link
            href="/inquiries/"
            className="flex min-h-touch items-center self-start text-body-s font-medium text-brand-default"
          >
            ← {t.backToList}
          </Link>
          <InquiryDetailView
            id={id}
            beaches={beaches}
            showClose={false}
            onClose={toList}
            onSaved={onSaved}
            onMessageLoaded={onMessageLoaded}
          />
        </section>
      )}
      {id && wide && (
        <DetailPanel
          key={id}
          id={id}
          beaches={beaches}
          visibleIds={visibleIds}
          onNavigate={openDetail}
          onClosed={toList}
          onSaved={onSaved}
          onMessageLoaded={onMessageLoaded}
        />
      )}
    </div>
  );
}

export function InquiriesScreen({ beaches }: { beaches: Beaches }) {
  return (
    <AdminShell title={t.title}>
      {/* 정적 내보내기라 주소 ?id= 는 브라우저에서 읽음(useSearchParams는 Suspense 안) */}
      <Suspense fallback={null}>
        <InquiriesBody beaches={beaches} />
      </Suspense>
    </AdminShell>
  );
}
