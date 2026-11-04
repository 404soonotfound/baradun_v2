"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
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
  fetchInquiries,
  fetchInquiry,
  MEMO_MAX,
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
  type InquiryPage,
  type InquiryPatch,
  type InquiryStatus,
  type InquirySummary,
  type Redaction,
} from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import { AdminShell } from "./admin-shell";
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
// 확인 중은 점선 테두리라 색 없이도 구분됨(시안 S3 배지). 성공색 토큰은 아직 정하지 않아 완료는 정보색
const BADGE: Record<InquiryStatus, string> = {
  received: "bg-brand-weak text-brand-default ring-1 ring-brand-border",
  in_progress:
    "bg-status-stale-bg text-status-stale-fg outline-1 outline-status-stale-border outline-dashed -outline-offset-1",
  resolved: "bg-info-bg text-info-fg ring-1 ring-border-default",
  rejected: "bg-bg-surface text-text-muted ring-1 ring-border-strong",
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
      className="flex gap-1 overflow-x-auto border-b border-border-default"
    >
      {tabs.map((tab) => {
        const on = tab.key === status;
        return (
          <button
            key={tab.key ?? "all"}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(tab.key)}
            className={`-mb-px flex min-h-touch shrink-0 items-center gap-1.5 border-b-2 px-2 text-body whitespace-nowrap lg:min-h-admin-control ${
              on
                ? "border-brand-default font-semibold text-brand-default"
                : "border-transparent font-medium text-text-muted hover:text-text-default"
            }`}
          >
            {tab.label}
            {tab.count !== null && (
              <span className="text-label-s tabular-nums">{tab.count}</span>
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
}: {
  beaches: Beaches;
  selectedId: string | null;
  saved: SavedMap;
}) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const [status, setStatus] = useState<InquiryStatus | null>(null);
  // 지나온 쪽의 cursor. 첫 쪽은 null. 이전으로 가면 하나 뺌
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
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
  };

  const pageIndex = cursors.length - 1;
  // 저장한 상태로 바꿔 보이고, 고른 탭과 맞지 않게 된 문의는 이 탭에서 뺌(예: 접수 탭에서 완료로 저장)
  const items = result?.ok
    ? result.body.items
        .map((item) => withSaved(item, saved))
        .filter((item) => !status || item.status === status)
    : [];
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

  return (
    <section aria-labelledby="inquiries-title" className="flex flex-col gap-4">
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
      {/* 첫 쪽이 비면 '문의가 없어요'. 다음 쪽만 비면(그사이 지워짐·상태 경계) 이전으로 돌아가게 안내하고 쪽 넘기기는 남김 */}
      {result?.ok && items.length === 0 && pageIndex === 0 && (
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
      {result?.ok && items.length === 0 && pageIndex > 0 && (
        <Notice tone="neutral" title={t.emptyPage} role="status" />
      )}
      {result?.ok && items.length > 0 && (
        <>
          {/* 태블릿·PC: 표 */}
          <table className="hidden w-full border-separate border-spacing-0 overflow-hidden rounded-admin-box border border-border-default bg-bg-surface text-body md:table">
            <thead>
              <tr className="bg-bg-page text-left text-label-s font-semibold text-text-body">
                <th
                  scope="col"
                  className="border-b border-border-default px-4 py-2"
                >
                  {t.colStatus}
                </th>
                <th
                  scope="col"
                  className="border-b border-border-default px-3 py-2"
                >
                  {t.colType}
                </th>
                <th
                  scope="col"
                  className="border-b border-border-default px-3 py-2"
                >
                  {t.colBeach}
                </th>
                <th
                  scope="col"
                  className="border-b border-border-default px-4 py-2 text-right"
                >
                  {t.colReceived}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const on = item.inquiryId === selectedId;
                return (
                  <tr
                    key={item.inquiryId}
                    className={on ? "bg-brand-weak" : "hover:bg-bg-page"}
                  >
                    <td className="border-b border-border-default px-4 py-2">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="border-b border-border-default px-3 py-2">
                      <Link
                        href={detailHref(item.inquiryId)}
                        aria-current={on ? "true" : undefined}
                        className="font-medium text-text-default underline-offset-2 hover:underline"
                      >
                        {typeLabel(item.type)}
                      </Link>
                    </td>
                    <td className="border-b border-border-default px-3 py-2 text-text-body">
                      <BeachActivity item={item} beaches={beaches} />
                    </td>
                    <td className="border-b border-border-default px-4 py-2 text-right whitespace-nowrap text-text-body tabular-nums">
                      {kstDateTime(item.receivedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* 모바일: 카드 목록(값은 빼지 않음) */}
          <ul className="flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface md:hidden">
            {items.map((item) => (
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
                  <span className="text-body-s text-text-body">
                    <BeachActivity item={item} beaches={beaches} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {result?.ok && (items.length > 0 || pageIndex > 0) && (
        <nav
          aria-label={t.pagination}
          className="flex items-center justify-between gap-3 text-body-s text-text-muted"
        >
          <span className="tabular-nums">
            {/* 빈 쪽은 범위를 보여 주지 않음(21–20처럼 거꾸로 되지 않게) */}
            {items.length > 0 &&
              (total !== null
                ? fill(t.range, { total, from, to })
                : fill(t.rangeNoTotal, { from, to }))}
          </span>
          <span className="flex gap-2">
            <Button
              variant="secondary"
              size="small"
              disabled={pageIndex === 0}
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              {t.prev}
            </Button>
            <Button
              variant="secondary"
              size="small"
              disabled={!result.body.nextCursor}
              onClick={() => {
                const next = result.body.nextCursor;
                if (next) setCursors((c) => [...c, next]);
              }}
            >
              {t.next}
            </Button>
          </span>
        </nav>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-3 py-2">
      <dt className="text-body-s text-text-muted">{label}</dt>
      <dd className="text-body text-text-default">{children}</dd>
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
  onSaved,
  onReload,
}: {
  item: InquiryDetail;
  // 내가 개인정보 가리기로 저장한 version 앞(from)·뒤(to). 상태·메모는 그대로라 쓰던 내용을 두고 기준만 옮김
  // 초안 기준이 from일 때만 옮김(이미 낡은 초안은 충돌 안내를 그대로 둠)
  rebase: { from: number; to: number } | null;
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
      className="flex flex-col gap-4 border-t border-border-default pt-4"
    >
      <h3
        id="inquiry-actions"
        className="text-title-s font-semibold text-text-default"
      >
        {t.editTitle}
      </h3>
      {block && <Notice tone="neutral" title={block} />}

      <fieldset disabled={disabled} className="flex flex-col gap-2">
        <legend className="mb-2 text-body font-medium text-text-default">
          {t.statusLegend}
        </legend>
        <div className="grid grid-cols-4 gap-1 rounded-admin-control bg-bg-page p-1">
          {INQUIRY_STATUSES.map((s) => (
            <label
              key={s}
              className="flex min-h-touch cursor-pointer items-center justify-center rounded-admin-control text-body-s font-medium text-text-body has-checked:bg-bg-surface has-checked:font-semibold has-checked:text-text-default has-checked:shadow-card has-focus-visible:ring-[3px] has-focus-visible:ring-brand-border has-disabled:cursor-not-allowed lg:min-h-admin-control"
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
          className="text-body font-medium text-text-default"
        >
          {t.memo}
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

      {/* 저장 바: 아래에 붙어 있어 긴 메모를 쓰는 중에도 보임(화면 설계서 6장 모바일 규칙 '저장은 아래 고정 바') */}
      <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-3 border-t border-border-default bg-bg-surface px-1 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <span className="text-body-s text-text-muted" aria-live="polite">
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
  onRedacted,
  onReload,
}: {
  item: InquiryDetail;
  onRedacted: (from: number, to: number) => void;
  onReload: () => void;
}) {
  const session = useAuthSession();
  const block = useEditBlock();
  const message = item.message ?? "";
  const [mode, setMode] = useState<"view" | "select" | "confirm">("view");
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
    setMode("view");
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
              onClick={() => setMode("select")}
            >
              {t.redactCancel}
            </Button>
          </div>
        </Notice>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {mode === "view" ? (
          <Button
            variant="secondary"
            size="small"
            disabled={block !== null || message === ""}
            onClick={() => setMode("select")}
          >
            {t.redactOpen}
          </Button>
        ) : (
          mode === "select" && (
            <>
              <Button variant="secondary" size="small" onClick={close}>
                {t.redactCancel}
              </Button>
              <Button
                size="small"
                disabled={!range}
                onClick={() => setMode("confirm")}
              >
                {t.redactApply}
              </Button>
            </>
          )
        )}
      </div>
    </section>
  );
}

function InquiryDetailView({
  id,
  beaches,
  onClose,
  onSaved,
}: {
  id: string;
  beaches: Beaches;
  onClose: () => void;
  onSaved: (inquiryId: string, saved: Saved) => void;
}) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const [attempt, setAttempt] = useState(0);
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
      if (next.ok) setGood({ id, detail: next.body });
    });
    return () => {
      live = false;
    };
  }, [session, id, key]);

  // 주소로 열었는데 없음(지워졌거나 90일 지남): 404
  if (result && !result.ok && result.status === 404) {
    return (
      <div className="flex flex-col items-start gap-2 py-6">
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
      <Failure
        title={t.detailError}
        result={result}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!result) {
    return (
      <p role="status" className="py-6 text-body-s text-text-muted">
        {t.loading}
      </p>
    );
  }

  const item = result.body;
  const beach = item.beachId ? beaches[item.beachId] : undefined;

  return (
    <article aria-labelledby="inquiry-type" className="flex flex-col gap-4">
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
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-2 text-label-s text-text-muted">
          <StatusBadge status={item.status} />
          <span>
            {t.id}{" "}
            <span title={item.inquiryId} className="font-mono">
              {shortId(item.inquiryId)}
            </span>
          </span>
        </p>
        <h2
          id="inquiry-type"
          className="text-title-m font-semibold text-text-default"
        >
          {typeLabel(item.type)}
        </h2>
      </div>

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
          onReload={() => {
            setNotice(null);
            setAttempt((n) => n + 1);
          }}
          onRedacted={(from, to) => {
            setRedacted({ id, from, to });
            setNotice({ id, text: t.redacted });
            setAttempt((n) => n + 1);
          }}
        />
      )}

      <dl className="divide-y divide-border-default border-y border-border-default">
        <Row label={t.beachActivity}>
          <BeachActivity item={item} beaches={beaches} />
          {beach && (
            <span className="ml-1 text-body-s text-text-muted">
              ({beach.region})
            </span>
          )}
        </Row>
        <Row label={t.received}>
          <span className="tabular-nums">{kstDateTime(item.receivedAt)}</span>
        </Row>
        <Row label={t.retention}>
          {fill(t.retentionValue, { date: retentionDate(item.receivedAt) })}
        </Row>
        <Row label={t.contact}>{t.contactValue}</Row>
        <Row label={t.currentStatus}>
          <StatusBadge status={item.status} />
          {item.updatedAt && (
            <span className="ml-2 text-body-s text-text-muted">
              {fill(t.updatedAt, { time: kstDateTime(item.updatedAt) })}
            </span>
          )}
        </Row>
        {/* 반려 이유·메모는 아래 처리 칸에서 보여 주고 고침(같은 값을 두 번 보이지 않게) */}
      </dl>
      {notice?.id === id && (
        <Notice tone="brand" title={notice.text} role="status" />
      )}
      {/* 보기 권한은 메모·반려 이유를 받지 않으므로 처리 칸을 그리지 않음(빈 칸을 실제 값처럼 보이지 않게) */}
      {!item.restricted && (
        <InquiryActions
          key={item.inquiryId}
          item={item}
          rebase={
            redacted?.id === id
              ? { from: redacted.from, to: redacted.to }
              : null
          }
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
  onClosed,
  onSaved,
}: {
  id: string;
  beaches: Beaches;
  onClosed: () => void;
  onSaved: (inquiryId: string, saved: Saved) => void;
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
        const reduce = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        window.setTimeout(onClosed, reduce ? 0 : CLOSE_MS);
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-[480px] max-w-full overflow-y-auto border-l border-border-default bg-bg-surface px-6 py-5 text-text-default shadow-floating transition-[translate,overlay,display] transition-discrete duration-200 ease-out not-open:translate-x-full backdrop:bg-[rgb(11_26_44/0.4)] backdrop:transition-[opacity,overlay,display] backdrop:transition-discrete backdrop:duration-200 not-open:backdrop:opacity-0 starting:open:translate-x-full starting:open:backdrop:opacity-0 motion-reduce:transition-none motion-reduce:backdrop:transition-none"
    >
      <div className="flex flex-col gap-3">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={close}
            className="flex min-h-admin-control items-center rounded-admin-control px-2 text-body-s font-medium text-text-body hover:bg-bg-page"
          >
            {t.close}
          </button>
        </div>
        <InquiryDetailView
          id={id}
          beaches={beaches}
          onClose={close}
          onSaved={onSaved}
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
  const toList = () => router.push("/inquiries/");
  const [saved, setSaved] = useState<SavedMap>({});
  const onSaved = (inquiryId: string, next: Saved) =>
    setSaved((prev) => ({ ...prev, [inquiryId]: next }));

  return (
    <div className="px-4 py-5 md:px-10 md:pt-6 md:pb-10">
      {/* 좁은 화면: 상세를 열면 목록 대신 상세. PC: 목록은 그대로 두고 위에 패널 */}
      <div className={id && !wide ? "hidden" : undefined}>
        <InquiryList beaches={beaches} selectedId={id} saved={saved} />
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
            onClose={toList}
            onSaved={onSaved}
          />
        </section>
      )}
      {id && wide && (
        <DetailPanel
          key={id}
          id={id}
          beaches={beaches}
          onClosed={toList}
          onSaved={onSaved}
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
