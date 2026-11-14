"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import { kstDateTime } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import {
  actionRunUrl,
  authFailed,
  fetchSiteDeploy,
  issueNumber,
  kstTime,
  parseSiteDeploy,
  lastText,
  pendingCommits,
  reasonText,
  refreshInterval,
  repoUrl,
  scheduleLabel,
  tokenExpiryState,
  type CiState,
  type DeployCommit,
  type DeployChanges,
  type Field,
  type Readiness,
  type SiteDeployView,
  type SiteView,
} from "@/lib/site-deploy";
import {
  LoadingStatus,
  SkBox,
  SkLine,
  SlowNote,
  loadClass,
  useLoadTiming,
} from "./loading";
import { Button, Notice } from "./ui";

// 사이트 배포 칸 (#472, 결정 기록 D27-1~8 · 화면 설계서 6장 ADM-PUB '사이트 배포')
// - 조회와 'GitHub에서 배포 열기' 링크까지만(D27-2). 화면에서 배포하지 않음
// - 칸마다 확인한 값 / 확인 못 함(사유·앞 값)을 나눠 보임. 0건·정상으로 바꾸지 않음(D27-3)
// - '배포할 수 있어요'는 readiness가 ready일 때만(lib/site-deploy가 필요한 칸을 다시 확인함)
// - 다시 읽기는 화면이 보일 때만. 기본 1분, 진행 중·승인 대기는 30초. 다시 읽는 동안·실패해도 앞 값 유지(D26-4)
// - 데모 계정은 서버가 거절(sample: false)하므로 요청하지 않고 한 줄 안내만
// - 상태는 색+아이콘+단어. 새 색 토큰·style 속성 없음(CSP)

const t = messages.siteDeploy;
const tl = messages.loading;

// 다시 읽을 때가 됐는지 보는 간격
const TICK_MS = 5_000;

type Failed = Extract<OpsResult<unknown>, { ok: false }>;
type Tone = "success" | "warn" | "fail" | "neutral";

const TONE_TEXT: Record<Tone, string> = {
  success: "text-success-fg",
  warn: "text-status-stale-fg",
  fail: "text-danger-fg",
  neutral: "text-text-body",
};

const READINESS_TONE: Record<Readiness, Tone> = {
  ready: "success",
  ci_pending: "warn",
  ci_failed: "fail",
  ci_missing: "warn",
  paused: "warn",
  deploying: "warn",
  approval_pending: "warn",
  unconfigured: "warn",
  unknown: "neutral",
};

const CI_TONE: Record<CiState | "unknown", Tone> = {
  success: "success",
  pending: "warn",
  failure: "fail",
  missing: "warn",
  unknown: "neutral",
};

function ToneIcon({ tone }: { tone: Tone }) {
  const path = {
    success: "m5 12 5 5 9-10",
    fail: "M6 6l12 12M18 6 6 18",
    warn: "M12 7v6m0 4h.01",
    neutral: "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6m0 3h.01",
  }[tone];
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
      className={`shrink-0 ${TONE_TEXT[tone]}`}
    >
      {tone === "warn" || tone === "neutral" ? (
        <circle cx="12" cy="12" r="9.5" strokeWidth="1.8" />
      ) : null}
      <path d={path} />
    </svg>
  );
}

// 새 탭 링크: 화면 읽기에 '새 탭에서 열림'을 함께 알림
function ExternalLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`font-medium text-brand-default underline-offset-2 hover:underline ${className}`}
    >
      {children}
      <span className="sr-only"> ({t.newTab})</span>
    </a>
  );
}

function ArrowIcon() {
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
      className="inline shrink-0"
    >
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}

// 확인 못 한 칸: '무엇 확인 못 함 · 사유'. 앞 값이 있으면 '마지막으로 확인한 값 · HH:MM 기준'과 함께
function Unknown<T>({
  label,
  field,
  render,
}: {
  label: string;
  field: Extract<Field<T>, { status: "unknown" }>;
  render?: (value: T) => ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-start gap-1.5 text-body-s">
        <span className="mt-0.5">
          <ToneIcon tone="neutral" />
        </span>
        <span>
          <span className="font-semibold text-text-default">{label}</span>
          <span className="text-text-body">
            {" "}
            · {reasonText(field.reason, field.retryAt)}
          </span>
        </span>
      </p>
      {field.last && render && (
        <div className="flex flex-col gap-0.5 border-l-2 border-border-default pl-2.5">
          <p className="text-caption text-text-muted">{lastText(field)}</p>
          <div className="text-text-muted">{render(field.last.value)}</div>
        </div>
      )}
    </div>
  );
}

function CommitLine({
  commit,
  repo,
}: {
  commit: DeployCommit;
  repo: string | null;
}) {
  const short = commit.sha.slice(0, 7);
  const issue = issueNumber(commit.title);
  const rest =
    issue === null ? commit.title : commit.title.slice(`GH-${issue}`.length);
  return (
    <span className="min-w-0 text-body-s break-words text-text-default">
      {repo ? (
        <ExternalLink
          href={`${repo}/commit/${commit.sha}`}
          className="font-mono"
        >
          {short}
        </ExternalLink>
      ) : (
        <code className="font-mono">{short}</code>
      )}{" "}
      {issue !== null &&
        (repo ? (
          <ExternalLink href={`${repo}/issues/${issue}`}>
            GH-{issue}
          </ExternalLink>
        ) : (
          <span>GH-{issue}</span>
        ))}
      <span>{rest}</span>
    </span>
  );
}

function ChangedFiles({ changes }: { changes: DeployChanges }) {
  if (changes.files.length === 0)
    return <p className="text-body-s text-text-body">{t.filesNone}</p>;
  return (
    <details className="group text-body-s">
      <summary className="inline-flex min-h-touch cursor-pointer items-center gap-1 font-medium text-text-default lg:min-h-0">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        {fill(t.files, { count: changes.files.length })} · {t.filesList}
      </summary>
      <ul className="mt-2 flex flex-col gap-1.5">
        {changes.files.map((file) => (
          <li
            key={`${file.previous ?? ""}>${file.path}`}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
          >
            <span className="inline-flex shrink-0 items-center rounded-admin-badge bg-bg-page px-1.5 py-0.5 text-caption font-semibold text-text-body ring-1 ring-border-strong ring-inset">
              {t.category[file.category]}
            </span>
            <code className="min-w-0 font-mono text-caption break-all text-text-default">
              {file.path}
            </code>
            {file.previous && (
              <span className="text-caption text-text-muted">
                {fill(t.renamedFrom, { path: file.previous })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function SiteCard({ site, repo }: { site: SiteView; repo: string | null }) {
  const deployedCommit = (commit: DeployCommit) => (
    <CommitLine commit={commit} repo={repo} />
  );
  const run = site.matchedRun;
  return (
    <section
      aria-labelledby={`site-deploy-${site.app}`}
      className="flex min-w-0 flex-col gap-3 rounded-admin-box border border-border-default bg-bg-surface px-4 py-3.5"
    >
      <h3
        id={`site-deploy-${site.app}`}
        className="text-body font-semibold text-text-default"
      >
        {t.sites[site.app]}
      </h3>
      <div className="flex flex-col gap-1">
        <p className="text-caption font-semibold text-text-body">
          {t.deployedCommit}
        </p>
        {site.detail.status === "known" && site.deployed.status === "known" ? (
          <>
            {deployedCommit(site.detail.value)}
            <p className="text-caption text-text-muted">
              {fill(t.checkedAt, { time: kstTime(site.deployed.checkedAt) })}
              {run && (
                <>
                  {" · "}
                  {fill(run.completedAt ? t.runAt : t.runNoTime, {
                    event: t.runEvent[run.event],
                    time: run.completedAt ? kstDateTime(run.completedAt) : "",
                  })}{" "}
                  · <ExternalLink href={run.url}>{t.runLink}</ExternalLink>
                </>
              )}
            </p>
          </>
        ) : site.deployed.status === "unknown" ? (
          <Unknown
            label={t.deployedUnknown}
            field={site.deployed}
            render={(sha) => (
              <code className="font-mono">{sha.slice(0, 7)}</code>
            )}
          />
        ) : (
          site.detail.status === "unknown" && (
            <Unknown
              label={t.deployedUnknown}
              field={site.detail}
              render={deployedCommit}
            />
          )
        )}
      </div>
      <div className="flex flex-col gap-1 border-t border-border-default pt-3">
        <p className="text-caption font-semibold text-text-body">
          {t.pendingTitle}
        </p>
        {site.changes.status === "known" ? (
          <ChangedFiles changes={site.changes.value} />
        ) : (
          <Unknown
            label={t.changesUnknown}
            field={site.changes}
            render={(value) => (
              <p className="text-body-s">
                {value.files.length
                  ? fill(t.files, { count: value.files.length })
                  : t.filesNone}
              </p>
            )}
          />
        )}
      </div>
    </section>
  );
}

function ReadinessLine({ view }: { view: SiteDeployView }) {
  const tone = READINESS_TONE[view.readiness];
  const runUrl =
    view.readiness === "deploying" || view.readiness === "approval_pending"
      ? actionRunUrl(view)
      : null;
  return (
    <div
      className={`flex flex-col gap-1 rounded-admin-box border px-3.5 py-3 ${
        tone === "success"
          ? "border-success-border bg-success-bg"
          : tone === "fail"
            ? "border-danger-border bg-status-blocked-bg"
            : tone === "warn"
              ? "border-status-stale-border bg-status-stale-bg"
              : "border-border-default bg-bg-page"
      }`}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-s">
        <span className="sr-only">{t.readinessTitle}: </span>
        <ToneIcon tone={tone} />
        <span className="font-semibold text-text-default">
          {t.readiness[view.readiness]}
        </span>
        {runUrl && (
          <ExternalLink href={runUrl}>
            {view.readiness === "approval_pending" ? t.approvalLink : t.runLink}
          </ExternalLink>
        )}
        <span className="text-caption text-text-muted">
          {fill(t.readinessAt, { time: kstTime(view.readinessCheckedAt) })}
        </span>
      </p>
      {view.readiness === "paused" && (
        <p className="text-caption text-text-body">{t.pausedNote}</p>
      )}
    </div>
  );
}

function SummaryItem({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-b border-border-default px-4 py-3 last:border-b-0 lg:border-r lg:border-b-0 lg:last:border-r-0">
      <dt className="text-caption font-semibold text-text-body">{label}</dt>
      <dd className="flex min-w-0 flex-col gap-0.5">{children}</dd>
    </div>
  );
}

function Summary({
  view,
  repo,
}: {
  view: SiteDeployView;
  repo: string | null;
}) {
  const ciState: CiState | "unknown" =
    view.ci.status === "known" ? view.ci.value : "unknown";
  const schedule = scheduleLabel(
    view.nextScheduledAt,
    Date.parse(view.generatedAt),
  );
  return (
    <dl className="grid grid-cols-1 overflow-hidden rounded-admin-box border border-border-default bg-bg-surface lg:grid-cols-3">
      <SummaryItem label={t.mainTitle}>
        {view.main.status === "known" ? (
          <CommitLine commit={view.main.value} repo={repo} />
        ) : (
          <Unknown
            label={t.mainUnknown}
            field={view.main}
            render={(value) => <CommitLine commit={value} repo={repo} />}
          />
        )}
        <span className="flex items-center gap-1.5 text-body-s">
          <span className="text-text-body">{t.ciLabel}</span>
          <ToneIcon tone={CI_TONE[ciState]} />
          <span className={`font-semibold ${TONE_TEXT[CI_TONE[ciState]]}`}>
            {t.ci[ciState]}
          </span>
          {view.ci.status === "unknown" && (
            <span className="text-caption text-text-muted">
              · {reasonText(view.ci.reason, view.ci.retryAt)}
            </span>
          )}
        </span>
      </SummaryItem>
      <SummaryItem label={t.scheduleTitle}>
        <span className="text-title-s font-normal text-text-default tabular-nums">
          {schedule.kind === "paused"
            ? t.schedule.paused
            : fill(t.schedule[schedule.kind], {
                time: schedule.time,
                date: schedule.kind === "later" ? schedule.date : "",
              })}
        </span>
      </SummaryItem>
      <SummaryItem label={t.manualTitle}>
        {view.manualCount.status === "known" ? (
          <span className="text-body-s text-text-default tabular-nums">
            {fill(t.manual, { count: view.manualCount.value.requests })}
          </span>
        ) : (
          <Unknown
            label={t.manualUnknown}
            field={view.manualCount}
            render={(value) => (
              <span className="text-body-s">
                {fill(t.manual, { count: value.requests })}
              </span>
            )}
          />
        )}
        <span className="text-caption text-text-muted">{t.manualNote}</span>
      </SummaryItem>
    </dl>
  );
}

function CommitList({
  view,
  repo,
}: {
  view: SiteDeployView;
  repo: string | null;
}) {
  const list = pendingCommits(view.sites);
  const anyKnown = view.sites.some((s) => s.changes.status === "known");
  return (
    <section
      aria-labelledby="site-deploy-commits"
      className="flex flex-col gap-2"
    >
      <div className="flex items-baseline gap-2">
        <h3
          id="site-deploy-commits"
          className="text-body font-semibold text-text-default"
        >
          {t.commitsTitle}
        </h3>
        {anyKnown && list.complete && (
          <span className="text-body-s text-text-muted tabular-nums">
            {fill(t.commitsCount, { count: list.total })}
          </span>
        )}
      </div>
      {!anyKnown ? (
        <p className="flex items-center gap-1.5 text-body-s text-text-body">
          <ToneIcon tone="neutral" />
          {t.commitsUnknown}
        </p>
      ) : (
        <>
          {!list.complete && (
            <p className="flex items-center gap-1.5 text-body-s text-text-body">
              <ToneIcon tone="neutral" />
              {t.commitsPartial}
            </p>
          )}
          {list.total === 0 ? (
            list.complete && (
              <p className="text-body-s text-text-body">{t.commitsNone}</p>
            )
          ) : (
            <ul className="flex flex-col divide-y divide-border-default border-t border-border-default">
              {list.commits.map((commit) => (
                <li key={commit.sha} className="py-2">
                  <CommitLine commit={commit} repo={repo} />
                </li>
              ))}
            </ul>
          )}
          {list.total > list.commits.length && repo && list.compare && (
            <p className="text-body-s">
              <ExternalLink
                href={`${repo}/compare/${list.compare.from}...${list.compare.to}`}
              >
                {fill(t.commitsMore, { shown: list.commits.length })}
              </ExternalLink>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function TokenLine({ view }: { view: SiteDeployView }) {
  const state = tokenExpiryState(
    view.tokenExpiry,
    Date.parse(view.generatedAt),
  );
  const auth = authFailed(view);
  if (state.kind === "hidden" && !auth) return null;
  return (
    <div className="flex flex-col gap-1 text-caption">
      {state.kind === "unknown" && (
        <p className="flex items-center gap-1.5 text-text-body">
          <ToneIcon tone="neutral" />
          {t.tokenUnknown} · {reasonText(state.reason)}
        </p>
      )}
      {(state.kind === "ok" ||
        state.kind === "soon" ||
        state.kind === "expired") && (
        <p
          className={`flex flex-wrap items-center gap-1.5 ${
            state.kind === "ok"
              ? "text-text-muted"
              : state.kind === "soon"
                ? "text-status-stale-fg"
                : "text-danger-fg"
          }`}
        >
          {state.kind !== "ok" && (
            <ToneIcon tone={state.kind === "soon" ? "warn" : "fail"} />
          )}
          <span>{fill(t.token, { date: state.date })}</span>
          {state.kind === "soon" && (
            <span className="font-semibold">
              ·{" "}
              {state.days === 0
                ? t.tokenToday
                : fill(t.tokenSoon, { days: state.days })}
            </span>
          )}
          {state.kind === "expired" && (
            <span className="font-semibold">· {t.tokenExpired}</span>
          )}
        </p>
      )}
      {auth && (
        <p className="flex items-center gap-1.5 text-danger-fg">
          <ToneIcon tone="fail" />
          <span className="font-semibold">{t.authFailed}</span>
        </p>
      )}
    </div>
  );
}

function Content({ view }: { view: SiteDeployView }) {
  const repo = repoUrl(view);
  return (
    <div className="flex flex-col gap-3">
      <ReadinessLine view={view} />
      <Summary view={view} repo={repo} />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {view.sites.map((site) => (
          <SiteCard key={site.app} site={site} repo={repo} />
        ))}
      </div>
      <CommitList view={view} repo={repo} />
      <div className="flex flex-col gap-1 rounded-admin-box border border-border-default bg-bg-page px-3.5 py-3 text-body-s">
        {view.workflowUrl ? (
          <ExternalLink
            href={view.workflowUrl}
            className="inline-flex w-fit items-center gap-1"
          >
            {t.open}
            <ArrowIcon />
          </ExternalLink>
        ) : (
          <p className="flex items-center gap-1.5 text-text-body">
            <ToneIcon tone="neutral" />
            {t.openUnknown}
          </p>
        )}
        <p className="text-text-body">{t.openNote}</p>
        <p className="text-caption text-text-muted">{t.openPermission}</p>
      </div>
      <TokenLine view={view} />
    </div>
  );
}

// 값이 들어올 칸과 같은 자리(배포 상태 · 요약 3칸 · 사이트 2칸 · 커밋 목록 5줄 · GitHub 안내 · 토큰 줄 · 다시 읽기 안내)
// 커밋 수는 응답마다 달라(0~10줄) 가운데쯤인 5줄로 잡음
function Placeholder() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3">
      <SkBox className="h-[46px]" />
      <SkBox className="h-[280px] lg:h-[104px]" />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <SkBox className="h-[232px] lg:h-[190px]" />
        <SkBox className="h-[232px] lg:h-[190px]" />
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-body">
          <SkLine className="w-28" />
        </p>
        <ul className="flex flex-col divide-y divide-border-default border-t border-border-default">
          {[0, 1, 2, 3, 4].map((n) => (
            <li key={n} className="py-2 text-body-s">
              <SkLine className="w-3/5" />
            </li>
          ))}
        </ul>
      </div>
      <SkBox className="h-[124px] lg:h-[88px]" />
      <p className="text-caption">
        <SkLine className="w-48" />
      </p>
      <p className="text-caption">
        <SkLine className="w-56" />
      </p>
    </div>
  );
}

function useSiteDeploy(enabled: boolean) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  const [good, setGood] = useState<{
    view: SiteDeployView;
    at: string;
  } | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [reading, setReading] = useState(false);
  const [round, setRound] = useState(0);
  // 다음 다시 읽기 간격(받은 readiness로 정함). 바뀌어도 바로 다시 읽지 않게 ref로 둠
  const interval = useRef(refreshInterval(null));

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let seq = 0;
    let lastStart = 0;
    const refresh = () => {
      const id = ++seq;
      lastStart = Date.now();
      setReading(true);
      void fetchSiteDeploy(() => session.accessToken()).then((result) => {
        if (!live || id !== seq) return;
        setReading(false);
        if (result.ok) {
          const view = parseSiteDeploy(result.body);
          interval.current = refreshInterval(view.readiness);
          setGood({ view, at: new Date().toISOString() });
          setFailure(null);
        } else {
          // 실패해도 앞 값은 그대로 둠(값 유지)
          setFailure(result);
        }
      });
    };
    refresh();
    // 5초마다 때가 됐는지 봄(간격이 30초·1분으로 바뀌어도 타이머를 다시 만들지 않음)
    // 타이머는 조금 일찍 울릴 수 있어 1초 여유를 둠. 숨은 탭은 쉬고, 다시 보이면 지난 만큼 읽음
    const due = () =>
      document.visibilityState === "visible" &&
      Date.now() - lastStart >= interval.current - 1_000;
    const timer = window.setInterval(() => {
      if (due()) refresh();
    }, TICK_MS);
    const onVisible = () => {
      if (due()) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, session, generation, round]);

  return {
    data: good,
    failure,
    reading,
    reload: () => setRound((n) => n + 1),
  };
}

export function SiteDeployPanel({ demo }: { demo: boolean }) {
  const state = useSiteDeploy(!demo);
  const firstPending = !demo && state.data === null && state.failure === null;
  const timing = useLoadTiming(firstPending);
  const failed =
    state.failure !== null || (timing.timedOut && state.data === null);
  return (
    <section
      aria-labelledby="site-deploy-title"
      className="mt-6 flex flex-col gap-3 border-t border-border-default pt-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2
          id="site-deploy-title"
          className="text-title-s font-semibold text-text-default"
        >
          {t.title}
        </h2>
        {!demo && (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="small"
              busy={state.reading}
              busyLabel={tl.refreshing}
              onClick={state.reload}
            >
              {t.reload}
            </Button>
          </div>
        )}
      </div>
      <p className="text-body-s text-text-muted">{t.scope}</p>
      {demo ? (
        <p className="text-body-s text-text-body">{t.demo}</p>
      ) : (
        <>
          <LoadingStatus busy={firstPending} label={t.loading} />
          {failed && (
            <Notice tone="fail" title={t.failTitle} role="alert">
              <p>{t.failImpact}</p>
              <p>{t.failNext}</p>
              {state.data && (
                <p className="mt-1 text-text-muted">
                  {fill(t.failStale, { time: kstTime(state.data.at) })}
                </p>
              )}
            </Notice>
          )}
          {state.data ? (
            <div className={loadClass(timing)}>
              <Content view={state.data.view} />
              <p className="mt-3 text-caption text-text-muted">
                {refreshInterval(state.data.view.readiness) === 30_000
                  ? t.autoHalf
                  : t.autoMinute}
              </p>
            </div>
          ) : (
            !failed && (
              <div className={loadClass(timing)}>
                <Placeholder />
                {timing.slow && <SlowNote className="mt-2" />}
              </div>
            )
          )}
        </>
      )}
    </section>
  );
}
