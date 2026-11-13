"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import type { BeachName } from "@/lib/beach-names";
import { reasonLabels, type Category } from "@/lib/beaches";
import { kstDateTime } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import {
  PUBLISH_POLICY_URL,
  canRollBackTo,
  createJob,
  fetchJob,
  fetchPublishOverview,
  fetchPublishPreview,
  fetchRollbackPreview,
  hasHeldNotices,
  isRunSkipped,
  jobInFlight,
  jobPhase,
  nonZeroCategoryDeltas,
  pendingNoticeDiff,
  reapplyNotice,
  reasonKey,
  signed,
  versionIso,
  type AppSettingsView,
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
import { pageRows } from "@/lib/paging";
import { AdminShell } from "./admin-shell";
import { labelText } from "./beach-status";
import { ConfirmDialog } from "./confirm-dialog";
import { CELL_END, CELL_NAME, DataTable, Pager, TD, TH, TR } from "./data-table";
import { useSlow } from "./use-slow";
import { Button, Notice, SUCCESS_BADGE } from "./ui";

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

// V16 상단 4칸 요약 스트립의 한 칸
function SummaryCell({
  label,
  value,
  unit,
  hint,
  accent = false,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string | undefined;
  accent?: boolean;
}) {
  return (
    <div className="border-b border-border-default px-4 py-3.5 odd:border-r lg:border-r lg:border-b-0 lg:last:border-r-0 [&:nth-child(n+3)]:border-b-0">
      <dt className="text-body-s font-semibold text-text-body">{label}</dt>
      <dd className="mt-1 flex items-baseline gap-1 tabular-nums">
        <span
          className={`text-title-l font-normal ${
            accent ? "text-brand-default" : "text-text-default"
          }`}
        >
          {value}
        </span>
        {unit && <span className="text-body-s text-text-muted">{unit}</span>}
      </dd>
      {hint && <dd className="mt-0.5 text-caption text-text-muted">{hint}</dd>}
    </div>
  );
}

function PassIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-success-fg"
    >
      <path d="m5 12 5 5 9-10" />
    </svg>
  );
}

function FailIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-danger-fg"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function RollbackIcon() {
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
      className="shrink-0"
    >
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
    </svg>
  );
}

// 앱 설정 줄(V16): 서비스 점검·최소 화면 버전·GitHub 링크. 응답에 없으면 '확인 못 함' 표시
function AppSettingsBar({
  settings,
  maintenancePending,
}: {
  settings: AppSettingsView | null | undefined;
  maintenancePending: boolean | null;
}) {
  const maintenanceLabel = settings
    ? settings.maintenance.active
      ? t.settings.maintenanceOn
      : t.settings.maintenanceOff
    : t.settings.maintenanceUnknown;
  const dotColor = settings?.maintenance.active
    ? "bg-status-stale-fg"
    : "bg-text-muted";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-admin-box border border-border-default bg-bg-surface px-3 py-2 text-body-s text-text-body">
      <b className="font-semibold text-text-default">{t.settings.title}</b>
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${dotColor}`}
        />
        <span>{maintenanceLabel}</span>
        {maintenancePending === true && (
          <span className="text-status-stale-fg">
            · {t.settings.maintenancePending}
          </span>
        )}
      </span>
      <span>
        {settings
          ? fill(t.settings.minWebBuild, { version: settings.minWebBuild })
          : t.settings.minWebBuildUnknown}
      </span>
      <span className="text-text-muted">{t.settings.note}</span>
      <a
        href={PUBLISH_POLICY_URL}
        target="_blank"
        rel="noreferrer"
        className="ml-auto inline-flex items-center gap-1 font-medium text-brand-default underline-offset-2 hover:underline"
      >
        {t.settings.github}
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
          <path d="M7 17 17 7M9 7h8v8" />
        </svg>
      </a>
    </div>
  );
}

// 대기 중인 공지 줄 단위 비교 상자(V16·N2 .w-gd)
function NoticeDiffBox({
  notice,
  showKindBadge = false,
}: {
  notice: PendingNotice;
  showKindBadge?: boolean;
}) {
  const kindLabel =
    (messages.notices.kind as Record<string, string>)[notice.kind] ??
    notice.kind;
  const diff = pendingNoticeDiff(
    notice,
    kindLabel,
    timeOf,
    messages.notices.openEnd,
  );
  const changeLabel =
    (t.noticeChange as Record<string, string>)[notice.change] ?? notice.change;
  return (
    <div className="overflow-hidden rounded-admin-control border border-border-default bg-bg-surface font-mono text-caption">
      <div className="flex items-center gap-2 border-b border-border-default bg-bg-page px-3 py-1.5 font-sans text-caption text-text-body">
        <span className="min-w-0 truncate font-mono font-semibold text-text-default">
          notices/{notice.id}
        </span>
        {diff.added > 0 && (
          <span className="font-semibold text-success-fg">+{diff.added}</span>
        )}
        {diff.removed > 0 && (
          <span className="font-semibold text-danger-fg">−{diff.removed}</span>
        )}
        {showKindBadge && (
          <span className="ml-auto inline-flex items-center rounded-admin-badge bg-brand-weak px-1.5 py-0.5 text-caption font-semibold text-brand-default ring-1 ring-brand-border ring-inset">
            {changeLabel}
          </span>
        )}
      </div>
      <div>
        {diff.lines.map((line, i) => (
          <div
            key={`${line.kind}-${i}`}
            className={`grid grid-cols-[28px_28px_16px_1fr] leading-[22px] ${
              line.kind === "del"
                ? "bg-status-blocked-bg text-danger-fg"
                : "bg-success-bg text-success-fg"
            }`}
          >
            <span className="px-1 text-right text-text-muted select-none">
              {line.beforeLine ?? ""}
            </span>
            <span className="px-1 text-right text-text-muted select-none">
              {line.afterLine ?? ""}
            </span>
            <span className="text-center select-none">
              {line.kind === "del" ? "-" : "+"}
            </span>
            <code className="min-w-0 pr-2.5 font-mono break-all whitespace-pre-wrap">
              {line.text}
            </code>
          </div>
        ))}
      </div>
      {notice.change === "update" && (
        <p className="border-t border-border-default bg-bg-page px-3 py-1 font-sans text-caption text-text-muted">
          {t.pendingUpdateNote}
        </p>
      )}
    </div>
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
  for (const entry of nonZeroCategoryDeltas(changes.categoryDelta)) {
    parts.push(fill(t.changeCategory[entry.category], { delta: entry.signed }));
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
    <DataTable
      caption={t.preview.beaches}
      head={
        <>
          <th scope="col" className={TH}>
            {t.preview.table.label}
          </th>
          <th scope="col" className={`${TH} ${CELL_END}`}>
            {t.preview.table.now}
          </th>
          <th scope="col" className={`${TH} ${CELL_END}`}>
            {t.preview.table.next}
          </th>
          <th scope="col" className={`${TH} ${CELL_END}`}>
            {t.preview.table.diff}
          </th>
        </>
      }
    >
      {rows.map((row) => {
        const diff = now && next ? next[row] - now[row] : null;
        return (
          <tr key={row} className={TR}>
            <th scope="row" className={`${TD} text-left font-medium`}>
              {tb.category[row]}
            </th>
            <td className={`${TD} ${CELL_END} tabular-nums`}>
              {now ? now[row] : "—"}
            </td>
            <td className={`${TD} ${CELL_END} tabular-nums`}>
              {next ? next[row] : "—"}
            </td>
            <td
              className={`${TD} ${CELL_END} tabular-nums ${
                diff !== null && diff < 0
                  ? "text-danger-fg"
                  : diff === 0
                    ? "text-text-muted"
                    : "text-text-default"
              }`}
            >
              {diff !== null ? signed(diff) : "—"}
            </td>
          </tr>
        );
      })}
    </DataTable>
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

// 변경 미리보기 오른쪽 서랍(시안 N2): Esc 닫기 및 연 버튼으로 포커스 복원
function PreviewDrawer({
  answer,
  waiting,
  failure,
  pending,
  currentVersion,
  beaches,
  publishLocked,
  onRetry,
  onClose,
  onPublish,
}: {
  answer: PreviewAnswer | null;
  waiting: boolean;
  failure: Failed | null;
  pending: readonly PendingNotice[] | null;
  currentVersion: string | null;
  beaches: Readonly<Record<string, BeachName>>;
  publishLocked: string | null;
  onRetry: () => void;
  onClose: () => void;
  onPublish: (triggerEl: HTMLButtonElement | null) => void;
}) {
  const slow = useSlow(waiting);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  let subtitle: string | null = null;
  if (answer?.ok) {
    const p = answer.preview;
    subtitle =
      p.status === "ready" && currentVersion
        ? fill(t.preview.hint, {
            current: versionTime(currentVersion),
            at: timeOf(p.at),
          })
        : fill(t.preview.hintNoCurrent, { at: timeOf(p.at) });
  }

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
      <div className="flex flex-col gap-6">
        <section>
          <div className="flex items-baseline gap-2">
            <h3 className="text-title-s font-semibold text-text-default">
              {t.preview.notices}
            </h3>
            {pending !== null && (
              <span className="text-body-s text-text-muted tabular-nums">
                {pending.length}
              </span>
            )}
          </div>
          {pending === null ? (
            <p className="mt-2 text-body-s text-text-muted">
              {fill(t.unread, { what: t.unreadWhat.pending })}
            </p>
          ) : pending.length === 0 ? (
            <p className="mt-2 text-body-s text-text-body">{t.pendingNone}</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {pending.map((n) => (
                <NoticeDiffBox key={n.id} notice={n} showKindBadge />
              ))}
            </div>
          )}
        </section>
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
            <section>
              <div className="flex items-baseline gap-2">
                <h3 className="text-title-s font-semibold text-text-default">
                  {t.preview.beaches}
                </h3>
                {preview.current.readable && (
                  <span className="text-body-s text-text-muted tabular-nums">
                    {preview.changedCount}
                  </span>
                )}
              </div>
              <div className="mt-3">
                <CountsTable
                  now={preview.current.counts}
                  next={preview.next.counts}
                />
              </div>
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
                  <ul className="mt-2 flex flex-col gap-1 text-body-s text-text-body">
                    {preview.changed.map((change) => (
                      <li key={change.id}>
                        <span className="font-semibold text-text-default">
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
            </section>
            <section>
              <h3 className="text-title-s font-semibold text-text-default">
                {t.preview.checks}
              </h3>
              <ul className="mt-3 flex flex-col gap-1.5 text-body-s text-text-body">
                <li className="flex items-center gap-2">
                  <PassIcon />
                  <span>{t.preview.checkContract}</span>
                </li>
                <li className="flex items-center gap-2">
                  <PassIcon />
                  <span>
                    {fill(t.preview.checkIds, {
                      count: preview.checks.expected,
                      expected: preview.checks.expected,
                    })}
                  </span>
                </li>
              </ul>
            </section>
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/25"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="publish-preview-title"
        className="flex h-full w-full max-w-[540px] flex-col border-l border-border-default bg-bg-surface shadow-floating"
      >
        <div className="flex items-start gap-3 border-b border-border-default px-6 pt-5 pb-4">
          <div className="min-w-0 flex-1">
            <h2
              id="publish-preview-title"
              className="text-title-m font-semibold text-text-default"
            >
              {t.preview.title}
            </h2>
            {subtitle && (
              <p className="mt-1 text-caption text-text-muted">{subtitle}</p>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label={t.preview.close}
            onClick={onClose}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-admin-control text-text-body hover:bg-bg-page hover:text-text-default"
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
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{body}</div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border-default px-6 py-3.5 pb-[calc(0.875rem+env(safe-area-inset-bottom))]">
          <span className="text-caption text-text-muted">
            {t.preview.judgment}
          </span>
          <span className="flex-1" />
          <Button variant="secondary" size="small" onClick={onClose}>
            {t.preview.drawerClose}
          </Button>
          <Button
            size="small"
            disabled={publishLocked !== null}
            aria-describedby={publishLocked ? "publish-locked" : undefined}
            onClick={(e) => onPublish(e.currentTarget)}
          >
            {t.publishButton}
          </Button>
        </div>
      </div>
    </div>
  );
}

function HistoryList({
  items,
  page,
  onPage,
  currentVersion,
  rollbackBlocked,
  selectedVersion,
  onSelect,
  onRollback,
}: {
  items: readonly HistoryItem[];
  page: number;
  onPage: (page: number) => void;
  currentVersion: string | null;
  rollbackBlocked: string | null;
  selectedVersion: string | null;
  onSelect: (version: string | null) => void;
  onRollback: (version: string, triggerEl: HTMLButtonElement | null) => void;
}) {
  if (items.length === 0) {
    return <p className="text-body-s text-text-muted">{t.historyEmpty}</p>;
  }
  const paged = pageRows(items, page);
  const action = (item: HistoryItem) => {
    if (canRollBackTo(item, currentVersion)) {
      return (
        <Button
          variant="quiet"
          size="small"
          className="text-text-body no-underline hover:text-text-default hover:underline lg:h-8"
          disabled={rollbackBlocked !== null}
          aria-describedby={rollbackBlocked ? "publish-locked" : undefined}
          onClick={(e) => onRollback(item.version, e.currentTarget)}
        >
          <span className="inline-flex items-center gap-1">
            <RollbackIcon />
            <span>{t.rollback}</span>
          </span>
          <span className="sr-only"> {timeOf(item.at)}</span>
        </Button>
      );
    }
    if (item.result !== "published") {
      const selected = selectedVersion === item.version;
      return (
        <button
          type="button"
          aria-expanded={selected}
          onClick={() => onSelect(selected ? null : item.version)}
          className="inline-flex min-h-touch items-center text-body-s font-medium text-brand-default underline-offset-2 hover:underline lg:min-h-0"
        >
          {selected ? t.hideReason : t.inspectReason}
          <span className="sr-only"> {timeOf(item.at)}</span>
        </button>
      );
    }
    return null;
  };
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <DataTable
          caption={t.history}
          className="[&_th]:px-2.5 [&_td]:px-2.5 [&_th:first-child]:pl-3.5 [&_td:first-child]:pl-3.5 [&_th:last-child]:pr-3.5 [&_td:last-child]:pr-3.5"
          head={
            <>
              <th scope="col" className={TH}>
                {t.col.at}
              </th>
              <th scope="col" className={TH}>
                {t.col.changes}
              </th>
              <th scope="col" className={TH}>
                {t.col.verify}
              </th>
              <th scope="col" className={TH}>
                {t.col.result}
              </th>
              <th scope="col" className={`${TH} ${CELL_END}`}>
                <span className="sr-only">{t.col.actions}</span>
              </th>
            </>
          }
        >
          {paged.map((item) => {
            const selected =
              item.result !== "published" && selectedVersion === item.version;
            return (
              <tr
                key={`${item.result}-${item.version}`}
                className={`${TR} ${selected ? "bg-brand-weak" : ""}`}
              >
                <td
                  className={`${TD} tabular-nums ${
                    selected
                      ? "shadow-[inset_3px_0_0_var(--color-brand-default)]"
                      : ""
                  }`}
                >
                  <span className={CELL_NAME}>{timeOf(item.at)}</span>
                  {item.gapBefore && (
                    <p className="text-caption whitespace-normal text-status-stale-fg">
                      {t.gapBefore}
                    </p>
                  )}
                </td>
                <td className={TD.replace("whitespace-nowrap", "whitespace-normal")}>
                  <span className={CELL_NAME}>
                    {item.result === "published" ? changesText(item) : "—"}
                  </span>
                  <p className="text-caption text-text-muted">
                    {sourceText(item)}
                  </p>
                </td>
                <td className={TD.replace("whitespace-nowrap", "whitespace-normal")}>
                  {item.result === "published" ? (
                    <span className="inline-flex items-center gap-1.5 text-body-s text-text-body">
                      <PassIcon />
                      <span>{t.verifyPass}</span>
                    </span>
                  ) : (
                    <span className="flex max-w-[150px] items-start gap-1.5 text-body-s text-danger-fg">
                      <span className="mt-0.5 shrink-0">
                        <FailIcon />
                      </span>
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        {reasonText(item.reason)}
                      </span>
                    </span>
                  )}
                </td>
                <td className={TD}>
                  {item.result === "published" ? (
                    item.version === currentVersion ? (
                      <span
                        className={`inline-flex items-center rounded-admin-badge px-1.5 py-0.5 text-caption font-semibold whitespace-nowrap ${SUCCESS_BADGE}`}
                      >
                        {t.resultCurrent}
                      </span>
                    ) : (
                      <span className="text-text-muted">
                        {fill(t.resultPublished, {
                          count: item.beachCount ?? 0,
                        })}
                      </span>
                    )
                  ) : (
                    <span className="inline-flex items-center rounded-admin-badge bg-status-blocked-bg px-1.5 py-0.5 text-caption font-semibold whitespace-nowrap text-status-blocked-fg ring-1 ring-danger-border ring-inset">
                      {t.lastRunFailed}
                    </span>
                  )}
                </td>
                <td className={`${TD} ${CELL_END}`}>{action(item)}</td>
              </tr>
            );
          })}
        </DataTable>
      </div>
      <ul className="flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface md:hidden">
        {paged.map((item) => {
          const selected =
            item.result !== "published" && selectedVersion === item.version;
          return (
            <li
              key={`${item.result}-${item.version}`}
              className={`flex flex-col gap-1 px-3 py-2.5 text-body-s ${
                selected ? "bg-brand-weak" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-text-default tabular-nums">
                  {timeOf(item.at)} · {sourceText(item)}
                </p>
                {item.result === "published" ? (
                  item.version === currentVersion ? (
                    <span
                      className={`inline-flex items-center rounded-admin-badge px-1.5 py-0.5 text-caption font-semibold ${SUCCESS_BADGE}`}
                    >
                      {t.resultCurrent}
                    </span>
                  ) : (
                    <span className="text-caption text-text-muted">
                      {fill(t.resultPublished, { count: item.beachCount ?? 0 })}
                    </span>
                  )
                ) : (
                  <span className="inline-flex items-center rounded-admin-badge bg-status-blocked-bg px-1.5 py-0.5 text-caption font-semibold text-status-blocked-fg ring-1 ring-danger-border ring-inset">
                    {t.lastRunFailed}
                  </span>
                )}
              </div>
              {item.result === "published" && (
                <p className="text-text-default">{changesText(item)}</p>
              )}
              <p className="inline-flex items-center gap-1.5">
                {item.result === "published" ? (
                  <>
                    <PassIcon />
                    <span>{t.verifyPass}</span>
                  </>
                ) : (
                  <>
                    <FailIcon />
                    <span className="font-medium text-danger-fg">
                      {reasonText(item.reason)}
                    </span>
                  </>
                )}
              </p>
              {item.gapBefore && (
                <p className="text-label-s text-status-stale-fg">
                  {t.gapBefore}
                </p>
              )}
              {action(item) && <div className="mt-1">{action(item)}</div>}
            </li>
          );
        })}
      </ul>
      <Pager
        label={t.historyPager}
        total={items.length}
        page={page}
        onPage={onPage}
      />
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
  onReapply: (
    item: HeldNoticeView,
    triggerEl: HTMLButtonElement | null,
  ) => void;
}) {
  return (
    <section
      aria-label={t.held}
      className="flex flex-col divide-y divide-status-stale-border rounded-admin-box border border-status-stale-border bg-status-stale-bg px-3 py-1 text-body-s text-text-body"
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:gap-3"
        >
          <span className="font-semibold whitespace-nowrap text-status-stale-fg">
            {t.heldTitle}
          </span>
          <span className="font-medium text-text-default">
            {t.noticeLabel} · {item.title ?? t.untitled}
          </span>
          <span className="text-text-muted">
            {fill(item.restoresLive ? t.heldRestored : t.heldRemoved, {
              time: timeOf(item.at),
            })}
          </span>
          <div className="sm:ml-auto">
            <Button
              variant="secondary"
              size="small"
              disabled={blocked !== null || busyId !== null}
              aria-describedby={blocked ? "publish-locked" : undefined}
              onClick={(e) => onReapply(item, e.currentTarget)}
            >
              {t.reapply}
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

// 선택하거나 최근 실패/게시된 기록의 검증 결과 요약(V16 오른쪽 아래)
function ChecksSection({ item }: { item: HistoryItem | null }) {
  const title = item
    ? fill(t.checksTitle, { time: timeOf(item.at) })
    : t.checksTitleLatest;
  return (
    <section aria-labelledby="publish-checks" className="flex flex-col gap-3">
      <h2
        id="publish-checks"
        className="text-title-s font-semibold text-text-default"
      >
        {title}
      </h2>
      {!item ? (
        <p className="text-body-s text-text-muted">{t.checksEmpty}</p>
      ) : (
        <>
          <div className="divide-y divide-border-default border-t border-border-default">
            {item.result === "failed" ? (
              <>
                <div className="flex items-center justify-between gap-3 py-2.5 text-body-s">
                  <div>
                    <p className="font-medium text-text-default">
                      {t.checksFailReason}
                    </p>
                    <p className="text-caption text-text-muted">
                      {reasonText(item.reason)}
                    </p>
                  </div>
                  <FailIcon />
                </div>
                <div className="flex items-center justify-between gap-3 py-2.5 text-body-s">
                  <div>
                    <p className="font-medium text-text-default">
                      {t.checksFailStatus}
                    </p>
                    <p className="text-caption text-text-muted">
                      {t.checksFailStatusDetail}
                    </p>
                  </div>
                  <FailIcon />
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 py-2.5 text-body-s">
                  <div>
                    <p className="font-medium text-text-default">
                      {t.checksStatus}
                    </p>
                    <p className="text-caption text-text-muted">
                      {t.checksPassDetail}
                    </p>
                  </div>
                  <PassIcon />
                </div>
                {item.beachCount !== undefined && (
                  <div className="flex items-center justify-between gap-3 py-2.5 text-body-s">
                    <div>
                      <p className="font-medium text-text-default">
                        {t.checksBeachCount}
                      </p>
                      <p className="text-caption text-text-muted">
                        {fill(t.checksCountValue, { count: item.beachCount })}
                      </p>
                    </div>
                    <PassIcon />
                  </div>
                )}
              </>
            )}
          </div>
          {item.result === "failed" && (
            <p className="text-caption text-text-muted">{t.checksFailFoot}</p>
          )}
        </>
      )}
    </section>
  );
}

type Dialog =
  | { kind: "publish" }
  | { kind: "rollback"; version: string }
  | { kind: "reapply"; item: HeldNoticeView };

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
  const [historyPage, setHistoryPage] = useState(0);
  // null이면 아직 사용자가 고른 게 없음(실패한 첫 기록 또는 최신 기록을 기본 표시)
  const [selectedVersion, setSelectedVersion] = useState<
    string | null | undefined
  >(undefined);
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
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

  const closeDialog = (restoreFocus: boolean) => {
    setDialog(null);
    setRollbackPreview(null);
    const target = dialogTrigger.current;
    dialogTrigger.current = null;
    if (restoreFocus && target?.isConnected) {
      window.requestAnimationFrame(() => target.focus());
    }
  };

  const confirmPublish = async () => {
    const request: JobRequest = { action: "publish" };
    await send(request, keyFor(request));
    closeDialog(false);
  };

  const confirmRollback = async (version: string) => {
    const request: JobRequest = { action: "rollback", version };
    await send(request, keyFor(request));
    closeDialog(false);
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

  const openPublish = (triggerEl: HTMLButtonElement | null) => {
    dialogTrigger.current = triggerEl;
    setDialog({ kind: "publish" });
  };

  const openRollback = (version: string, triggerEl: HTMLButtonElement | null) => {
    dialogTrigger.current = triggerEl;
    setWord("");
    setDialog({ kind: "rollback", version });
    setRollbackPreview("loading");
    void fetchRollbackPreview(() => session.accessToken(), version).then(
      setRollbackPreview,
    );
  };

  const openReapply = (
    item: HeldNoticeView,
    triggerEl: HTMLButtonElement | null,
  ) => {
    dialogTrigger.current = triggerEl;
    setDialog({ kind: "reapply", item });
  };

  const loadPreview = (triggerEl?: HTMLButtonElement | null) => {
    if (triggerEl) previewTrigger.current = triggerEl;
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

  const closePreview = () => {
    setPreview({
      open: false,
      waiting: false,
      answer: null,
      failure: null,
    });
    const target = previewTrigger.current;
    previewTrigger.current = null;
    if (target?.isConnected) {
      window.requestAnimationFrame(() => target.focus());
    }
  };

  const confirmReapply = async (item: HeldNoticeView) => {
    if (!view?.heldNotices.ok) return;
    const holdVersion = view.heldNotices.version;
    const id = `${item.id}|${holdVersion}`;
    if (reapplyAttempt.current?.id !== id) {
      reapplyAttempt.current = { id, key: crypto.randomUUID() };
    }
    setReapplying(item.id);
    setMessage(null);
    const result = await reapplyNotice(
      () => session.accessToken(),
      item.id,
      holdVersion,
      reapplyAttempt.current.key,
    );
    setReapplying(null);
    closeDialog(false);
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
    const historyItems = view.history.ok ? view.history.items : [];
    const currentItem = currentVersion
      ? historyItems.find(
          (i) => i.result === "published" && i.version === currentVersion,
        )
      : undefined;
    const lastRun = view.lastRun.ok ? view.lastRun.run : null;
    const skipped = isRunSkipped(lastRun);
    const nextTime = timeOf(
      Date.parse(next.warnings) <= Date.parse(next.observations)
        ? next.warnings
        : next.observations,
    );
    const activeSelectedVersion =
      selectedVersion === undefined
        ? (historyItems.find((i) => i.result !== "published")?.version ?? null)
        : selectedVersion;
    const inspectedItem =
      (activeSelectedVersion
        ? historyItems.find((i) => i.version === activeSelectedVersion)
        : null) ??
      historyItems[0] ??
      null;

    content = (
      <div className="flex flex-col gap-3">
        {overview.failure && (
          <FailureNotice
            title={fill(t.unread, { what: t.unreadWhat.current })}
            failure={overview.failure}
            onRetry={overview.reload}
          />
        )}
        <dl className="mt-2 grid grid-cols-2 overflow-hidden rounded-admin-box border border-border-default bg-bg-surface shadow-card lg:grid-cols-4">
          {view.current.ok ? (
            <SummaryCell
              label={t.current}
              value={
                view.current.generatedAt
                  ? timeOf(view.current.generatedAt)
                  : t.currentNone
              }
              hint={
                currentItem?.beachCount !== undefined
                  ? fill(t.currentBeachCount, { count: currentItem.beachCount })
                  : undefined
              }
            />
          ) : (
            <SummaryCell
              label={t.current}
              value="—"
              hint={fill(t.unread, { what: t.unreadWhat.current })}
            />
          )}
          <SummaryCell
            label={t.nextAuto}
            value={nextTime}
            hint={
              skipped && lastRun
                ? `${fill(t.nextAutoHint, {
                    warnings: timeOf(next.warnings),
                    observations: timeOf(next.observations),
                  })} · ${fill(t.nextAutoSkipped, { time: timeOf(lastRun.at) })}`
                : fill(t.nextAutoHint, {
                    warnings: timeOf(next.warnings),
                    observations: timeOf(next.observations),
                  })
            }
          />
          {pending ? (
            <SummaryCell
              label={t.pending}
              value={String(pending.length)}
              unit={t.pendingCount.replace("{count}", "")}
              accent={pending.length > 0}
              hint={
                pending.length > 0
                  ? fill(t.pendingHint, { count: pending.length })
                  : fill(t.pendingEmpty, { time: timeOf(next.warnings) })
              }
            />
          ) : (
            <SummaryCell
              label={t.pending}
              value="—"
              hint={fill(t.unread, { what: t.unreadWhat.pending })}
            />
          )}
          {view.lastRun.ok ? (
            <SummaryCell
              label={t.lastRun}
              value={
                view.lastRun.run ? timeOf(view.lastRun.run.at) : t.lastRunNone
              }
              hint={
                view.lastRun.run
                  ? skipped
                    ? t.lastRunUnchanged
                    : view.lastRun.run.result === "published"
                      ? t.lastRunPublished
                      : `${t.lastRunFailed} · ${reasonText(view.lastRun.run.reason)}`
                  : undefined
              }
            />
          ) : (
            <SummaryCell
              label={t.lastRun}
              value="—"
              hint={fill(t.unread, { what: t.unreadWhat.lastRun })}
            />
          )}
        </dl>

        <AppSettingsBar
          settings={view.settings}
          maintenancePending={
            view.pendingNotices.ok
              ? view.pendingNotices.maintenancePending
              : null
          }
        />

        {view.heldNotices.ok ? (
          hasHeldNotices(view.heldNotices) && (
            <HeldList
              items={view.heldNotices.items}
              blocked={permission.publish}
              busyId={reapplying}
              onReapply={openReapply}
            />
          )
        ) : (
          <Unread what={t.unreadWhat.held} onRetry={overview.reload} />
        )}

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
          <PreviewDrawer
            answer={preview.answer}
            waiting={preview.waiting}
            failure={preview.failure}
            pending={pending}
            currentVersion={currentVersion}
            beaches={beaches}
            publishLocked={locked}
            onRetry={() => loadPreview()}
            onClose={closePreview}
            onPublish={(triggerEl) => {
              closePreview();
              openPublish(triggerEl);
            }}
          />
        )}

        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
          <section
            aria-labelledby="publish-history"
            className="min-w-0 flex flex-col gap-3"
          >
            <h2
              id="publish-history"
              className="text-title-s font-semibold text-text-default"
            >
              {t.history}
            </h2>
            {view.history.ok ? (
              <HistoryList
                items={view.history.items}
                page={historyPage}
                onPage={setHistoryPage}
                currentVersion={currentVersion}
                rollbackBlocked={locked}
                selectedVersion={activeSelectedVersion}
                onSelect={setSelectedVersion}
                onRollback={openRollback}
              />
            ) : (
              <Unread what={t.unreadWhat.history} onRetry={overview.reload} />
            )}
          </section>

          <div className="flex flex-col gap-8">
            <section
              aria-labelledby="publish-pending"
              className="flex flex-col gap-3"
            >
              <div className="flex items-baseline gap-2">
                <h2
                  id="publish-pending"
                  className="text-title-s font-semibold text-text-default"
                >
                  {t.pending}
                </h2>
                {pending !== null && (
                  <span className="text-body-s text-text-muted tabular-nums">
                    {pending.length}
                  </span>
                )}
              </div>
              {pending === null ? (
                <Unread what={t.unreadWhat.pending} onRetry={overview.reload} />
              ) : pending.length === 0 ? (
                <p className="text-body-s text-text-muted">
                  {fill(t.pendingEmpty, { time: timeOf(next.warnings) })}
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border-default border-t border-border-default">
                  {pending.map((notice) => (
                    <li key={notice.id} className="flex flex-col gap-2 py-3">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center rounded-admin-badge bg-bg-page px-1.5 py-0.5 text-caption font-semibold text-text-body ring-1 ring-border-strong ring-inset">
                          {t.noticeLabel}
                        </span>
                        <span className="font-medium text-text-default">
                          {notice.title.trim() || t.untitled}
                        </span>
                      </div>
                      <p className="text-caption text-text-muted">
                        {noticeLine(notice)} · {t.pendingStatusDraft} ·{" "}
                        {fill(t.pendingStatusStart, {
                          time: timeOf(notice.startsAt),
                        })}
                      </p>
                      <NoticeDiffBox notice={notice} />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {view.history.ok && <ChecksSection item={inspectedItem} />}
          </div>
        </div>
      </div>
    );
  }

  const rollbackVersion = dialog?.kind === "rollback" ? dialog.version : null;
  const reapplyItem = dialog?.kind === "reapply" ? dialog.item : null;
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
                onClick={(e) => loadPreview(e.currentTarget)}
              >
                {t.previewButton}
              </Button>
              <Button
                size="small"
                disabled={!view || locked !== null}
                aria-describedby={locked ? "publish-locked" : undefined}
                onClick={(e) => openPublish(e.currentTarget)}
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
          cancelLabel={t.cancel}
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
          onClose={() => closeDialog(true)}
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

      {reapplyItem && (
        <ConfirmDialog
          cancelLabel={t.cancel}
          titleId="reapply-confirm-title"
          title={fill(t.confirmReapplyTitle, {
            title: reapplyItem.title ?? t.untitled,
          })}
          confirmLabel={t.reapply}
          confirmDisabled={false}
          busy={reapplying !== null}
          onConfirm={() => void confirmReapply(reapplyItem)}
          onClose={() => closeDialog(true)}
        >
          <p>{t.confirmReapplyBody}</p>
          <p>{t.confirmReapplyNote}</p>
        </ConfirmDialog>
      )}

      {rollbackVersion && (
        <ConfirmDialog
          cancelLabel={t.cancel}
          titleId="rollback-confirm-title"
          title={fill(t.confirmRollbackTitle, {
            time: versionTime(rollbackVersion),
          })}
          confirmLabel={t.rollback}
          confirmDisabled={rbReady === null || word.trim() !== ROLLBACK_WORD}
          busy={writing}
          onConfirm={() => void confirmRollback(rollbackVersion)}
          onClose={() => closeDialog(true)}
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
