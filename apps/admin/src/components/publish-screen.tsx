"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import type { BeachName } from "@/lib/beach-names";
import { reasonLabels, type Category } from "@/lib/beaches";
import { kstDateTime } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import {
  canRollBackTo,
  createJob,
  fetchJob,
  fetchPublishOverview,
  fetchPublishPreview,
  fetchRollbackPreview,
  jobInFlight,
  jobPhase,
  reapplyNotice,
  reasonKey,
  signed,
  versionIso,
  type CategoryCounts,
  type HeldNoticeView,
  type HistoryItem,
  type JobRequest,
  type JobView,
  type PendingNotice,
  type PreviewAnswer,
  type PreviewBeachState,
  type PublishOverview,
  type RollbackPreview,
} from "@/lib/publish";
import { AdminShell } from "./admin-shell";
import { labelText } from "./beach-status";
import { Button, Notice } from "./ui";

// 데이터 게시 (#331, 화면 설계서 6장 ADM-PUB, 시안 4차 V16·VM8·VM9·V30·N2·F4·E2·E4·E10·VE2)
// - 지금 앱에 보이는 게시본·다음 자동 게시·대기 중인 변경(확정한 공지만, 노션 6장)·게시 기록·되돌림 상태 공지
// - 지금 게시·되돌리기는 노출 변경 권한. 확인 창(되돌리기는 단어 입력) → 작업 ID → 상태 조회(D16-C4)
// - 응답을 못 받으면 실패로 단정하지 않고, 같은 멱등 키로 다시 보내 결과만 확인함(새 게시 없음)
// - '게시 완료'와 '앱 반영'을 나눔. 반영 시각은 약속하지 않음(공개 웹 5분 갱신, D16-C5)
// - 쓰기는 자동으로 다시 보내지 않음(D16-E1). 작업 상태 조회만 저절로 다시 함
// - 분류는 publisher가 계산한 그대로 보여 줌. 이 화면은 판단 상태를 바꾸지 않음(G1)

const t = messages.publish;
const tb = messages.beaches;

// 첫 진입 뒤 이 시간이 지나도 응답이 없으면 '응답이 늦어요'(D16-E1)
const SLOW_MS = 10_000;
// 작업 상태를 다시 읽는 간격(게시 잠금 2분 안에 끝나는 작업을 따라감)
const POLL_MS = 3_000;
const ROLLBACK_WORD = t.confirmRollbackWord;

type Failed = Extract<OpsResult<unknown>, { ok: false }>;

const timeOf = (iso: string | null | undefined) =>
  iso ? kstDateTime(iso) : "";
const versionTime = (version: string) => {
  const iso = versionIso(version);
  return iso ? kstDateTime(iso) : version;
};

function usePermission(): {
  demo: boolean;
  publish: string | null;
} {
  const snapshot = useSessionSnapshot();
  if (snapshot.status === "signed_out")
    return { demo: false, publish: t.needPublisher };
  if (snapshot.pool === "demo") return { demo: true, publish: t.demo };
  return {
    demo: false,
    publish: snapshot.groups.includes("publisher") ? null : t.needPublisher,
  };
}

// 읽기가 SLOW_MS를 넘기면 true(이전 값은 그대로 보여 줌)
function useSlow(waiting: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      window.clearTimeout(timer);
      setSlow(false);
    };
  }, [waiting]);
  return waiting && slow;
}

function useOverview(enabled: boolean) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}|${generation}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: OpsResult<PublishOverview>;
  } | null>(null);
  const [good, setGood] = useState<PublishOverview | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void fetchPublishOverview(() => session.accessToken()).then((next) => {
      if (!live) return;
      setLoaded({ key, result: next });
      if (next.ok) setGood(next.body);
    });
    return () => {
      live = false;
    };
  }, [session, key, enabled]);
  const current = loaded?.key === key ? loaded.result : null;
  return {
    view: good,
    waiting: enabled && current === null,
    failure: current && !current.ok ? current : null,
    reload: () => setAttempt((n) => n + 1),
  };
}

function FailureNotice({
  title,
  failure,
  onRetry,
}: {
  title: string;
  failure: Failed;
  onRetry?: () => void;
}) {
  const i = messages.inquiries;
  if (failure.code === "reauth") {
    return <Notice tone="warn" title={i.reauth} role="alert" />;
  }
  return (
    <Notice tone="fail" title={title} role="alert">
      <p>{i.serverHint}</p>
      {"requestId" in failure && failure.requestId && (
        <p>{fill(i.requestId, { id: failure.requestId })}</p>
      )}
      {onRetry && (
        <Button
          variant="secondary"
          size="small"
          className="mt-2"
          onClick={onRetry}
        >
          {t.retry}
        </Button>
      )}
    </Notice>
  );
}

function Unread({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <Notice tone="fail" title={fill(t.unread, { what })} role="status">
      <Button
        variant="secondary"
        size="small"
        className="mt-1"
        onClick={onRetry}
      >
        {t.retry}
      </Button>
    </Notice>
  );
}

function Card({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-admin-box border border-border-default bg-bg-surface px-4 py-3">
      <dt className="text-label-s text-text-muted">{label}</dt>
      <dd className="text-title-m font-semibold text-text-default tabular-nums">
        {value}
      </dd>
      {hint && <dd className="text-label-s text-text-body">{hint}</dd>}
    </div>
  );
}

function SectionBox({
  title,
  headingId,
  aside,
  children,
}: {
  title: string;
  headingId: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-admin-box border border-border-default bg-bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id={headingId}
          className="text-title-s font-semibold text-text-default"
        >
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function reasonText(reason: string | undefined): string {
  const key = reasonKey(reason);
  return key
    ? (t.reason as Record<string, string>)[key]!
    : fill(t.reason.unknown, { code: reason ?? "" });
}

function sourceText(item: { source: string; target?: string }): string {
  if (item.source === "rollback" && item.target) {
    return fill(t.source.rollback, { time: versionTime(item.target) });
  }
  const known = (t.source as Record<string, string>)[item.source];
  return item.source !== "unknown" && known
    ? known
    : fill(t.source.unknown, { source: item.source });
}

function changesText(item: HistoryItem): string {
  const changes = item.changes;
  if (!changes) return t.changeUnknown;
  const parts: string[] = [];
  if (changes.notices === true) parts.push(t.changeNotices);
  if (changes.categoryDelta) {
    for (const category of ["clear", "unavailable", "undetermined"] as const) {
      const delta = changes.categoryDelta[category];
      if (delta !== 0) {
        parts.push(fill(t.changeCategory[category], { delta: signed(delta) }));
      }
    }
  }
  if (changes.delayedDelta !== null && changes.delayedDelta !== 0) {
    parts.push(
      fill(t.changeDelayed, {
        count: changes.delayedBeaches,
        delta: signed(changes.delayedDelta),
      }),
    );
  }
  if (
    parts.length === 0 &&
    (changes.notices === null || changes.categoryDelta === null)
  ) {
    return t.changeUnknown;
  }
  return parts.length > 0 ? parts.join(" · ") : t.changeNone;
}

function resultText(item: HistoryItem, currentVersion: string | null) {
  if (item.result === "published") {
    return item.version === currentVersion
      ? t.resultCurrent
      : fill(t.resultPublished, { count: item.beachCount ?? 0 });
  }
  return fill(t.resultFailed, { reason: reasonText(item.reason) });
}

// 공통 확인 창(V30): 제목 → 영향 → 되돌리는 법. 취소에 먼저 포커스. 모바일은 아래 시트(하단 안전 영역만큼 띄움)
function ConfirmDialog({
  titleId,
  title,
  children,
  confirmLabel,
  confirmDisabled,
  busy,
  onConfirm,
  onClose,
}: {
  titleId: string;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  confirmDisabled: boolean;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // 열면 취소 버튼에 포커스(V30 '취소에 먼저 포커스'). showModal이 첫 입력 칸으로 옮긴 포커스를 다시 가져옴
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    el?.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      className="fixed inset-x-0 bottom-0 m-0 mt-auto w-full max-w-none rounded-t-admin-box border border-border-default bg-bg-surface p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] text-text-default shadow-floating backdrop:bg-black/40 sm:inset-0 sm:m-auto sm:max-w-[480px] sm:rounded-admin-box sm:pb-5"
    >
      <h2 id={titleId} className="text-title-m font-semibold">
        {title}
      </h2>
      <div className="mt-2 flex flex-col gap-2 text-body-s text-text-body">
        {children}
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button
          data-cancel=""
          variant="secondary"
          size="small"
          disabled={busy}
          onClick={() => ref.current?.close()}
        >
          {t.cancel}
        </Button>
        <Button
          size="small"
          disabled={confirmDisabled || busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

function noticeLine(notice: PendingNotice): string {
  const change =
    (t.noticeChange as Record<string, string>)[notice.change] ?? notice.change;
  return fill(t.noticeLine, {
    title: notice.title.trim() || t.untitled,
    change,
  });
}

// 작업 상태 상자(F4·E2·E10): 단계와 결과. 실패로 단정하지 않는 상태(응답 없음·늦어짐)는 다시 확인 버튼
function JobPanel({
  job,
  noResponse,
  currentVersion,
  onRecheck,
  busy,
}: {
  job: JobView | null;
  noResponse: boolean;
  currentVersion: string | null;
  onRecheck: () => void;
  busy: boolean;
}) {
  const title =
    job?.action === "rollback" && job.target
      ? fill(t.job.rollbackTitle, { time: versionTime(job.target) })
      : t.job.title;
  if (noResponse || !job) {
    return (
      <Notice tone="warn" title={title} role="status">
        <p>{t.job.noResponse}</p>
        <Button
          variant="secondary"
          size="small"
          className="mt-2"
          disabled={busy}
          onClick={onRecheck}
        >
          {t.job.recheck}
        </Button>
      </Notice>
    );
  }
  const phase = jobPhase(job);
  const message = {
    requested: t.job.requested,
    running: t.job.running,
    published: t.job.published,
    unchanged: fill(t.job.unchanged, {
      time: currentVersion ? versionTime(currentVersion) : "",
    }),
    recovered: t.job.recovered,
    failed:
      job.reason === "busy"
        ? t.job.failedBusy
        : fill(t.job.failed, { reason: reasonText(job.reason) }),
    overdue: t.job.overdue,
    unknown: t.job.unknown,
  }[phase];
  const tone =
    phase === "published" || phase === "recovered"
      ? "success"
      : phase === "failed"
        ? "fail"
        : phase === "unchanged"
          ? "neutral"
          : "warn";
  const steps = [
    fill(t.job.stepRequested, { time: timeOf(job.createdAt) }),
    ...(job.startedAt
      ? [fill(t.job.stepStarted, { time: timeOf(job.startedAt) })]
      : []),
    ...(job.state === "done" && job.finishedAt
      ? [fill(t.job.stepFinished, { time: timeOf(job.finishedAt) })]
      : []),
    ...(phase === "published" || phase === "recovered" ? [t.job.stepApp] : []),
  ];
  return (
    <Notice tone={tone} title={title} role="status">
      <p className="font-medium text-text-default">{message}</p>
      <ol className="mt-1 list-decimal pl-5">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {(phase === "requested" || phase === "running") && (
        <p className="mt-1">{t.job.closeOk}</p>
      )}
      {(phase === "overdue" || phase === "unknown") && (
        <Button
          variant="secondary"
          size="small"
          className="mt-2"
          disabled={busy}
          onClick={onRecheck}
        >
          {t.job.recheck}
        </Button>
      )}
    </Notice>
  );
}

function CountsTable({
  now,
  next,
}: {
  now: CategoryCounts | null;
  next: CategoryCounts | null;
}) {
  const rows = ["clear", "unavailable", "undetermined"] as const;
  return (
    <table className="w-full text-body-s">
      <thead>
        <tr className="text-left text-label-s text-text-muted">
          <th scope="col" className="py-1 font-medium">
            {t.preview.table.label}
          </th>
          <th scope="col" className="py-1 text-right font-medium">
            {t.preview.table.now}
          </th>
          <th scope="col" className="py-1 text-right font-medium">
            {t.preview.table.next}
          </th>
          <th scope="col" className="py-1 text-right font-medium">
            {t.preview.table.diff}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row} className="border-t border-border-default">
            <th scope="row" className="py-1.5 text-left font-medium">
              {tb.category[row]}
            </th>
            <td className="py-1.5 text-right tabular-nums">
              {now ? now[row] : "—"}
            </td>
            <td className="py-1.5 text-right tabular-nums">
              {next ? next[row] : "—"}
            </td>
            <td className="py-1.5 text-right tabular-nums">
              {now && next ? signed(next[row] - now[row]) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// 해변 상태 글자: 사유 먼저(배지 규칙), 분류 이름을 뒤에(색만으로 나누지 않음)
function stateText(state: PreviewBeachState): string {
  const category = (["clear", "unavailable", "undetermined"] as const).includes(
    state.category as Category,
  )
    ? (state.category as Category)
    : "undetermined";
  const [first] = reasonLabels({
    category,
    reasons: state.reasons as Parameters<typeof reasonLabels>[0]["reasons"],
    validUntil: "",
  });
  const label = labelText(first);
  return category === "clear" ? label : `${label} · ${tb.category[category]}`;
}

function PreviewPanel({
  answer,
  waiting,
  failure,
  pending,
  currentVersion,
  beaches,
  onRetry,
  onClose,
}: {
  answer: PreviewAnswer | null;
  waiting: boolean;
  failure: Failed | null;
  pending: readonly PendingNotice[] | null;
  currentVersion: string | null;
  beaches: Readonly<Record<string, BeachName>>;
  onRetry: () => void;
  onClose: () => void;
}) {
  const slow = useSlow(waiting);
  const close = (
    <Button variant="quiet" size="small" onClick={onClose}>
      {t.preview.close}
    </Button>
  );
  let body: ReactNode;
  if (waiting) {
    body = (
      <p role="status" className="text-body-s text-text-muted">
        {slow ? t.slow : t.preview.loading}
      </p>
    );
  } else if (failure) {
    body = (
      <FailureNotice
        title={t.preview.failed}
        failure={failure}
        onRetry={onRetry}
      />
    );
  } else if (answer && !answer.ok) {
    body = (
      <Notice
        tone="fail"
        title={
          answer.reason === "timeout" ? t.preview.timeout : t.preview.failed
        }
        role="status"
      >
        <Button
          variant="secondary"
          size="small"
          className="mt-1"
          onClick={onRetry}
        >
          {t.retry}
        </Button>
      </Notice>
    );
  } else if (answer?.ok) {
    const preview = answer.preview;
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-label-s text-text-muted">
          {preview.status === "ready" && currentVersion
            ? fill(t.preview.hint, {
                current: versionTime(currentVersion),
                at: timeOf(preview.at),
              })
            : fill(t.preview.hintNoCurrent, { at: timeOf(preview.at) })}
        </p>
        <div>
          <h3 className="text-body font-semibold">{t.preview.notices}</h3>
          {pending === null ? (
            <p className="text-body-s text-text-muted">
              {fill(t.unread, { what: t.unreadWhat.pending })}
            </p>
          ) : pending.length === 0 ? (
            <p className="text-body-s text-text-body">{t.pendingNone}</p>
          ) : (
            <ul className="mt-1 list-disc pl-5 text-body-s">
              {pending.map((n) => (
                <li key={n.id}>{noticeLine(n)}</li>
              ))}
            </ul>
          )}
        </div>
        {preview.status === "blocked" ? (
          <Notice tone="fail" title={t.preview.blocked} role="status">
            <p>{reasonText(preview.reason)}</p>
            {preview.checks.beachIds && (
              <p>
                {fill(t.preview.checkIdsFail, {
                  missing: preview.checks.beachIds.missing,
                  extra: preview.checks.beachIds.extra,
                  duplicate: preview.checks.beachIds.duplicate,
                })}
              </p>
            )}
          </Notice>
        ) : (
          <>
            <div>
              <h3 className="text-body font-semibold">
                {t.preview.beaches}
                {preview.current.readable &&
                  ` · ${fill(t.preview.beachesCount, { count: preview.changedCount })}`}
              </h3>
              <CountsTable
                now={preview.current.counts}
                next={preview.next.counts}
              />
              {!preview.current.readable ? (
                <p className="mt-2 text-body-s text-text-muted">
                  {preview.current.missing
                    ? t.preview.beachesNoCurrent
                    : t.preview.beachesUnknown}
                </p>
              ) : preview.changedCount === 0 ? (
                <p className="mt-2 text-body-s text-text-body">
                  {t.preview.beachesNone}
                </p>
              ) : (
                <>
                  <ul className="mt-2 flex flex-col gap-1 text-body-s">
                    {preview.changed.map((change) => (
                      <li key={change.id}>
                        <span className="font-medium">
                          {beaches[change.id]?.name ?? change.id}
                        </span>{" "}
                        {change.before
                          ? stateText(change.before)
                          : t.preview.newBeach}
                        {" → "}
                        {stateText(change.after)}
                      </li>
                    ))}
                  </ul>
                  {preview.changedCount > preview.changed.length && (
                    <p className="mt-1 text-label-s text-text-muted">
                      {fill(t.preview.beachesMore, {
                        count: preview.changedCount,
                        shown: preview.changed.length,
                      })}
                    </p>
                  )}
                </>
              )}
            </div>
            <div>
              <h3 className="text-body font-semibold">{t.preview.checks}</h3>
              <ul className="mt-1 list-disc pl-5 text-body-s">
                <li>{t.preview.checkContract}</li>
                <li>
                  {fill(t.preview.checkIds, {
                    count: preview.checks.expected,
                    expected: preview.checks.expected,
                  })}
                </li>
              </ul>
            </div>
          </>
        )}
        <p className="text-label-s text-text-muted">{t.preview.judgment}</p>
      </div>
    );
  }
  return (
    <SectionBox
      title={t.preview.title}
      headingId="publish-preview"
      aside={close}
    >
      {body}
    </SectionBox>
  );
}

function HistoryList({
  items,
  currentVersion,
  rollbackBlocked,
  onRollback,
}: {
  items: readonly HistoryItem[];
  currentVersion: string | null;
  rollbackBlocked: string | null;
  onRollback: (version: string) => void;
}) {
  if (items.length === 0) {
    return <p className="text-body-s text-text-muted">{t.historyEmpty}</p>;
  }
  const action = (item: HistoryItem) =>
    canRollBackTo(item, currentVersion) ? (
      <Button
        variant="secondary"
        size="small"
        disabled={rollbackBlocked !== null}
        aria-describedby={rollbackBlocked ? "publish-locked" : undefined}
        onClick={() => onRollback(item.version)}
      >
        {t.rollback}
        <span className="sr-only"> {timeOf(item.at)}</span>
      </Button>
    ) : null;
  return (
    <>
      <table className="hidden w-full text-body-s md:table">
        <thead>
          <tr className="text-left text-label-s text-text-muted">
            <th scope="col" className="py-1.5 font-medium">
              {t.col.at}
            </th>
            <th scope="col" className="py-1.5 font-medium">
              {t.col.source}
            </th>
            <th scope="col" className="py-1.5 font-medium">
              {t.col.changes}
            </th>
            <th scope="col" className="py-1.5 font-medium">
              {t.col.result}
            </th>
            <th scope="col" className="py-1.5">
              <span className="sr-only">{t.rollback}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={`${item.result}-${item.version}`}
              className="border-t border-border-default align-top"
            >
              <td className="py-2 tabular-nums">
                {timeOf(item.at)}
                {item.gapBefore && (
                  <p className="text-label-s text-status-stale-fg">
                    {t.gapBefore}
                  </p>
                )}
              </td>
              <td className="py-2">{sourceText(item)}</td>
              <td className="py-2">
                {item.result === "published" ? changesText(item) : "—"}
              </td>
              <td
                className={`py-2 ${item.result === "published" ? "" : "font-medium text-danger-fg"}`}
              >
                {resultText(item, currentVersion)}
              </td>
              <td className="py-2 text-right">{action(item)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="flex flex-col gap-2 md:hidden">
        {items.map((item) => (
          <li
            key={`${item.result}-${item.version}`}
            className="flex flex-col gap-1 rounded-admin-box border border-border-default px-3 py-2.5 text-body-s"
          >
            <p className="font-medium tabular-nums">
              {timeOf(item.at)} · {sourceText(item)}
            </p>
            {item.result === "published" && <p>{changesText(item)}</p>}
            <p
              className={
                item.result === "published" ? "" : "font-medium text-danger-fg"
              }
            >
              {resultText(item, currentVersion)}
            </p>
            {item.gapBefore && (
              <p className="text-label-s text-status-stale-fg">{t.gapBefore}</p>
            )}
            {canRollBackTo(item, currentVersion) && <div>{action(item)}</div>}
          </li>
        ))}
      </ul>
    </>
  );
}

function HeldList({
  items,
  blocked,
  busyId,
  onReapply,
}: {
  items: readonly HeldNoticeView[];
  blocked: string | null;
  busyId: string | null;
  onReapply: (item: HeldNoticeView) => void;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex flex-col gap-1.5 rounded-admin-box border border-border-default px-3 py-2.5 text-body-s sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p className="font-medium">
              {t.noticeLabel} · {item.title ?? t.untitled}{" "}
              <span className="ml-1 inline-flex rounded-admin-badge border border-status-stale-border px-1.5 text-label-s text-status-stale-fg">
                {t.heldTag}
              </span>
            </p>
            <p className="text-text-body">
              {fill(item.restoresLive ? t.heldRestored : t.heldRemoved, {
                time: timeOf(item.at),
              })}
            </p>
          </div>
          <Button
            variant="secondary"
            size="small"
            disabled={blocked !== null || busyId !== null}
            aria-describedby={blocked ? "publish-locked" : undefined}
            onClick={() => onReapply(item)}
          >
            {t.reapply}
          </Button>
        </li>
      ))}
    </ul>
  );
}

type Dialog = { kind: "publish" } | { kind: "rollback"; version: string };

type Message = { tone: "success" | "warn" | "fail"; text: string };

export function PublishScreen({
  beaches,
}: {
  beaches: Readonly<Record<string, BeachName>>;
}) {
  const session = useAuthSession();
  const permission = usePermission();
  const overview = useOverview(!permission.demo);
  const view = overview.view;
  const firstSlow = useSlow(overview.waiting && view === null);

  // 이 탭에서 보는 작업. 없으면 서버의 마지막 작업 중 진행 중인 것
  const [job, setJob] = useState<JobView | null>(null);
  // 응답을 못 받은 요청(같은 키로 다시 보내 결과만 확인)
  const [unanswered, setUnanswered] = useState<{
    request: JobRequest;
    key: string;
  } | null>(null);
  const [writing, setWriting] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [word, setWord] = useState("");
  const [rollbackPreview, setRollbackPreview] = useState<
    OpsResult<RollbackPreview> | "loading" | null
  >(null);
  const [preview, setPreview] = useState<{
    open: boolean;
    waiting: boolean;
    answer: PreviewAnswer | null;
    failure: Failed | null;
  }>({ open: false, waiting: false, answer: null, failure: null });
  const [reapplying, setReapplying] = useState<string | null>(null);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  // 다시 적용의 멱등 키(공지·포인터 version이 같으면 같은 키 → 응답을 못 받고 다시 눌러도 결과만 확인)
  const reapplyAttempt = useRef<{ id: string; key: string } | null>(null);
  // 상태 조회가 실패하면 늘려 다음 조회를 다시 예약함(한 번의 실패로 '게시 중'에 멈추지 않게)
  const [pollRetry, setPollRetry] = useState(0);

  const serverJob =
    view?.latestJob.ok && jobInFlight(view.latestJob.job)
      ? view.latestJob.job
      : null;
  // 다른 운영자가 연 진행 중 작업이 있으면 이 탭의 끝난 작업보다 먼저 보여 줌(잠금·상태가 맞게)
  const shownJob =
    serverJob && (!job || (serverJob.jobId !== job.jobId && !jobInFlight(job)))
      ? serverJob
      : (job ?? serverJob);
  const inFlight = jobInFlight(shownJob) || writing;
  const currentVersion = view?.current.ok ? view.current.version : null;
  const locked = permission.publish ?? (inFlight ? t.busyLocked : null);

  // 진행 중 작업은 상태를 다시 읽음. 끝나면 게시 현황도 다시 읽음
  const trackedId = jobInFlight(shownJob) ? shownJob!.jobId : null;
  useEffect(() => {
    if (!trackedId) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void fetchJob(() => session.accessToken(), trackedId).then((result) => {
        if (!live) return;
        if (!result.ok) {
          // 일시적 실패(연결·서버 오류)만 다시 조회. 기록 없음·권한 없음은 멈추고 '결과를 알 수 없어요'
          // 다시 로그인이 필요하면 안내만 하고 멈춤(로그인하면 화면이 다시 읽음)
          if (result.code === "reauth") {
            setMessage({ tone: "warn", text: messages.inquiries.reauth });
          } else if (result.code === "network" || result.status >= 500) {
            setPollRetry((n) => n + 1);
          } else if (shownJob) {
            setJob({ ...shownJob, state: "unknown" });
          }
          return;
        }
        setJob(result.body.job);
        if (!jobInFlight(result.body.job)) overview.reload();
      });
    }, POLL_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // overview.reload는 매번 새 함수라 넣지 않음(attempt만 늘림)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, trackedId, shownJob, pollRetry]);

  // 같은 내용을 다시 보내면 같은 멱등 키(응답을 못 받았을 때 새 게시를 만들지 않게)
  const keyFor = (request: JobRequest) => {
    const body = JSON.stringify(request);
    if (attempt.current?.body !== body) {
      attempt.current = { body, key: crypto.randomUUID() };
    }
    return attempt.current.key;
  };

  const send = async (request: JobRequest, key: string) => {
    setWriting(true);
    setMessage(null);
    const result = await createJob(() => session.accessToken(), request, key);
    setWriting(false);
    if (result.ok) {
      setUnanswered(null);
      setJob(result.body.job);
      attempt.current = null;
      overview.reload();
      return true;
    }
    if (result.code === "network") {
      setUnanswered({ request, key });
      return true;
    }
    setUnanswered(null);
    attempt.current = null;
    if (result.code === "reauth") {
      setMessage({ tone: "warn", text: messages.inquiries.reauth });
    } else if (result.status === 409 && result.reason === "busy") {
      setMessage({ tone: "warn", text: t.job.busyConflict });
      overview.reload();
    } else if (
      result.status === 409 &&
      result.reason === "idempotency_expired"
    ) {
      setMessage({ tone: "warn", text: t.job.expiredKey });
    } else {
      const id = "requestId" in result ? result.requestId : null;
      setMessage({
        tone: "fail",
        text: id
          ? `${t.job.requestFailed} ${fill(messages.inquiries.requestId, { id })}`
          : t.job.requestFailed,
      });
    }
    return false;
  };

  const confirmPublish = async () => {
    const request: JobRequest = { action: "publish" };
    await send(request, keyFor(request));
    setDialog(null);
  };

  const confirmRollback = async (version: string) => {
    const request: JobRequest = { action: "rollback", version };
    await send(request, keyFor(request));
    setDialog(null);
  };

  const recheck = () => {
    if (unanswered) {
      void send(unanswered.request, unanswered.key);
      return;
    }
    if (!shownJob) return;
    void fetchJob(() => session.accessToken(), shownJob.jobId).then(
      (result) => {
        if (result.ok) setJob(result.body.job);
        overview.reload();
      },
    );
  };

  const openRollback = (version: string) => {
    setWord("");
    setDialog({ kind: "rollback", version });
    setRollbackPreview("loading");
    void fetchRollbackPreview(() => session.accessToken(), version).then(
      setRollbackPreview,
    );
  };

  const loadPreview = () => {
    setPreview({ open: true, waiting: true, answer: null, failure: null });
    void fetchPublishPreview(() => session.accessToken()).then((result) => {
      setPreview({
        open: true,
        waiting: false,
        answer: result.ok ? result.body : null,
        failure: result.ok ? null : result,
      });
    });
  };

  const reapply = (item: HeldNoticeView) => {
    if (!view?.heldNotices.ok) return;
    const holdVersion = view.heldNotices.version;
    const id = `${item.id}|${holdVersion}`;
    if (reapplyAttempt.current?.id !== id) {
      reapplyAttempt.current = { id, key: crypto.randomUUID() };
    }
    setReapplying(item.id);
    setMessage(null);
    void reapplyNotice(
      () => session.accessToken(),
      item.id,
      holdVersion,
      reapplyAttempt.current.key,
    ).then((result) => {
      setReapplying(null);
      if (result.ok) {
        reapplyAttempt.current = null;
        setMessage({ tone: "success", text: t.reapplyDone });
      } else if (result.status === 409 || result.status === 404) {
        setMessage({ tone: "warn", text: t.reapplyConflict });
      } else if (result.code === "reauth") {
        setMessage({ tone: "warn", text: messages.inquiries.reauth });
      } else {
        setMessage({ tone: "fail", text: t.reapplyFailed });
      }
      overview.reload();
    });
  };

  const pending = view?.pendingNotices.ok ? view.pendingNotices.items : null;

  let content: ReactNode;
  if (permission.demo) {
    content = <Notice tone="neutral" title={t.demo} />;
  } else if (!view) {
    content = overview.failure ? (
      <FailureNotice
        title={fill(t.unread, { what: t.unreadWhat.current })}
        failure={overview.failure}
        onRetry={overview.reload}
      />
    ) : (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((n) => (
            <div
              key={n}
              className="h-20 rounded-admin-box bg-bg-page motion-safe:animate-pulse"
            />
          ))}
        </div>
        {firstSlow && <p className="text-body-s text-text-muted">{t.slow}</p>}
      </div>
    );
  } else {
    const next = view.nextAuto;
    content = (
      <div className="flex flex-col gap-4">
        {overview.failure && (
          <FailureNotice
            title={fill(t.unread, { what: t.unreadWhat.current })}
            failure={overview.failure}
            onRetry={overview.reload}
          />
        )}
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {view.current.ok ? (
            <Card
              label={t.current}
              value={
                view.current.generatedAt
                  ? timeOf(view.current.generatedAt)
                  : t.currentNone
              }
            />
          ) : (
            <Card
              label={t.current}
              value="—"
              hint={fill(t.unread, { what: t.unreadWhat.current })}
            />
          )}
          <Card
            label={t.nextAuto}
            value={timeOf(
              Date.parse(next.warnings) <= Date.parse(next.observations)
                ? next.warnings
                : next.observations,
            )}
            hint={fill(t.nextAutoHint, {
              warnings: timeOf(next.warnings),
              observations: timeOf(next.observations),
            })}
          />
          {pending ? (
            <Card
              label={t.pending}
              value={fill(t.pendingCount, { count: pending.length })}
              hint={
                pending.length > 0
                  ? fill(t.pendingHint, { count: pending.length })
                  : fill(t.pendingEmpty, { time: timeOf(next.warnings) })
              }
            />
          ) : (
            <Card
              label={t.pending}
              value="—"
              hint={fill(t.unread, { what: t.unreadWhat.pending })}
            />
          )}
          {view.lastRun.ok ? (
            <Card
              label={t.lastRun}
              value={
                view.lastRun.run ? timeOf(view.lastRun.run.at) : t.lastRunNone
              }
              hint={
                view.lastRun.run
                  ? view.lastRun.run.result === "unchanged"
                    ? t.lastRunUnchanged
                    : view.lastRun.run.result === "published"
                      ? t.lastRunPublished
                      : `${t.lastRunFailed} · ${reasonText(view.lastRun.run.reason)}`
                  : undefined
              }
            />
          ) : (
            <Card
              label={t.lastRun}
              value="—"
              hint={fill(t.unread, { what: t.unreadWhat.lastRun })}
            />
          )}
        </dl>

        {(shownJob || unanswered) && (
          <JobPanel
            job={unanswered ? null : shownJob}
            noResponse={unanswered !== null}
            currentVersion={currentVersion}
            onRecheck={recheck}
            busy={writing}
          />
        )}
        {!view.latestJob.ok && (
          <Unread what={t.unreadWhat.job} onRetry={overview.reload} />
        )}

        {preview.open && (
          <PreviewPanel
            answer={preview.answer}
            waiting={preview.waiting}
            failure={preview.failure}
            pending={pending}
            currentVersion={currentVersion}
            beaches={beaches}
            onRetry={loadPreview}
            onClose={() =>
              setPreview({
                open: false,
                waiting: false,
                answer: null,
                failure: null,
              })
            }
          />
        )}

        <SectionBox title={t.pending} headingId="publish-pending">
          {pending === null ? (
            <Unread what={t.unreadWhat.pending} onRetry={overview.reload} />
          ) : pending.length === 0 ? (
            <p className="text-body-s text-text-muted">
              {fill(t.pendingEmpty, { time: timeOf(next.warnings) })}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-body-s">
              {pending.map((notice) => (
                <li key={notice.id}>{noticeLine(notice)}</li>
              ))}
            </ul>
          )}
        </SectionBox>

        {view.heldNotices.ok ? (
          view.heldNotices.items.length > 0 && (
            <SectionBox title={t.held} headingId="publish-held">
              <HeldList
                items={view.heldNotices.items}
                blocked={permission.publish}
                busyId={reapplying}
                onReapply={reapply}
              />
            </SectionBox>
          )
        ) : (
          <Unread what={t.unreadWhat.held} onRetry={overview.reload} />
        )}

        <SectionBox title={t.history} headingId="publish-history">
          {view.history.ok ? (
            <HistoryList
              items={view.history.items}
              currentVersion={currentVersion}
              rollbackBlocked={locked}
              onRollback={openRollback}
            />
          ) : (
            <Unread what={t.unreadWhat.history} onRetry={overview.reload} />
          )}
        </SectionBox>
      </div>
    );
  }

  const rollbackVersion = dialog?.kind === "rollback" ? dialog.version : null;
  const rbResult =
    rollbackPreview && rollbackPreview !== "loading" ? rollbackPreview : null;
  const rbReady =
    rbResult?.ok && rbResult.body.available ? rbResult.body : null;

  return (
    <AdminShell title={messages.nav.publish}>
      <div className="flex w-full flex-col gap-4 px-4 py-5 md:px-10 md:pt-6 md:pb-10">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-title-l font-semibold text-text-default">
              {messages.nav.publish}
            </h1>
            <p className="mt-1 text-label-s text-text-muted">{t.description}</p>
          </div>
          {!permission.demo && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="small"
                disabled={!view || preview.waiting}
                onClick={loadPreview}
              >
                {t.previewButton}
              </Button>
              <Button
                size="small"
                disabled={!view || locked !== null}
                aria-describedby={locked ? "publish-locked" : undefined}
                onClick={() => setDialog({ kind: "publish" })}
              >
                {t.publishButton}
              </Button>
            </div>
          )}
        </div>
        {!permission.demo && locked && (
          <p id="publish-locked" className="text-label-s text-text-body">
            {locked}
          </p>
        )}
        {message && (
          <Notice
            tone={message.tone}
            title={message.text}
            role={message.tone === "fail" ? "alert" : "status"}
          />
        )}
        {content}
      </div>

      {dialog?.kind === "publish" && (
        <ConfirmDialog
          titleId="publish-confirm-title"
          title={
            pending && pending.length > 0
              ? fill(t.confirmPublishTitle, { count: pending.length })
              : t.confirmPublishTitleNone
          }
          confirmLabel={t.publishButton}
          confirmDisabled={false}
          busy={writing}
          onConfirm={() => void confirmPublish()}
          onClose={() => setDialog(null)}
        >
          <p>{t.confirmPublishBody}</p>
          {pending === null && (
            <p role="alert" className="font-medium text-text-default">
              {t.confirmPublishPendingUnread}
            </p>
          )}
          {pending && pending.length > 0 && (
            <ul className="list-disc pl-5">
              {pending.map((n) => (
                <li key={n.id}>{noticeLine(n)}</li>
              ))}
            </ul>
          )}
          <p>{t.confirmPublishJudgment}</p>
          <p>{t.confirmPublishUndo}</p>
        </ConfirmDialog>
      )}

      {rollbackVersion && (
        <ConfirmDialog
          titleId="rollback-confirm-title"
          title={fill(t.confirmRollbackTitle, {
            time: versionTime(rollbackVersion),
          })}
          confirmLabel={t.rollback}
          confirmDisabled={rbReady === null || word.trim() !== ROLLBACK_WORD}
          busy={writing}
          onConfirm={() => void confirmRollback(rollbackVersion)}
          onClose={() => {
            setDialog(null);
            setRollbackPreview(null);
          }}
        >
          <p>{t.confirmRollbackBody}</p>
          {rollbackPreview === "loading" && (
            <p role="status">{t.rollbackPreviewLoading}</p>
          )}
          {rbResult && !rbResult.ok && (
            <p role="alert" className="text-danger-fg">
              {t.rollbackPreviewFailed}
            </p>
          )}
          {rbResult?.ok && !rbResult.body.available && (
            <p role="alert" className="text-danger-fg">
              {t.rollbackUnavailable}
            </p>
          )}
          {rbReady && (
            <>
              <p>
                {fill(
                  rbReady.items.length > 0
                    ? t.confirmRollbackNotices
                    : t.confirmRollbackNoNotices,
                  {
                    time: versionTime(rollbackVersion),
                    count: rbReady.items.length,
                  },
                )}
              </p>
              {rbReady.items.length > 0 && (
                <ul className="list-disc pl-5">
                  {rbReady.items.map((item) => (
                    <li key={item.id}>
                      {fill(t.noticeLine, {
                        title: item.title ?? t.untitled,
                        change:
                          (t.rollbackChange as Record<string, string>)[
                            item.change
                          ] ?? item.change,
                      })}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <p>{t.confirmRollbackData}</p>
          <p>{t.confirmRollbackHold}</p>
          <label className="mt-1 flex flex-col gap-1">
            <span className="font-medium text-text-default">
              {fill(t.confirmRollbackWordLabel, { word: ROLLBACK_WORD })}
            </span>
            <input
              value={word}
              onChange={(e) => setWord(e.target.value)}
              autoComplete="off"
              className="h-touch rounded-admin-control border border-border-strong bg-bg-surface px-3 text-body text-text-default lg:h-admin-control"
            />
          </label>
        </ConfirmDialog>
      )}
    </AdminShell>
  );
}
