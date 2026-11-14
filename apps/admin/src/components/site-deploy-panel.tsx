"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import { fill, messages } from "@/lib/messages";
import {
  actionRunUrl,
  authFailed,
  fetchSiteDeploy,
  issuePrefix,
  kstTime,
  parseSiteDeploy,
  lastText,
  manualDay,
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
  SkLine,
  SlowNote,
  loadClass,
  useLoadTiming,
} from "./loading";
import { LOADING_TIMES } from "@/lib/loading-timing";
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

// 화면 시각의 기준(마지막 응답을 받은 시각, ms). 오늘·내일·남은 날·날짜 붙이기를 이 시각으로 셈
// 렌더 중에 시계를 읽지 않으려고 응답 때 정한 값을 넘김
const NowContext = createContext(0);
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
  const now = useContext(NowContext);
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
            · {reasonText(field.reason, now, field.retryAt)}
          </span>
        </span>
      </p>
      {field.last && render && (
        <div className="flex flex-col gap-0.5 border-l-2 border-border-default pl-2.5">
          <p className="text-caption text-text-muted">{lastText(field, now)}</p>
          <div className="text-text-muted">{render(field.last.value)}</div>
        </div>
      )}
    </div>
  );
}

// 짧은 SHA(앞 7자리). 저장소 주소를 알면 커밋 링크
function ShaLink({ sha, repo }: { sha: string; repo: string | null }) {
  const short = sha.slice(0, 7);
  return repo ? (
    <ExternalLink href={`${repo}/commit/${sha}`} className="font-mono">
      {short}
    </ExternalLink>
  ) : (
    <code className="font-mono">{short}</code>
  );
}

function CommitLine({
  commit,
  repo,
}: {
  commit: DeployCommit;
  repo: string | null;
}) {
  const prefix = issuePrefix(commit.title);
  const rest = prefix ? prefix.rest : commit.title;
  return (
    <span className="min-w-0 text-body-s break-words text-text-default">
      <ShaLink sha={commit.sha} repo={repo} />{" "}
      {prefix &&
        (repo ? (
          <ExternalLink href={`${repo}/issues/${prefix.issue}`}>
            {prefix.label}
          </ExternalLink>
        ) : (
          <span>{prefix.label}</span>
        ))}
      <span>{rest}</span>
    </span>
  );
}

// 펼치기 표시(접힘 → 오른쪽, 펼침 → 아래). 동작 줄이기면 돌지 않고 바로 바뀜
function Chevron({ open }: { open?: boolean }) {
  return (
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
      className={`shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none ${
        open ? "rotate-90" : ""
      }`}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function ChangedFiles({ changes }: { changes: DeployChanges }) {
  if (changes.files.length === 0)
    return <p className="text-body-s text-text-body">{t.filesNone}</p>;
  return (
    <details className="group text-body-s">
      <summary className="inline-flex min-h-touch cursor-pointer items-center gap-1 font-medium text-text-default lg:min-h-0">
        <Chevron />
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
  const now = useContext(NowContext);
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
              {fill(t.checkedAt, {
                time: kstTime(site.deployed.checkedAt, now),
              })}
              {run && (
                <>
                  {" · "}
                  {fill(run.completedAt ? t.runAt : t.runNoTime, {
                    event: t.runEvent[run.event],
                    time: run.completedAt ? kstTime(run.completedAt, now) : "",
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
          // 배포 커밋(표지)은 확인했고 커밋 제목 조회만 못 함 → 확인한 SHA는 그대로 보임
          site.detail.status === "unknown" && (
            <>
              <span className="text-body-s text-text-default">
                <ShaLink sha={site.deployed.value} repo={repo} />
              </span>
              <p className="text-caption text-text-muted">
                {fill(t.checkedAt, {
                  time: kstTime(site.deployed.checkedAt, now),
                })}
              </p>
              <Unknown
                label={t.detailUnknown}
                field={site.detail}
                render={deployedCommit}
              />
            </>
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

// stale: 다시 읽기가 실패해 앞 값을 들고 있음 → 지금 상태로 단정하지 않음(D27-3)
// 앞 readiness(특히 '배포할 수 있어요')를 띄우지 않고 중립 표시와 마지막 조회 시각만
function ReadinessLine({
  view,
  stale,
}: {
  view: SiteDeployView;
  stale: boolean;
}) {
  const now = useContext(NowContext);
  if (stale) {
    return (
      <div className="flex flex-col gap-1 rounded-admin-box border border-border-default bg-bg-page px-3.5 py-3">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-s">
          <span className="sr-only">{t.readinessTitle}: </span>
          <ToneIcon tone="neutral" />
          <span className="font-semibold text-text-default">
            {t.readinessStale}
          </span>
          <span className="text-caption text-text-muted">
            {fill(t.readinessAt, {
              time: kstTime(view.readinessCheckedAt, now),
            })}
          </span>
        </p>
      </div>
    );
  }
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
          {fill(t.readinessAt, { time: kstTime(view.readinessCheckedAt, now) })}
        </span>
      </p>
      {view.readiness === "paused" && (
        <p className="text-caption text-text-body">{t.pausedNote}</p>
      )}
      {view.readiness === "ready" &&
        view.sites.every(
          (s) =>
            s.changes.status === "known" &&
            s.changes.value.files.length === 0 &&
            s.changes.value.commits.length === 0,
        ) && <p className="text-caption text-text-body">{t.readyNoChanges}</p>}
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
  const now = useContext(NowContext);
  const schedule = scheduleLabel(view, now);
  const manualText = (value: { since: string; requests: number }) => {
    const day = manualDay(value.since, now);
    return day
      ? fill(t.manualOn, { date: day, count: value.requests })
      : fill(t.manual, { count: value.requests });
  };
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
              · {reasonText(view.ci.reason, now, view.ci.retryAt)}
            </span>
          )}
        </span>
      </SummaryItem>
      <SummaryItem label={t.scheduleTitle}>
        {schedule.kind === "unknown" ? (
          <p className="flex items-start gap-1.5 text-body-s">
            <span className="mt-0.5">
              <ToneIcon tone="neutral" />
            </span>
            <span>
              <span className="font-semibold text-text-default">
                {t.scheduleUnknown}
              </span>
              <span className="text-text-body">
                {" "}
                · {reasonText(schedule.reason, now, schedule.retryAt)}
              </span>
            </span>
          </p>
        ) : (
          <span className="text-title-s font-normal text-text-default tabular-nums">
            {schedule.kind === "paused" || schedule.kind === "unconfigured"
              ? t.schedule[schedule.kind]
              : fill(t.schedule[schedule.kind], {
                  time: schedule.time,
                  date:
                    schedule.kind === "date" || schedule.kind === "passed"
                      ? schedule.date
                      : "",
                })}
          </span>
        )}
      </SummaryItem>
      <SummaryItem label={t.manualTitle}>
        {view.manualCount.status === "known" ? (
          <span className="text-body-s text-text-default tabular-nums">
            {manualText(view.manualCount.value)}
          </span>
        ) : (
          <Unknown
            label={t.manualUnknown}
            field={view.manualCount}
            render={(value) => (
              <span className="text-body-s">{manualText(value)}</span>
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
  // 기본은 접음(칸 높이를 커밋 수와 상관없이 고정). 다시 읽어도 펼친 상태는 유지
  const [open, setOpen] = useState(false);
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
            <>
              <button
                type="button"
                aria-expanded={open}
                aria-controls="site-deploy-commit-list"
                onClick={() => setOpen((v) => !v)}
                className="inline-flex min-h-touch w-fit cursor-pointer items-center gap-1 text-body-s font-medium text-text-default lg:min-h-0"
              >
                <Chevron open={open} />
                {fill(list.complete ? t.commitsShow : t.commitsShowPartial, {
                  count: list.total,
                })}
              </button>
              {open && (
                <div
                  id="site-deploy-commit-list"
                  className="flex flex-col gap-2"
                >
                  <ul className="flex flex-col divide-y divide-border-default border-t border-border-default">
                    {list.commits.map((commit) => (
                      <li key={commit.sha} className="py-2">
                        <CommitLine commit={commit} repo={repo} />
                      </li>
                    ))}
                  </ul>
                  {list.total > list.commits.length && list.compareUrl && (
                    <p className="text-body-s">
                      <ExternalLink href={list.compareUrl}>
                        {fill(t.commitsMore, { shown: list.commits.length })}
                      </ExternalLink>
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function TokenLine({ view }: { view: SiteDeployView }) {
  const now = useContext(NowContext);
  const state = tokenExpiryState(view.tokenExpiry, now);
  const auth = authFailed(view);
  if (state.kind === "hidden" && !auth) return null;
  return (
    <div className="flex flex-col gap-1 text-caption">
      {state.kind === "unknown" && (
        <p className="flex items-center gap-1.5 text-text-body">
          <ToneIcon tone="neutral" />
          {t.tokenUnknown} · {reasonText(state.reason, now, state.retryAt)}
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

function Content({ view, stale }: { view: SiteDeployView; stale: boolean }) {
  const repo = repoUrl(view);
  return (
    <div className="flex flex-col gap-3">
      <ReadinessLine view={view} stale={stale} />
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

// 커밋 줄은 고정폭 글꼴 SHA가 섞여 줄 상자가 조금 큼 → 같은 글꼴의 폭 없는 글자로 같은 줄 높이를 만듦
function MonoStrut() {
  return <span className="font-mono">{"\u200b"}</span>;
}

// 값이 들어올 칸과 같은 틀(배포 상태 · 요약 3칸 · 사이트 2칸 · 접힌 커밋 목록 · GitHub 안내 · 토큰 줄 · 다시 읽기 안내)
// 라벨·고정 안내는 그대로, 값 자리만 회색 줄(홈 화면과 같은 방식). 테두리·여백·글자 크기가 같아 높이가 같음
function Placeholder() {
  return (
    <div aria-hidden="true">
      <div className="flex flex-col gap-3">
        <div className="rounded-admin-box border border-border-default bg-bg-page px-3.5 py-3">
          <p className="text-body-s">
            <SkLine className="w-[260px] max-w-full" />
          </p>
        </div>
        <dl className="grid grid-cols-1 overflow-hidden rounded-admin-box border border-border-default bg-bg-surface lg:grid-cols-3">
          <SummaryItem label={t.mainTitle}>
            <p className="text-body-s">
              <MonoStrut />
              <SkLine className="w-[220px] max-w-full" />
            </p>
            <p className="text-body-s">
              <SkLine className="w-14" />
            </p>
          </SummaryItem>
          <SummaryItem label={t.scheduleTitle}>
            <p className="text-title-s">
              <SkLine className="w-24" />
            </p>
          </SummaryItem>
          <SummaryItem label={t.manualTitle}>
            <p className="text-body-s">
              <SkLine className="w-[240px] max-w-full" />
            </p>
            <span className="text-caption text-text-muted">{t.manualNote}</span>
          </SummaryItem>
        </dl>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {(["site", "admin"] as const).map((app) => (
            <div
              key={app}
              className="flex min-w-0 flex-col gap-3 rounded-admin-box border border-border-default bg-bg-surface px-4 py-3.5"
            >
              <p className="text-body font-semibold text-text-default">
                {t.sites[app]}
              </p>
              <div className="flex flex-col gap-1">
                <p className="text-caption font-semibold text-text-body">
                  {t.deployedCommit}
                </p>
                <p className="text-body-s">
                  <MonoStrut />
                  <SkLine className="w-[220px] max-w-full" />
                </p>
                <p className="text-caption">
                  <SkLine className="w-[180px] max-w-full" />
                </p>
              </div>
              <div className="flex flex-col gap-1 border-t border-border-default pt-3">
                <p className="text-caption font-semibold text-text-body">
                  {t.pendingTitle}
                </p>
                {/* 바뀐 파일 줄: details 안 inline-flex summary와 같은 구조 */}
                <div className="text-body-s">
                  <span className="inline-flex min-h-touch items-center gap-1 lg:min-h-0">
                    {/* 펼치기 아이콘(12px) 자리. 첫 항목이 아이콘이라 기준선이 달라지는 것까지 같게 */}
                    <span className="size-3 shrink-0" />
                    <span>
                      <SkLine className="w-32" />
                    </span>
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <p className="text-body font-semibold text-text-default">
              {t.commitsTitle}
            </p>
            <span className="text-body-s">
              <SkLine className="w-6" />
            </span>
          </div>
          <p className="flex min-h-touch items-center text-body-s lg:min-h-0">
            <span>
              <SkLine className="w-28" />
            </span>
          </p>
        </div>
        <div className="flex flex-col gap-1 rounded-admin-box border border-border-default bg-bg-page px-3.5 py-3 text-body-s">
          <p>
            <SkLine className="w-36" />
          </p>
          <p className="text-text-body">{t.openNote}</p>
          <p className="text-caption text-text-muted">{t.openPermission}</p>
        </div>
        <p className="text-caption">
          <SkLine className="w-48" />
        </p>
      </div>
      <p className="mt-3 text-caption">
        <SkLine className="w-56" />
      </p>
    </div>
  );
}

// 받은 값(성공 값·실패·마지막 응답 시각)을 받은 세션 세대와 함께 둠
interface Received {
  readonly gen: number;
  readonly good: { view: SiteDeployView; at: string } | null;
  readonly failure: Failed | null;
  // 마지막 응답(성공·실패)을 받은 시각. 화면 시각 계산의 기준
  readonly now: number;
}
const NOTHING = { good: null, failure: null, now: 0 } as const;

function useSiteDeploy(enabled: boolean) {
  // session은 AuthProvider가 useState(createSession)로 탭에서 한 번만 만든 객체라 렌더마다 바뀌지 않음
  // → 아래 효과 의존성에 넣어도 요청이 되풀이되지 않음(운영 홈·데이터 게시와 같은 가정)
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const signedIn = snapshot.status !== "signed_out";
  const generation = signedIn ? snapshot.generation : 0;
  const [received, setReceived] = useState<Received>({ gen: -1, ...NOTHING });
  // 읽는 중인 요청의 세대(없으면 null)
  const [readingGen, setReadingGen] = useState<number | null>(null);
  const [round, setRound] = useState(0);
  // 다음 다시 읽기 간격(받은 readiness로 정함). 바뀌어도 바로 다시 읽지 않게 ref로 둠
  const interval = useRef(refreshInterval(null));

  // 로그아웃 상태에서는 요청하지 않음(#462 운영 홈과 같음). 세대가 바뀌면 효과가 새로 돌고 앞 세대 응답은 버림
  useEffect(() => {
    if (!enabled || !signedIn) return;
    const gen = generation;
    let live = true;
    let seq = 0;
    let lastStart = 0;
    let limit = 0;
    const refresh = () => {
      const id = ++seq;
      lastStart = Date.now();
      setReadingGen(gen);
      // 15초 안에 응답이 없으면 이 요청을 버리고 실패로 둠(D26-4). 늦게 온 응답은 무시하고 다시 불러오기를 막지 않음
      window.clearTimeout(limit);
      limit = window.setTimeout(() => {
        if (!live || id !== seq) return;
        seq++;
        setReadingGen(null);
        setReceived((prev) => ({
          gen,
          good: prev.gen === gen ? prev.good : null,
          failure: { ok: false, status: 0, code: "network" },
          now: Date.now(),
        }));
      }, LOADING_TIMES.timeout);
      void fetchSiteDeploy(() => session.accessToken()).then((result) => {
        if (!live || id !== seq) return;
        window.clearTimeout(limit);
        setReadingGen(null);
        const at = Date.now();
        const view = result.ok ? parseSiteDeploy(result.body) : null;
        if (view) {
          interval.current = refreshInterval(view.readiness);
          setReceived({
            gen,
            good: { view, at: new Date(at).toISOString() },
            failure: null,
            now: at,
          });
        } else {
          // 실패·읽을 수 없는 본문도 같은 세대의 앞 값은 그대로 둠(값 유지)
          const failure: Failed = result.ok
            ? {
                ok: false,
                status: result.status,
                code: "invalid",
                requestId: null,
              }
            : result;
          setReceived((prev) => ({
            gen,
            good: prev.gen === gen ? prev.good : null,
            failure,
            now: at,
          }));
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
      window.clearTimeout(limit);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, signedIn, session, generation, round]);

  // 로그아웃·세션 만료 뒤(로그인 화면으로 가는 중)와 세대가 바뀐 뒤에는 앞 세션에서 받은 배포 정보를 그리지 않음
  // 상태를 지우는 대신 세대로 걸러, 바뀐 순간의 렌더에서도 앞 값이 보이지 않게 함
  const current = signedIn && received.gen === generation;
  const shown = current ? received : NOTHING;
  return {
    signedIn,
    data: shown.good,
    failure: shown.failure,
    now: shown.now,
    reading: signedIn && readingGen === generation,
    reload: () => setRound((n) => n + 1),
  };
}

export function SiteDeployPanel({ demo }: { demo: boolean }) {
  const state = useSiteDeploy(!demo);
  const firstPending = !demo && state.data === null && state.failure === null;
  const timing = useLoadTiming(firstPending);
  // 로그아웃 상태(로그인 화면으로 가는 중)는 요청하지 않으므로 자리표시만 두고 시간 제한 실패로 바꾸지 않음
  const failed =
    state.failure !== null ||
    (state.signedIn && timing.timedOut && state.data === null);
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
          {failed &&
            (state.failure?.code === "reauth" ? (
              <Notice
                tone="warn"
                title={messages.inquiries.reauth}
                role="alert"
              >
                {state.data && (
                  <p className="text-text-muted">
                    {fill(t.failStale, {
                      time: kstTime(state.data.at, state.now),
                    })}
                  </p>
                )}
              </Notice>
            ) : (
              <Notice tone="fail" title={t.failTitle} role="alert">
                <p>{t.failImpact}</p>
                <p>{t.failNext}</p>
                {state.failure &&
                  "requestId" in state.failure &&
                  state.failure.requestId && (
                    <p>
                      {fill(messages.inquiries.requestId, {
                        id: state.failure.requestId,
                      })}
                    </p>
                  )}
                {state.data && (
                  <p className="mt-1 text-text-muted">
                    {fill(t.failStale, {
                      time: kstTime(state.data.at, state.now),
                    })}
                  </p>
                )}
              </Notice>
            ))}
          {state.data ? (
            <div className={loadClass(timing)}>
              <NowContext.Provider value={state.now}>
                <Content
                  view={state.data.view}
                  stale={state.failure !== null}
                />
              </NowContext.Provider>
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
