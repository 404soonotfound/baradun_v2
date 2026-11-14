"use client";

import {
  Check,
  ChevronRight,
  ChevronsUpDown,
  EyeOff,
  GitBranch,
  Plus,
  Search,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useSessionSnapshot } from "@/lib/auth/provider";
import {
  BEACHES_TREE_URL,
  BEACH_PAGE_SIZE,
  BEACH_TABS,
  beachListHref,
  delayedObservedAt,
  displayOf,
  isZoneVerified,
  parseBeachQuery,
  queryBeaches,
  sidoList,
  tabCounts,
  zoneDisplayName,
  zoneList,
  type BeachDisplay,
  type BeachListQuery,
  type BeachSeason,
  type BeachSummary,
  type BeachTab,
} from "@/lib/beaches";
import { kstClock } from "@/lib/collection";
import { kstDateTime } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import { pageRows, pageWindow } from "@/lib/paging";
import { AdminShell } from "./admin-shell";
import { DisplayBadge, PublishedAlert, usePublished } from "./beach-status";
import { CELL_END, CELL_NAME, DataTable, Pager, TD, TH, TR } from "./data-table";
import { Button, Notice } from "./ui";

// 해변 관리 목록 (GH-454 · BRD-150, 화면 설계서 6장 ADM-BCH, 시안 4차 V2·VM4·E7)
// - 읽기 전용: 편집 칸·노출 토글·일괄 변경·출입 통제 열 없음(D15-4 · G2)
// - 한 줄 표(11행/쪽) + 6개 상태·연결 탭 + 이름·별칭 찾기 + 지역·특보 구역 거르기 + 주소 쿼리 유지
// - 지금 표시 상태는 게시본 그대로(G1), 못 받으면 '확인 못 함'
// - 파고·파주기·측정 시각은 현재 응답에 실측값이 없어 값을 만들지 않고 관측소 연결 여부만 표시함

const t = messages.beaches;

type Published = ReturnType<typeof usePublished>["published"];

// 상세 화면(beach-detail-screen.tsx)에서도 함께 씀
export function seasonText(season: BeachSeason | null): string {
  if (!season) return t.seasonNone;
  if (season.status === "closed") {
    return fill(t.seasonClosed, { year: season.year });
  }
  // 개장인데 날짜가 비면 미개장으로 바꾸지 않음(결측을 다른 값으로 채우지 않음)
  if (!season.openDate || !season.closeDate) {
    return fill(t.seasonOpenNoDates, { year: season.year });
  }
  const md = (iso: string) => {
    const [, m, d] = iso.split("-");
    return `${Number(m)}.${Number(d)}`;
  };
  return fill(t.seasonOpen, {
    year: season.year,
    from: md(season.openDate),
    to: md(season.closeDate),
  });
}

const detailHref = (id: string) => `/beaches/${encodeURIComponent(id)}/`;

function HiddenBadge() {
  return (
    <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-admin-badge bg-info-bg px-1.5 text-label-s font-semibold whitespace-nowrap text-info-fg ring-1 ring-border-strong ring-inset">
      <EyeOff size={13} aria-hidden="true" />
      {t.hidden}
    </span>
  );
}

// 앱 표시 셀: 게시본 분류 그대로 + 비노출 배지(게시본 장애 시에는 '확인 못 함'도 함께 남김)
function StatusCell({
  beach,
  display,
  published,
}: {
  beach: BeachSummary;
  display: BeachDisplay;
  published: Published;
}) {
  if (!beach.hidden) {
    return <DisplayBadge display={display} compact />;
  }
  const unavailable =
    published !== "loading" && (!published || !published.available);
  if (unavailable || display.kind === "published") {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <HiddenBadge />
        <DisplayBadge display={display} compact />
      </span>
    );
  }
  return <HiddenBadge />;
}

// 열린 필터 메뉴를 바깥 클릭·Esc로 닫음(Esc는 여는 버튼으로 포커스 복귀)
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

const CHIP_IDLE =
  "inline-flex min-h-touch items-center gap-1.5 rounded-admin-control border border-dashed border-border-strong bg-bg-surface px-2.5 text-body-s font-medium whitespace-nowrap text-text-body hover:bg-bg-page lg:h-9 lg:min-h-0";
const CHIP_ACTIVE_BOX =
  "inline-flex min-h-touch items-center overflow-hidden rounded-admin-control border border-brand-border bg-brand-weak text-body-s font-medium whitespace-nowrap text-brand-default lg:h-9 lg:min-h-0";
const MENU_ITEM =
  "flex min-h-touch items-center rounded-admin-control px-2.5 text-left text-body-s text-text-default hover:bg-bg-page aria-pressed:font-semibold aria-pressed:text-brand-default lg:min-h-admin-control";

interface FilterOption {
  readonly value: string;
  readonly label: string;
}

function OptionFilterMenu({
  filterLabel,
  activeLabel,
  menuLabel,
  allLabel,
  value,
  options,
  onChange,
}: {
  filterLabel: string;
  activeLabel: string | null;
  menuLabel: string;
  allLabel: string;
  value: string | null;
  options: readonly FilterOption[];
  onChange: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(open, setOpen, box, trigger);

  return (
    <div ref={box} className="relative">
      {value === null ? (
        <button
          ref={trigger}
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={CHIP_IDLE}
        >
          <Plus size={14} aria-hidden="true" />
          {filterLabel}
        </button>
      ) : (
        <div className={CHIP_ACTIVE_BOX}>
          <button
            ref={trigger}
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex h-full items-center px-2.5 hover:bg-brand-border/20"
          >
            {activeLabel}
          </button>
          <button
            type="button"
            aria-label={fill(t.clearFilter, { label: filterLabel })}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className="flex h-full items-center border-l border-brand-border px-2 hover:bg-brand-border/20"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      )}
      {open && (
        <div
          role="group"
          aria-label={menuLabel}
          className="absolute top-full left-0 z-20 mt-1 flex max-h-72 min-w-48 flex-col overflow-y-auto rounded-admin-box border border-border-default bg-bg-surface p-1 shadow-floating"
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
            {allLabel}
          </button>
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={value === opt.value}
              onClick={() => {
                onChange(opt.value);
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

function TabStrip({
  current,
  counts,
  onChange,
}: {
  current: BeachTab;
  counts: Record<BeachTab, number | null>;
  onChange: (next: BeachTab) => void;
}) {
  return (
    <>
      {/* 태블릿·PC: 밑줄 탭(시안 V2) */}
      <div
        role="group"
        aria-label={t.tabsLabel}
        className="hidden gap-6 overflow-x-auto border-b border-border-default md:flex"
      >
        {BEACH_TABS.map((tab) => {
          const on = tab === current;
          const count = counts[tab];
          return (
            <button
              key={tab}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(tab)}
              className={`-mb-px flex min-h-admin-control shrink-0 items-center gap-1.5 border-b-2 px-0.5 py-2 text-body font-medium whitespace-nowrap ${
                on
                  ? "border-brand-default text-brand-default"
                  : "border-transparent text-text-muted hover:text-text-default"
              }`}
            >
              {t.tabs[tab]}
              <span className="font-normal text-text-muted tabular-nums">
                {count !== null ? count : t.noneDash}
              </span>
            </button>
          );
        })}
      </div>

      {/* 모바일: 가로 칩(시안 VM4) */}
      <div
        role="group"
        aria-label={t.tabsLabel}
        className="flex gap-1.5 overflow-x-auto pb-1 md:hidden"
      >
        {BEACH_TABS.map((tab) => {
          const on = tab === current;
          const count = counts[tab];
          return (
            <button
              key={tab}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(tab)}
              className={`inline-flex min-h-touch shrink-0 items-center gap-1.5 rounded-full border px-3 text-body-s font-medium whitespace-nowrap ${
                on
                  ? "border-brand-default bg-brand-weak text-brand-default"
                  : "border-border-strong bg-bg-surface text-text-body"
              }`}
            >
              {t.tabs[tab]}
              <span
                className={`font-normal tabular-nums ${
                  on ? "text-brand-default" : "text-text-muted"
                }`}
              >
                {count !== null ? count : t.noneDash}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function BeachTable({
  items,
  published,
  nowMs,
  onOpen,
}: {
  items: readonly BeachSummary[];
  published: Published;
  nowMs: number;
  onOpen: (id: string) => void;
}) {
  const nowIso = new Date(nowMs).toISOString();
  return (
    <div className="hidden overflow-x-auto rounded-admin-box md:block">
      <DataTable
        caption={t.tableCaption}
        head={
          <>
            <th scope="col" className={TH}>
              {t.colBeach}
            </th>
            <th scope="col" className={TH}>
              {t.colRegion}
            </th>
            <th scope="col" className={TH}>
              {t.colStatus}
            </th>
            <th scope="col" className={`${TH} ${CELL_END}`}>
              {t.colWaveHeight}
            </th>
            <th scope="col" className={`${TH} ${CELL_END}`}>
              {t.colWavePeriod}
            </th>
            <th scope="col" className={TH}>
              {t.colObservedAt}
            </th>
            <th scope="col" className={TH}>
              {t.colWarningZone}{" "}
              <span className="font-normal text-text-muted">
                · {t.colVerified}
              </span>
            </th>
            <th scope="col" className={TH}>
              <span className="sr-only">{t.colDetail}</span>
            </th>
          </>
        }
      >
        {items.map((b) => {
          const display = displayOf(published, b.id, nowMs);
          const verified = isZoneVerified(b);
          const zoneText = zoneDisplayName(
            b.seaZone,
            b.seaZoneName,
            t.zoneNameUnknown,
          );
          const delayedAt = delayedObservedAt(display);
          return (
            <tr
              key={b.id}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("a, button")) return;
                onOpen(b.id);
              }}
              className={`${TR} cursor-pointer hover:bg-bg-page`}
            >
              <td className={TD}>
                <Link
                  href={detailHref(b.id)}
                  className={`${CELL_NAME} underline-offset-2 hover:underline`}
                >
                  {b.nameKo}
                </Link>
              </td>
              <td className={TD}>
                {b.sido} {b.sigungu}
              </td>
              <td className={TD}>
                <StatusCell
                  beach={b}
                  display={display}
                  published={published}
                />
              </td>
              <td className={`${TD} ${CELL_END}`}>
                {b.waveHeight ? (
                  t.stationConnected
                ) : (
                  <span className="text-caption text-text-muted">
                    {t.stationNone}
                  </span>
                )}
              </td>
              <td className={`${TD} ${CELL_END}`}>
                {b.wavePeriod ? (
                  t.stationConnected
                ) : (
                  <span className="text-text-muted">{t.noneDash}</span>
                )}
              </td>
              <td className={TD}>
                {delayedAt ? (
                  <span className="font-medium text-status-stale-fg tabular-nums">
                    {fill(t.delayedObserved, {
                      time: kstClock(delayedAt, nowIso),
                    })}
                  </span>
                ) : (
                  <span
                    className="text-text-muted"
                    aria-label={t.observedUnavailable}
                  >
                    {t.noneDash}
                  </span>
                )}
              </td>
              <td className={TD}>
                <span className="inline-flex items-center gap-1.5">
                  {verified ? (
                    <span
                      role="img"
                      aria-label={t.zoneVerified}
                      title={t.zoneVerified}
                      className="inline-flex shrink-0 text-success-fg"
                    >
                      <Check size={14} aria-hidden="true" />
                    </span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center rounded-admin-badge border-[1.5px] border-dashed border-status-unknown-border bg-status-unknown-bg px-1.5 text-caption font-semibold text-status-unknown-fg">
                      {t.zoneUnverified}
                    </span>
                  )}
                  <span>{zoneText}</span>
                </span>
              </td>
              <td className={`${TD} ${CELL_END} text-text-muted`}>
                <ChevronRight size={16} aria-hidden="true" />
              </td>
            </tr>
          );
        })}
      </DataTable>
    </div>
  );
}

// 모바일: 표 대신 카드(한 줄에 핵심 정보 + 44px 이상 터치 대상, 시안 VM4)
function BeachCards({
  items,
  published,
  nowMs,
}: {
  items: readonly BeachSummary[];
  published: Published;
  nowMs: number;
}) {
  return (
    <ul className="flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface md:hidden">
      {items.map((b) => {
        const display = displayOf(published, b.id, nowMs);
        const verified = isZoneVerified(b);
        const zoneText = zoneDisplayName(
          b.seaZone,
          b.seaZoneName,
          t.zoneNameUnknown,
        );
        const metaParts = [
          `${b.sido} ${b.sigungu}`,
          b.waveHeight ? t.mobileWaveConnected : t.stationNone,
          verified ? zoneText : `${zoneText} · ${t.zoneUnverified}`,
        ];
        return (
          <li key={b.id}>
            <Link
              href={detailHref(b.id)}
              aria-label={fill(t.openDetailFor, { name: b.nameKo })}
              className="flex min-h-touch items-center justify-between gap-3 px-4 py-2.5 hover:bg-bg-page"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium text-text-default">
                  {b.nameKo}
                </span>
                <span className="block truncate text-caption text-text-muted">
                  {metaParts.join(" · ")}
                </span>
              </span>
              <span className="shrink-0">
                <StatusCell
                  beach={b}
                  display={display}
                  published={published}
                />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function BeachesBody({ beaches }: { beaches: readonly BeachSummary[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const snapshot = useSessionSnapshot();
  const state = usePublished();
  const queryState = useMemo(
    () => parseBeachQuery(searchParams),
    [searchParams],
  );
  // 빠른 입력에서 키 입력이 빠지지 않게 URL 반영 전 입력값을 잠시 유지함
  const [editingQ, setEditingQ] = useState<{
    base: string;
    value: string;
  } | null>(null);
  const activeQ =
    editingQ && editingQ.base === queryState.q ? editingQ.value : queryState.q;

  // 연속 클릭 때 Next 라우터 반영 전 queryState로 덮어쓰지 않게 마지막 요청 상태를 함께 봄
  const pendingQueryRef = useRef<{
    href: string;
    query: BeachListQuery;
  } | null>(null);
  useEffect(() => {
    if (
      pendingQueryRef.current &&
      beachListHref(queryState) === pendingQueryRef.current.href
    ) {
      pendingQueryRef.current = null;
    }
  }, [queryState]);
  useEffect(() => {
    const onPopState = () => {
      pendingQueryRef.current = null;
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const pushState = (
    build: BeachListQuery | ((prev: BeachListQuery) => BeachListQuery),
    replace = false,
  ) => {
    const base = pendingQueryRef.current
      ? pendingQueryRef.current.query
      : queryState;
    const next = typeof build === "function" ? build(base) : build;
    const href = beachListHref(next);
    pendingQueryRef.current = { href, query: next };
    if (replace) {
      router.replace(href, { scroll: false });
    } else {
      router.push(href, { scroll: false });
    }
  };

  const sidoOptions = useMemo<FilterOption[]>(
    () => sidoList(beaches).map((s) => ({ value: s, label: s })),
    [beaches],
  );
  const zoneOptions = useMemo<FilterOption[]>(
    () =>
      zoneList(beaches).map((z) => ({
        value: z.code,
        label: zoneDisplayName(z.code, z.name, t.zoneNameUnknown),
      })),
    [beaches],
  );
  const counts = useMemo(
    () => tabCounts(beaches, state.published, state.nowMs),
    [beaches, state.published, state.nowMs],
  );
  const items = useMemo(
    () =>
      queryBeaches(
        beaches,
        {
          tab: queryState.tab,
          q: activeQ,
          sido: queryState.sido,
          zone: queryState.zone,
          sort: queryState.sort,
        },
        state.published,
        state.nowMs,
      ),
    [
      beaches,
      queryState.tab,
      activeQ,
      queryState.sido,
      queryState.zone,
      queryState.sort,
      state.published,
      state.nowMs,
    ],
  );

  const pageWin = pageWindow(items.length, queryState.page, BEACH_PAGE_SIZE);
  const visible = pageRows(items, pageWin.page, BEACH_PAGE_SIZE);
  const tabWaitingPublished =
    state.published === "loading" &&
    (queryState.tab === "undetermined" || queryState.tab === "unavailable");

  const activeZoneLabel =
    queryState.zone === null
      ? null
      : (zoneOptions.find((o) => o.value === queryState.zone)?.label ??
        zoneDisplayName(queryState.zone, null, t.zoneNameUnknown));
  const sortLabel =
    queryState.sort === "region" ? t.sortRegion : t.sortStatus;
  const hasResettable =
    queryState.tab !== "all" ||
    activeQ !== "" ||
    queryState.sido !== null ||
    queryState.zone !== null;

  const resetFilters = () => {
    setEditingQ(null);
    pushState((prev) => ({
      tab: "all",
      q: "",
      sido: null,
      zone: null,
      sort: prev.sort,
      page: 0,
    }));
  };

  return (
    <section
      aria-labelledby="beaches-title"
      className="flex flex-col gap-4 px-4 py-5 md:px-10 md:pt-6 md:pb-10"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1
              id="beaches-title"
              className="text-title-l font-semibold text-text-default"
            >
              {t.title}
            </h1>
            <span className="rounded-admin-badge bg-bg-page px-1.5 text-caption font-semibold text-text-body ring-1 ring-border-default">
              {t.readOnlyBadge}
            </span>
            {snapshot.status !== "signed_out" && snapshot.pool === "demo" && (
              <span className="text-caption text-text-muted">{t.demo}</span>
            )}
          </div>
          <p className="mt-1 text-body-s text-text-muted">{t.description}</p>
        </div>
        <a
          href={BEACHES_TREE_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-touch shrink-0 items-center gap-1.5 rounded-admin-control border border-border-strong bg-bg-surface px-3 text-body-s font-medium whitespace-nowrap text-text-default shadow-card hover:bg-bg-page lg:h-9"
        >
          <GitBranch size={15} aria-hidden="true" />
          {t.editRepo}
          <span className="sr-only"> {t.newTab}</span>
        </a>
      </div>

      <Notice tone="neutral" title={t.sourceNote} />
      <PublishedAlert state={state} />
      {state.published !== "loading" && state.published?.available && (
        <p className="text-label-s text-text-muted">
          {fill(
            state.published.maintenance.active
              ? t.statusAsOfMaintenance
              : t.statusAsOf,
            { time: kstDateTime(state.published.generatedAt) },
          )}
        </p>
      )}

      <TabStrip
        current={queryState.tab}
        counts={counts}
        onChange={(tab) =>
          pushState((prev) => ({ ...prev, q: activeQ, tab, page: 0 }))
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full md:w-[260px]">
          <Search
            size={15}
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-text-muted"
          />
          <input
            type="search"
            value={activeQ}
            aria-label={t.searchLabel}
            placeholder={t.searchPlaceholder}
            onChange={(e) => {
              const nextQ = e.target.value;
              setEditingQ({ base: queryState.q, value: nextQ });
              pushState(
                (prev) => ({ ...prev, q: nextQ, page: 0 }),
                true,
              );
            }}
            className="h-touch w-full rounded-admin-control border border-border-strong bg-bg-surface pr-3 pl-8 text-body text-text-default shadow-card outline-none placeholder:text-text-muted focus:border-brand-default focus:ring-[3px] focus:ring-brand-border md:h-9"
          />
        </div>
        <OptionFilterMenu
          filterLabel={t.regionFilter}
          activeLabel={
            queryState.sido
              ? fill(t.regionChip, { sido: queryState.sido })
              : null
          }
          menuLabel={t.regionMenu}
          allLabel={t.regionAll}
          value={queryState.sido}
          options={sidoOptions}
          onChange={(sido) =>
            pushState((prev) => ({ ...prev, q: activeQ, sido, page: 0 }))
          }
        />
        <OptionFilterMenu
          filterLabel={t.zoneFilter}
          activeLabel={
            activeZoneLabel
              ? fill(t.zoneChip, { zone: activeZoneLabel })
              : null
          }
          menuLabel={t.zoneMenu}
          allLabel={t.zoneAll}
          value={queryState.zone}
          options={zoneOptions}
          onChange={(zone) =>
            pushState((prev) => ({ ...prev, q: activeQ, zone, page: 0 }))
          }
        />
        <button
          type="button"
          aria-label={fill(t.sortToggleLabel, { current: sortLabel })}
          onClick={() =>
            pushState((prev) => ({
              ...prev,
              q: activeQ,
              sort: prev.sort === "status" ? "region" : "status",
              page: 0,
            }))
          }
          className="ml-auto inline-flex h-touch shrink-0 items-center gap-1.5 rounded-admin-control border border-border-strong bg-bg-surface px-2.5 text-body-s font-medium whitespace-nowrap text-text-default shadow-card hover:bg-bg-page lg:h-8"
        >
          <ChevronsUpDown size={14} aria-hidden="true" />
          {sortLabel}
        </button>
      </div>

      {tabWaitingPublished ? (
        <p role="status" className="text-body-s text-text-muted">
          {t.statusLoading}
        </p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-admin-box border border-border-default bg-bg-surface px-4 py-10 text-center">
          <span
            aria-hidden="true"
            className="inline-flex size-10 items-center justify-center rounded-admin-box border border-border-default bg-bg-surface text-text-muted shadow-card"
          >
            <Search size={18} aria-hidden="true" />
          </span>
          <p className="text-title-s font-semibold text-text-default">
            {activeQ.trim() !== ""
              ? fill(t.emptyQueryTitle, { query: activeQ.trim() })
              : t.emptyFilteredTitle}
          </p>
          <p className="max-w-sm text-body-s text-text-muted">
            {activeQ.trim() !== ""
              ? t.emptyQueryBody
              : t.emptyFilteredBody}
          </p>
          {hasResettable && (
            <Button
              variant="secondary"
              size="small"
              className="mt-1"
              onClick={resetFilters}
            >
              {t.resetFilters}
            </Button>
          )}
        </div>
      ) : (
        <>
          <BeachTable
            items={visible}
            published={state.published}
            nowMs={state.nowMs}
            onOpen={(id) => router.push(detailHref(id))}
          />
          <BeachCards
            items={visible}
            published={state.published}
            nowMs={state.nowMs}
          />
          <Pager
            label={t.pagerLabel}
            total={items.length}
            page={pageWin.page}
            size={BEACH_PAGE_SIZE}
            onPage={(page) =>
              pushState((prev) => ({ ...prev, q: activeQ, page }))
            }
          />
        </>
      )}
    </section>
  );
}

export function BeachesScreen({
  beaches,
}: {
  beaches: readonly BeachSummary[];
}) {
  return (
    <AdminShell title={t.title}>
      {/* 정적 내보내기라 주소 쿼리는 브라우저에서 읽음(useSearchParams는 Suspense 안) */}
      <Suspense fallback={null}>
        <BeachesBody beaches={beaches} />
      </Suspense>
    </AdminShell>
  );
}
