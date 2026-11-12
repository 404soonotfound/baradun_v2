"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AUDIT_CATEGORIES,
  AUDIT_PAGE_SIZE,
  AUDIT_PERIODS,
  categoryOf,
  diffLines,
  fetchAudit,
  kstDay,
  noticeLines,
  periodFilter,
  shortSub,
  type AuditCategory,
  type AuditCounts,
  type AuditFilter,
  type AuditPage,
  type AuditPeriod,
  type AuditView,
} from "@/lib/audit";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import type { BeachName } from "@/lib/beach-names";
import { isInquiryStatus, kstDateTime, shortId } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import { kstRange } from "@/lib/notices";
import { AdminShell } from "./admin-shell";
import { Button, Notice } from "./ui";

// 운영자 변경 이력 (BRD-155, 화면 설계서 6장 ADM-AUD, 시안 4차 V23·VM14)
// - 분류 탭(수) · 대상·내용 찾기 · +운영자 · +기간 칩 · 표(시각·누가·종류·대상·바뀐 내용·바뀐 곳) · 이전/다음
// - 공지 줄을 누르면 문구 앞·뒤를 펼쳐 보여 줌(공지는 공개 문구). 문의는 본문·메모 값 없이 항목만(D16-B5)
// - 운영자 이름은 기록에 없어 Cognito sub 앞부분으로 보여 줌
// - 해변 탭: 운영 메모 저장 기록(BRD-150). 해변 정보 변경은 저장소 커밋이 이력. 게시·권한·로그인은 기능이 생기면 같은 탭에 쌓임
// - 더한 줄 색: 시안은 초록이지만 디자인 시스템이 초록 계열을 쓰지 않아(노션 4장, 토큰 검사) 파랑(특보 없음 면)으로 둠
// - 데모 계정은 변경 이력을 받지 않음(D15-3) → 요청하지 않고 안내만

const t = messages.audit;

// 해변 메모 기록의 대상 이름(공개 해변 데이터 이름표, 문의 화면과 같음)
export type Beaches = Readonly<Record<string, BeachName>>;
const i = messages.inquiries;

const REPO_DATA_COMMITS =
  "https://github.com/404soonotfound/baradun_v2/commits/main/data/beaches";

const operatorName = (sub: string) =>
  fill(t.operator, { name: sub.slice(0, 4) });

function roleLabel(role: string): string {
  return role in t.role ? t.role[role as keyof typeof t.role] : role;
}

// 운영 홈 '최근 변경'도 같은 표시를 씀(ADM-HOME)
export function kindBadge(item: AuditView): string {
  const category = categoryOf(item.action);
  if (category) return t.category[category];
  return item.actorKind === "sample" ? t.demoBadge : t.unknownBadge;
}

const statusLabel = (s: string) => (isInquiryStatus(s) ? i.status[s] : s);

// 바뀐 내용 한 줄 요약(시안 '문구 수정 · 영어 문구 추가', '접수 → 확인 중')
export function summaryOf(item: AuditView): string {
  const s = t.summary;
  const parts: string[] = [];
  if (item.action === "notice.create") parts.push(s.noticeCreate);
  else if (item.action === "notice.expose") parts.push(s.noticeExpose);
  else if (item.action === "notice.end") parts.push(s.noticeEnd);
  else if (item.action === "notice.delete") parts.push(s.noticeDelete);
  else if (item.action === "notice.update") {
    const before = item.notice?.before;
    const after = item.notice?.after;
    if (before && after) {
      if (before.kind !== after.kind) parts.push(s.kind);
      if (
        before.title.ko !== after.title.ko ||
        before.body.ko !== after.body.ko
      ) {
        parts.push(s.textKo);
      }
      const enBefore = `${before.title.en}${before.body.en}`.trim();
      const enAfter = `${after.title.en}${after.body.en}`.trim();
      if (enBefore === "" && enAfter !== "") parts.push(s.enAdded);
      else if (
        before.title.en !== after.title.en ||
        before.body.en !== after.body.en
      ) {
        parts.push(s.textEn);
      }
      if (
        before.startsAt !== after.startsAt ||
        before.endsAt !== after.endsAt
      ) {
        parts.push(s.period);
      }
    }
  } else if (item.action === "inquiry.update") {
    if (item.statusFrom && item.statusTo) {
      parts.push(
        fill(s.status, {
          from: statusLabel(item.statusFrom),
          to: statusLabel(item.statusTo),
        }),
      );
    }
    if (item.changes.includes("rejectReason")) parts.push(s.rejectReason);
    if (item.changes.includes("memo")) parts.push(s.memo);
    if (item.changes.includes("message")) parts.push(s.message);
  } else if (item.action === "sample.read") {
    parts.push(s.sampleRead);
  } else if (item.action === "sample.denied") {
    parts.push(s.sampleDenied);
  }
  if (parts.length > 0) return parts.join(" · ");
  // 모르는 종류·앞뒤가 없는 기록: 바뀐 항목 이름만
  const fields = item.changes.map((f) =>
    f in t.field ? t.field[f as keyof typeof t.field] : f,
  );
  return fields.length > 0
    ? fill(s.fields, { fields: fields.join(" · ") })
    : item.action;
}

export function Target({
  item,
  beaches,
}: {
  item: AuditView;
  beaches: Beaches;
}) {
  const { kind, id } = item.target;
  const link =
    "font-medium text-brand-default underline-offset-2 hover:underline";
  if (kind === "inquiry") {
    return (
      <Link
        href={`/inquiries/?id=${encodeURIComponent(id)}`}
        title={id}
        className={link}
      >
        {shortId(id)}
      </Link>
    );
  }
  if (kind === "notice") {
    return (
      <Link href={`/notices/?id=${encodeURIComponent(id)}`} className={link}>
        {item.targetLabel ?? id}
      </Link>
    );
  }
  if (kind === "beach") {
    return (
      <Link href={`/beaches/${encodeURIComponent(id)}/`} className={link}>
        {beaches[id]?.name ?? id}
      </Link>
    );
  }
  return <span className="text-text-body">{id}</span>;
}

function Avatar({ sub }: { sub: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-6 flex-none items-center justify-center rounded-full border border-border-strong text-caption text-text-body uppercase"
    >
      {sub.slice(0, 1)}
    </span>
  );
}

function Who({ item }: { item: AuditView }) {
  return (
    <span
      className="inline-flex items-center gap-2"
      title={fill(t.actorTitle, {
        sub: item.actorSub,
        role: roleLabel(item.role),
      })}
    >
      <Avatar sub={item.actorSub} />
      {operatorName(item.actorSub)}
    </span>
  );
}

function KindBadge({ item }: { item: AuditView }) {
  return (
    <span className="inline-flex items-center rounded-admin-badge bg-info-bg px-1.5 text-caption font-semibold whitespace-nowrap text-info-fg ring-1 ring-border-default">
      {kindBadge(item)}
    </span>
  );
}

function Where() {
  return (
    <span className="inline-flex items-center gap-1.5 text-text-muted">
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
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c1-4 4.5-6 8-6s7 2 8 6" />
      </svg>
      {t.whereOps}
    </span>
  );
}

const lineLabels = {
  kind: (kind: string) =>
    kind in t.diffKind ? t.diffKind[kind as keyof typeof t.diffKind] : kind,
  placement: t.diffPlacement,
  none: t.diffNone,
  period: (startsAt: string, endsAt: string | null) =>
    kstRange(startsAt, endsAt, t.diffOpenEnd),
};

const DIFF_GRID = "grid grid-cols-[2.5rem_2.5rem_1.25rem_1fr] px-1";

// 공지 문구 앞·뒤 펼치기(시안 V23: 파일 이름 +n −n, 줄 번호, 뺀 줄·더한 줄)
function NoticeDiff({ item }: { item: AuditView }) {
  const before = item.notice?.before ?? null;
  const after = item.notice?.after ?? null;
  const lines = diffLines(
    noticeLines(before, lineLabels),
    noticeLines(after, lineLabels),
  );
  const added = lines.filter((l) => l.kind === "add").length;
  const removed = lines.filter((l) => l.kind === "del").length;
  const title = (after ?? before)?.title.ko || item.target.id;
  return (
    <div
      role="group"
      aria-label={t.diffLabel}
      className="overflow-hidden rounded-admin-box border border-border-default bg-bg-surface"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border-default bg-bg-page px-3 py-2 text-body-s">
        <span className="font-mono font-semibold text-text-default">
          {fill(t.diffFile, { id: item.target.id })}
        </span>
        <span className="font-semibold text-status-clear-fg">
          <span className="sr-only">{t.diffAdded} </span>+{added}
        </span>
        <span className="font-semibold text-status-blocked-fg">
          <span className="sr-only">{t.diffRemoved} </span>−{removed}
        </span>
        <span className="ml-auto text-label-s text-text-muted">
          {fill(t.diffMeta, {
            actor: operatorName(item.actorSub),
            time: kstDateTime(item.at),
            id: item.requestId.replace(/^req-/, "").slice(0, 4),
          })}
        </span>
      </div>
      <div className="overflow-x-auto py-1 font-mono text-body-s">
        <div className={`${DIFF_GRID} py-0.5 text-text-muted`}>
          <span />
          <span />
          <span />
          <span>@@ {fill(t.diffHunk, { title })} @@</span>
        </div>
        {lines.map((line, n) => (
          <div
            key={n}
            className={`${DIFF_GRID} py-0.5 ${
              line.kind === "add"
                ? "bg-status-clear-bg text-status-clear-fg"
                : line.kind === "del"
                  ? "bg-status-blocked-bg text-status-blocked-fg"
                  : "text-text-default"
            }`}
          >
            <span className="pr-2 text-right opacity-70 tabular-nums">
              {line.oldNo ?? ""}
            </span>
            <span className="pr-2 text-right opacity-70 tabular-nums">
              {line.newNo ?? ""}
            </span>
            <span aria-hidden="true">
              {line.kind === "add" ? "+" : line.kind === "del" ? "-" : ""}
            </span>
            <span className="break-all whitespace-pre-wrap">
              {line.kind !== "same" && (
                <span className="sr-only">
                  {line.kind === "add" ? t.diffAdded : t.diffRemoved}:{" "}
                </span>
              )}
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// '+ 운영자'·'+ 기간' 칩: 누르면 고를 목록이 아래에 열림(Esc·바깥 누르기로 닫음)
function ChipMenu({
  label,
  menuLabel,
  active,
  children,
}: {
  label: string;
  menuLabel: string;
  active: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex min-h-touch items-center gap-1.5 rounded-admin-control border px-3 text-body font-medium whitespace-nowrap lg:min-h-admin-control ${
          active
            ? "border-brand-border bg-brand-weak text-brand-default"
            : "border-dashed border-border-strong bg-bg-surface text-text-default hover:bg-bg-page"
        }`}
      >
        {!active && (
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        )}
        {label}
      </button>
      {open && (
        <div
          role="group"
          aria-label={menuLabel}
          className="absolute top-full left-0 z-20 mt-1 flex min-w-48 flex-col rounded-admin-box border border-border-default bg-bg-surface p-1 shadow-floating"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  selected,
  onClick,
  children,
}: {
  selected?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className="flex min-h-touch items-center rounded-admin-control px-2.5 text-left text-body text-text-default hover:bg-bg-page aria-pressed:font-semibold aria-pressed:text-brand-default lg:min-h-admin-control"
    >
      {children}
    </button>
  );
}

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
    return <Notice tone="warn" title={i.reauth} role="alert" />;
  }
  return (
    <Notice tone="fail" title={title} role="alert">
      <p>{i.serverHint}</p>
      {"requestId" in result && result.requestId && (
        <p>{fill(i.requestId, { id: result.requestId })}</p>
      )}
      <Button
        variant="secondary"
        size="small"
        className="mt-2"
        onClick={onRetry}
      >
        {i.retry}
      </Button>
    </Notice>
  );
}

const rowKey = (item: AuditView) => `${item.at}|${item.requestId}`;

// 거르기를 바꾼 순간의 시각(눌림 처리 안에서만 부름)
function currentTime(): number {
  return Date.now();
}

function AuditBody({ beaches }: { beaches: Beaches }) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const demo = snapshot.status !== "signed_out" && snapshot.pool === "demo";
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  // 시안 V23: 기본 기간 최근 7일
  const [days, setDays] = useState<AuditPeriod>(7);
  const [category, setCategory] = useState<AuditCategory | null>(null);
  const [actor, setActor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [attempt, setAttempt] = useState(0);
  // 거르기를 바꾸면 기간 끝(지금)을 새로 잡음
  const [now, setNow] = useState(() => Date.now());
  // 쪽 cursor 목록(0쪽은 null). 거르기가 바뀌면 처음으로
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [open, setOpen] = useState<string | null>(null);
  // 탭 수: 첫 쪽 응답에만 오므로 분류를 뺀 거르기별로 기억
  const [counts, setCounts] = useState<{
    key: string;
    counts: AuditCounts;
  } | null>(null);

  const filter: AuditFilter = periodFilter(days, now, { category, actor, q });
  const filterText = JSON.stringify(filter);
  const countKey = JSON.stringify({ ...filter, category: null });
  const cursor = cursors.at(-1) ?? null;
  const key = `${filterText}|${cursor}|${attempt}|${generation}`;
  const countsKey = useRef<string | null>(null);
  const [seen, setSeen] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<{
    key: string;
    result: OpsResult<AuditPage>;
  } | null>(null);

  useEffect(() => {
    if (demo) return;
    let live = true;
    const asked = JSON.parse(filterText) as AuditFilter;
    // 같은 거르기(분류 제외)의 탭 수를 이미 가졌으면 서버가 다시 세지 않게 함(분류 탭만 바꿈)
    const haveCounts = countsKey.current === countKey;
    void fetchAudit(
      () => session.accessToken(),
      asked,
      cursor,
      !haveCounts,
    ).then((next) => {
      if (!live) return;
      setLoaded({ key, result: next });
      if (!next.ok) return;
      if (next.body.counts) {
        countsKey.current = countKey;
        setCounts({ key: countKey, counts: next.body.counts });
      }
      // '+ 운영자' 목록: 이 화면에서 본 운영자를 모두 기억(고른 뒤에도 다른 운영자로 바꿀 수 있게)
      setSeen((prev) => {
        const fresh = [
          ...new Set(next.body.items.map((item) => item.actorSub)),
        ].filter((sub) => !prev.includes(sub));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
    });
    return () => {
      live = false;
    };
  }, [session, key, filterText, countKey, cursor, demo]);

  const refilter = (change: () => void) => {
    change();
    setNow(currentTime());
    setCursors([null]);
    setOpen(null);
  };

  // 찾기 글자는 멈춘 뒤 0.4초에 적용
  const typed = search.trim();
  useEffect(() => {
    if (typed === q) return;
    const timer = setTimeout(() => {
      setQ(typed);
      setNow(currentTime());
      setCursors([null]);
      setOpen(null);
    }, 400);
    return () => clearTimeout(timer);
  }, [typed, q]);

  const result = loaded?.key === key ? loaded.result : null;
  const items = result?.ok ? result.body.items : [];
  const nextCursor = result?.ok ? result.body.nextCursor : null;
  const tabCounts = counts?.key === countKey ? counts.counts : null;
  const total = tabCounts
    ? category
      ? tabCounts[category]
      : tabCounts.all
    : null;
  const pageIndex = cursors.length - 1;
  const from = pageIndex * AUDIT_PAGE_SIZE + 1;
  const to = pageIndex * AUDIT_PAGE_SIZE + items.length;
  const periodLabel = t.periodDays[String(days) as keyof typeof t.periodDays];

  // 운영자 고르기 목록: 이 화면에서 본 운영자(이름이 기록에 없어 운영자 목록 API가 없음)
  const actors = seen;

  // 모바일: 날짜(KST)별로 묶음. 오늘은 '오늘 · 11/2'
  const today = kstDay(new Date(now).toISOString());
  const byDay = items.reduce<{ day: string; items: AuditView[] }[]>(
    (groups, item) => {
      const day = kstDay(item.at);
      const last = groups.at(-1);
      if (last?.day === day) last.items.push(item);
      else groups.push({ day, items: [item] });
      return groups;
    },
    [],
  );

  return (
    <div className="flex flex-col px-4 py-5 md:px-10 md:pt-6 md:pb-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-title-l font-semibold text-text-default">
          {t.title}
        </h1>
        <p className="text-body-s text-text-muted">{t.description}</p>
      </div>

      {demo ? (
        <div className="mt-6">
          <Notice tone="neutral" title={t.demo} />
        </div>
      ) : (
        <>
          <div
            role="group"
            aria-label={t.tabsLabel}
            className="mt-6 flex gap-1 overflow-x-auto border-b border-border-default"
          >
            {[null, ...AUDIT_CATEGORIES].map((c) => {
              const on = c === category;
              const n = tabCounts ? (c ? tabCounts[c] : tabCounts.all) : null;
              return (
                <button
                  key={c ?? "all"}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    // 분류만 바꿈: 기간 끝(지금)을 그대로 두어 탭 수를 다시 세지 않음
                    setCategory(c);
                    setCursors([null]);
                    setOpen(null);
                  }}
                  className={`-mb-px flex min-h-touch shrink-0 items-center gap-1.5 border-b-2 px-2 text-body whitespace-nowrap lg:min-h-admin-control ${
                    on
                      ? "border-brand-default font-semibold text-brand-default"
                      : "border-transparent font-medium text-text-body hover:text-text-default"
                  }`}
                >
                  {c ? t.category[c] : t.all}
                  {n !== null && (
                    <span className="font-normal text-text-muted tabular-nums">
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <label className="flex min-h-touch w-full items-center gap-2 rounded-admin-control border border-border-strong bg-bg-surface px-2.5 text-text-muted focus-within:border-brand-default focus-within:ring-[3px] focus-within:ring-brand-border sm:w-64 lg:min-h-admin-control">
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <span className="sr-only">{t.searchLabel}</span>
              <input
                type="search"
                value={search}
                maxLength={50}
                placeholder={t.searchPlaceholder}
                onChange={(e) => setSearch(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-body text-text-default outline-none placeholder:text-text-muted"
              />
            </label>
            <ChipMenu
              label={
                actor
                  ? fill(t.actorChip, { actor: operatorName(actor) })
                  : t.addActor
              }
              menuLabel={t.actorMenu}
              active={actor !== null}
            >
              {(close) => (
                <>
                  {actors.length === 0 && !actor && (
                    <p className="px-2.5 py-2 text-body-s text-text-muted">
                      {t.actorNone}
                    </p>
                  )}
                  {actors.map((sub) => (
                    <MenuItem
                      key={sub}
                      selected={sub === actor}
                      onClick={() => {
                        close();
                        refilter(() => setActor(sub));
                      }}
                    >
                      <span className="inline-flex items-center gap-2">
                        <Avatar sub={sub} />
                        {operatorName(sub)}
                        <span className="font-mono text-label-s text-text-muted">
                          {shortSub(sub)}
                        </span>
                      </span>
                    </MenuItem>
                  ))}
                  {actor && (
                    <MenuItem
                      onClick={() => {
                        close();
                        refilter(() => setActor(null));
                      }}
                    >
                      {t.clearActor}
                    </MenuItem>
                  )}
                </>
              )}
            </ChipMenu>
            <ChipMenu
              label={fill(t.periodChip, { period: periodLabel })}
              menuLabel={t.periodMenu}
              active={false}
            >
              {(close) =>
                AUDIT_PERIODS.map((d) => (
                  <MenuItem
                    key={d}
                    selected={d === days}
                    onClick={() => {
                      close();
                      refilter(() => setDays(d));
                    }}
                  >
                    {t.periodDays[String(d) as keyof typeof t.periodDays]}
                  </MenuItem>
                ))
              }
            </ChipMenu>
          </div>

          <div className="mt-3 flex flex-col gap-3">
            {result === null && (
              <p role="status" className="text-body-s text-text-muted">
                {t.loading}
              </p>
            )}
            {result && !result.ok && (
              <Failure
                title={t.error}
                result={result}
                onRetry={() => setAttempt((n) => n + 1)}
              />
            )}
            {result?.ok && items.length === 0 && (
              <div className="rounded-admin-box border border-border-default bg-bg-surface px-4 py-6 text-center">
                <p className="text-title-s font-semibold text-text-default">
                  {t.emptyTitle}
                </p>
                <p className="mt-1 text-body-s text-text-muted">
                  {t.emptyBody}
                </p>
              </div>
            )}
            {items.length > 0 && (
              <>
                {/* 태블릿·PC: 표. 공지 줄은 바뀐 내용을 눌러 펼침 */}
                <table className="hidden w-full border-separate border-spacing-0 overflow-hidden rounded-admin-box border border-border-default bg-bg-surface text-body md:table">
                  <thead>
                    <tr className="bg-bg-page text-left text-label-s font-semibold text-text-body">
                      {[
                        t.colAt,
                        t.colActor,
                        t.colKind,
                        t.colTarget,
                        t.colSummary,
                        t.colWhere,
                      ].map((label) => (
                        <th
                          key={label}
                          scope="col"
                          className="border-b border-border-default px-3 py-2 first:pl-4"
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => {
                      const k = rowKey(item);
                      const expandable = item.notice !== undefined;
                      const expanded = open === k;
                      const cell = `border-b border-border-default px-3 py-2.5 ${
                        expanded ? "bg-brand-weak" : ""
                      }`;
                      const mark = expanded
                        ? "shadow-[inset_3px_0_0_var(--color-brand-default)]"
                        : "";
                      return [
                        <tr key={k}>
                          <td
                            className={`${cell} ${mark} pl-4 whitespace-nowrap text-text-default tabular-nums`}
                          >
                            {kstDateTime(item.at)}
                          </td>
                          <td className={`${cell} whitespace-nowrap`}>
                            <Who item={item} />
                          </td>
                          <td className={cell}>
                            <KindBadge item={item} />
                          </td>
                          <td className={cell}>
                            <Target item={item} beaches={beaches} />
                          </td>
                          <td className={cell}>
                            {expandable ? (
                              <button
                                type="button"
                                aria-expanded={expanded}
                                title={expanded ? t.collapse : t.expand}
                                onClick={() => setOpen(expanded ? null : k)}
                                className="text-left text-text-default underline decoration-border-strong decoration-dotted underline-offset-4 hover:decoration-current"
                              >
                                {summaryOf(item)}
                              </button>
                            ) : (
                              <span className="text-text-default">
                                {summaryOf(item)}
                              </span>
                            )}
                          </td>
                          <td className={`${cell} whitespace-nowrap`}>
                            <Where />
                          </td>
                        </tr>,
                        expanded && (
                          <tr key={`${k}|diff`}>
                            <td
                              colSpan={6}
                              className={`border-b border-border-default bg-brand-weak px-4 pb-3.5 ${mark}`}
                            >
                              <NoticeDiff item={item} />
                            </td>
                          </tr>
                        ),
                      ];
                    })}
                  </tbody>
                </table>

                {/* 모바일(VM14): 날짜별 묶음 */}
                <div className="flex flex-col gap-4 md:hidden">
                  {byDay.map((group) => (
                    <section key={group.day} aria-label={group.day}>
                      <h2 className="mb-1.5 text-label-s font-semibold text-text-muted">
                        {group.day === today
                          ? fill(t.today, { day: group.day })
                          : group.day}
                      </h2>
                      <ul className="flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface">
                        {group.items.map((item) => (
                          <li
                            key={rowKey(item)}
                            className="flex flex-col gap-1 px-4 py-3"
                          >
                            <span className="flex flex-wrap items-center gap-2 text-body">
                              <KindBadge item={item} />
                              <Target item={item} beaches={beaches} />
                            </span>
                            <span className="flex flex-wrap items-center gap-1.5 text-body-s text-text-body">
                              <span>{summaryOf(item)}</span>
                              <span aria-hidden="true">·</span>
                              <Avatar sub={item.actorSub} />
                              <span className="sr-only">
                                {operatorName(item.actorSub)}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="tabular-nums">
                                {kstDateTime(item.at).split(" ")[1]}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              </>
            )}
            {result?.ok && (items.length > 0 || pageIndex > 0) && (
              <nav
                aria-label={t.pagination}
                className="flex items-center justify-between gap-3 text-body-s text-text-muted"
              >
                <span className="tabular-nums" aria-live="polite">
                  {items.length > 0 &&
                    total !== null &&
                    fill(t.range, { period: periodLabel, total, from, to })}
                </span>
                <span className="flex gap-2">
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={pageIndex === 0}
                    onClick={() => {
                      setOpen(null);
                      setCursors((c) => c.slice(0, -1));
                    }}
                  >
                    {t.prev}
                  </Button>
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={!nextCursor}
                    onClick={() => {
                      if (!nextCursor) return;
                      setOpen(null);
                      setCursors((c) => [...c, nextCursor]);
                    }}
                  >
                    {t.next}
                  </Button>
                </span>
              </nav>
            )}
          </div>
        </>
      )}

      <p className="mt-4 text-label-s text-text-muted">
        {t.note}{" "}
        <a
          href={REPO_DATA_COMMITS}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-brand-default underline underline-offset-2"
        >
          {t.repoLink}
        </a>
      </p>
    </div>
  );
}

export function AuditScreen({ beaches }: { beaches: Beaches }) {
  return (
    <AdminShell title={t.title}>
      <AuditBody beaches={beaches} />
    </AdminShell>
  );
}
