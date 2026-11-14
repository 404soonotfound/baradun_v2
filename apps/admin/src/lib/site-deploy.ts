import type {
  SiteDeployApp as SiteApp,
  SiteDeployCiState as CiState,
  SiteDeployChangeFile as ChangeFile,
  SiteDeployCommit as DeployCommit,
  SiteDeployChanges as DeployChanges,
  SiteDeployDeployments as Deployments,
  SiteDeployFileCategory as FileCategory,
  SiteDeployMatchedRun as MatchedRun,
  SiteDeployReadiness as Readiness,
  SiteDeployReason,
  SiteDeployRun as DeployRun,
  SiteDeployScheduleReason,
  SiteDeploySite as SiteView,
  SiteDeployView as SiteDeployResponse,
  SiteDeployField as Field,
  SiteDeployKnown as Confirmed,
} from "@baradun/contracts";
import {
  CI_STATES,
  DEPLOY_EVENTS,
  FILE_CATEGORIES,
  READINESS,
  SCHEDULE_UNAVAILABLE,
  SITE_APPS,
  SITE_DEPLOY_REASONS,
} from "@baradun/contracts/site-deploy";
import { opsFetch, type OpsResult } from "./auth/ops-fetch";
import { kstClock, sameKstDay } from "./collection";
import { fill, messages } from "./messages";

// 칸마다 known / unknown 검사. 응답에서 확인 못 한 값은 invalid로 바꿈(D27-3).
type Token = () => Promise<string | null>;

export type {
  ChangeFile,
  CiState,
  DeployChanges,
  DeployCommit,
  DeployRun,
  Field,
  FileCategory,
  Readiness,
  SiteDeployReason,
  SiteView,
};

// 화면은 최근 작업의 확인 여부만 사용하고 형식이 맞지 않는 워크플로 링크는 숨김.
export type SiteDeployView = Omit<
  SiteDeployResponse,
  "recentJobs" | "workflowUrl"
> & {
  readonly recentJobs: Field<unknown>;
  readonly workflowUrl: string | null;
};

export function fetchSiteDeploy(
  accessToken: Token,
): Promise<OpsResult<unknown>> {
  return opsFetch("/ops/site-deploy", accessToken);
}

// ---- 모양 검사 ----

type Check<T> = (value: unknown) => T | undefined;

const SHA = /^[a-f\d]{40}$/;
const WORKFLOW_URL =
  /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/workflows\/deploy\.yml$/;
const RUN_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/;

const obj = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const isIso = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const oneOf =
  <T extends string>(list: readonly T[]): Check<T> =>
  (value) =>
    list.includes(value as T) ? (value as T) : undefined;
const listOf =
  <T>(item: Check<T>): Check<T[]> =>
  (value) => {
    if (!Array.isArray(value)) return undefined;
    const out: T[] = [];
    for (const entry of value) {
      const parsed = item(entry);
      if (parsed === undefined) return undefined;
      out.push(parsed);
    }
    return out;
  };

const sha: Check<string> = (value) =>
  typeof value === "string" && SHA.test(value) ? value : undefined;
const commit: Check<DeployCommit> = (value) => {
  const item = obj(value);
  const id = sha(item?.sha);
  if (!item || !id || typeof item.title !== "string") return undefined;
  return { sha: id, title: item.title };
};
const changeFile: Check<ChangeFile> = (value) => {
  const item = obj(value);
  const category = oneOf(FILE_CATEGORIES)(item?.category);
  if (!item || typeof item.path !== "string" || !category) return undefined;
  if (item.previous !== null && typeof item.previous !== "string")
    return undefined;
  return { path: item.path, previous: item.previous, category };
};
const changes: Check<DeployChanges> = (value) => {
  const item = obj(value);
  const from = sha(item?.from);
  const to = sha(item?.to);
  const files = listOf(changeFile)(item?.files);
  const commits = listOf(commit)(item?.commits);
  if (!from || !to || !files || !commits) return undefined;
  return { from, to, files, commits };
};
const run: Check<DeployRun> = (value) => {
  const item = obj(value);
  if (!item) return undefined;
  const event = oneOf(DEPLOY_EVENTS)(item.event);
  const id = sha(item.sha);
  if (
    !event ||
    !id ||
    !isCount(item.id) ||
    !isCount(item.attempt) ||
    typeof item.status !== "string" ||
    (item.conclusion !== null && typeof item.conclusion !== "string") ||
    !isIso(item.createdAt) ||
    typeof item.url !== "string" ||
    !RUN_URL.test(item.url)
  )
    return undefined;
  return {
    id: item.id,
    event,
    status: item.status,
    attempt: item.attempt,
    conclusion: item.conclusion,
    sha: id,
    createdAt: item.createdAt,
    url: item.url,
  };
};
const deployments: Check<Deployments> = (value) => {
  const item = obj(value);
  if (!item) return undefined;
  const recent = item.recent === null ? null : run(item.recent);
  const active = listOf(run)(item.active);
  if (recent === undefined || !active) return undefined;
  return { recent, active };
};
const settings: Check<{ paused: boolean; configured: boolean }> = (value) => {
  const item = obj(value);
  if (
    !item ||
    typeof item.paused !== "boolean" ||
    typeof item.configured !== "boolean"
  )
    return undefined;
  return { paused: item.paused, configured: item.configured };
};
const count: Check<number> = (value) => (isCount(value) ? value : undefined);
const bool: Check<boolean> = (value) =>
  typeof value === "boolean" ? value : undefined;
const manualCount: Check<{ since: string; requests: number }> = (value) => {
  const item = obj(value);
  if (!item || !isIso(item.since) || !isCount(item.requests)) return undefined;
  return { since: item.since, requests: item.requests };
};
// 만료일 태그(YYYY-MM-DD). 형식만 맞고 없는 날짜(2026-13-40 등)는 틀린 값
const expiry: Check<string | null> = (value) => {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return undefined;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value
    ? value
    : undefined;
};
const present: Check<unknown> = (value) => value;

function confirmed<T>(raw: unknown, check: Check<T>): Confirmed<T> | undefined {
  const item = obj(raw);
  if (!item || item.status !== "known" || !isIso(item.checkedAt))
    return undefined;
  const value = check(item.value);
  return value === undefined
    ? undefined
    : { status: "known", value, checkedAt: item.checkedAt };
}

// 칸 하나 읽기. 빠지거나 형식이 틀리면 invalid(확인 못 함). checkedAt을 모르면 응답 생성 시각
export function field<T>(
  raw: unknown,
  check: Check<T>,
  fallbackAt: string,
): Field<T> {
  const known = confirmed(raw, check);
  if (known) return known;
  const item = obj(raw);
  const reason = oneOf(SITE_DEPLOY_REASONS)(item?.reason);
  if (item?.status === "unknown" && reason && isIso(item.checkedAt)) {
    const last =
      item.last === undefined ? undefined : confirmed(item.last, check);
    return {
      status: "unknown",
      reason,
      checkedAt: item.checkedAt,
      ...(last ? { last } : {}),
      ...(isIso(item.retryAt) ? { retryAt: item.retryAt } : {}),
    };
  }
  return { status: "unknown", reason: "invalid", checkedAt: fallbackAt };
}

function matchedRun(value: unknown): MatchedRun | null {
  const item = obj(value);
  if (
    !item ||
    item.event !== "workflow_dispatch" ||
    typeof item.url !== "string" ||
    !RUN_URL.test(item.url)
  )
    return null;
  return {
    event: "workflow_dispatch",
    url: item.url,
    completedAt: isIso(item.completedAt) ? item.completedAt : null,
  };
}

function site(
  app: SiteApp,
  raw: unknown,
  generatedAt: string,
  repo: string | undefined,
  mainSha: string | undefined,
): SiteView {
  const item = obj(raw) ?? {};
  const deployed = field(item.deployed, sha, generatedAt);
  const compareUrl =
    repo &&
    mainSha &&
    deployed.status === "known" &&
    item.compareUrl ===
      `https://github.com/${repo}/compare/${deployed.value}...${mainSha}`
      ? item.compareUrl
      : undefined;
  return {
    app,
    deployed,
    detail: field(item.detail, commit, generatedAt),
    changes: field(item.changes, changes, generatedAt),
    // 표시와 실행이 맞을 때만 서버가 줌. 모양이 틀리면 숨김(단정하지 않음)
    matchedRun: matchedRun(item.matchedRun),
    ...(compareUrl ? { compareUrl } : {}),
  };
}

const known = (f: Field<unknown>) => f.status === "known";

// 서버 ready 조건을 화면이 받은 값으로 다시 확인(읽지 못한 칸이 있으면 '배포할 수 있어요'를 띄우지 않음)
function readyConfirmed(view: Omit<SiteDeployView, "readiness">): boolean {
  return (
    known(view.main) &&
    view.ci.status === "known" &&
    view.ci.value === "success" &&
    view.settings.status === "known" &&
    !view.settings.value.paused &&
    view.settings.value.configured &&
    view.workflowActive.status === "known" &&
    view.workflowActive.value &&
    view.deployments.status === "known" &&
    view.deployments.value.active.length === 0 &&
    view.approvals.status === "known" &&
    view.approvals.value.length === 0 &&
    known(view.recentJobs) &&
    view.sites.every(
      (s) => known(s.deployed) && known(s.detail) && known(s.changes),
    )
  );
}

// 본문이 객체가 아니거나 생성 시각이 없으면 null(응답을 읽지 못함 → 실패 문구). 화면 시계로 확인 시각을 지어내지 않음
export function parseSiteDeploy(raw: unknown): SiteDeployView | null {
  const body = obj(raw);
  if (!body || !isIso(body.generatedAt)) return null;
  const generatedAt = body.generatedAt;
  const rawSites = Array.isArray(body.sites) ? body.sites : [];
  const workflowMatch =
    typeof body.workflowUrl === "string"
      ? WORKFLOW_URL.exec(body.workflowUrl)
      : null;
  const workflowUrl = workflowMatch?.[0] ?? null;
  const main = field(body.main, commit, generatedAt);
  const sites = SITE_APPS.map((app) =>
    site(
      app,
      rawSites.find((entry) => obj(entry)?.app === app),
      generatedAt,
      workflowMatch?.[1],
      main.status === "known" ? main.value.sha : undefined,
    ),
  );
  const nextScheduledAt =
    body.nextScheduledAtReason === undefined && isIso(body.nextScheduledAt)
      ? body.nextScheduledAt
      : null;
  const nextScheduledAtReason: SiteDeployScheduleReason | undefined =
    body.nextScheduledAt === null
      ? body.nextScheduledAtReason === undefined
        ? undefined
        : scheduleReason(body.nextScheduledAtReason)
      : nextScheduledAt === null
        ? { kind: "unknown", reason: "invalid" }
        : undefined;
  const rest: Omit<SiteDeployView, "readiness"> = {
    generatedAt,
    readinessCheckedAt: isIso(body.readinessCheckedAt)
      ? body.readinessCheckedAt
      : generatedAt,
    main,
    ci: field(body.ci, oneOf(CI_STATES), generatedAt),
    settings: field(body.settings, settings, generatedAt),
    workflowActive: field(body.workflowActive, bool, generatedAt),
    deployments: field(body.deployments, deployments, generatedAt),
    approvals: field(body.approvals, listOf(count), generatedAt),
    recentJobs: field(body.recentJobs, present, generatedAt),
    manualCount: field(body.manualCount, manualCount, generatedAt),
    tokenExpiry: field(body.tokenExpiry, expiry, generatedAt),
    sites,
    nextScheduledAt,
    ...(nextScheduledAtReason ? { nextScheduledAtReason } : {}),
    workflowUrl,
  };
  let readiness = oneOf(READINESS)(body.readiness) ?? "unknown";
  if (readiness === "ready" && !readyConfirmed(rest)) readiness = "unknown";
  return { ...rest, readiness };
}

// ---- 화면 계산 ----

const KST_OFFSET_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const kstDay = (ms: number) => Math.floor((ms + KST_OFFSET_MS) / DAY_MS);

// KST 시각. now와 날짜가 다르면 M/D를 붙임(전날 값을 오늘 값처럼 보이지 않게)
export function kstTime(iso: string, now: number): string {
  return kstClock(iso, new Date(now).toISOString());
}

const kstHm = (ms: number) => {
  const d = new Date(ms + KST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
};

// 다음 정기 배포(KST 오늘·내일). 서버는 일시 정지·워크플로 꺼짐뿐 아니라 그 조회를 못 했을 때도 null을 줌
// → 멈춤은 확인한 때만, 조회 실패는 확인 못 함. 이미 지난 시각(앞 값을 들고 있을 때)은 날짜와 함께
// 배포 설정(저장소 변수)이 끝나지 않았으면 정기 실행이 돌아도 배포 작업은 건너뜀 → 시각 대신 설정 안내
export type ScheduleLabel =
  | { kind: "paused" }
  | { kind: "unconfigured" }
  | { kind: "unknown"; reason: SiteDeployReason; retryAt?: string }
  | { kind: "today" | "tomorrow"; time: string }
  | { kind: "date" | "passed"; date: string; time: string };

function scheduleReason(raw: unknown): SiteDeployScheduleReason {
  const item = obj(raw);
  const kind = oneOf(SCHEDULE_UNAVAILABLE)(item?.kind);
  if (kind) return { kind };
  const reason = oneOf(SITE_DEPLOY_REASONS)(item?.reason);
  if (item?.kind === "unknown" && reason) {
    return {
      kind: "unknown",
      reason,
      ...(isIso(item.retryAt) ? { retryAt: item.retryAt } : {}),
    };
  }
  return { kind: "unknown", reason: "invalid" };
}

export function scheduleLabel(
  view: Pick<
    SiteDeployView,
    "nextScheduledAt" | "nextScheduledAtReason" | "settings" | "workflowActive"
  >,
  now: number,
): ScheduleLabel {
  const { settings, workflowActive, nextScheduledAtReason } = view;
  if (!view.nextScheduledAt && nextScheduledAtReason) {
    // 문구는 기존과 같은 정지 상태 사용.
    if (nextScheduledAtReason.kind === "workflow_disabled")
      return { kind: "paused" };
    if (nextScheduledAtReason.kind === "unknown") return nextScheduledAtReason;
    return { kind: nextScheduledAtReason.kind };
  }
  // 이전 운영 API 응답의 호환 경로.
  if (
    settings.status === "known" &&
    !settings.value.paused &&
    !settings.value.configured
  )
    return { kind: "unconfigured" };
  if (view.nextScheduledAt) {
    const at = Date.parse(view.nextScheduledAt);
    const diff = kstDay(at) - kstDay(now);
    const { date, time } = kstHm(at);
    // 이미 지난 시각: 앞 값을 들고 있는 동안(다시 읽기 실패) 그 실행이 돌았는지 모름 → 지났다고만 알림
    if (at <= now) return { kind: "passed", date, time };
    if (diff === 0) return { kind: "today", time };
    if (diff === 1) return { kind: "tomorrow", time };
    return { kind: "date", date, time };
  }
  if (
    (settings.status === "known" && settings.value.paused) ||
    (workflowActive.status === "known" && !workflowActive.value)
  )
    return { kind: "paused" };
  const failed =
    settings.status === "unknown"
      ? settings
      : workflowActive.status === "unknown"
        ? workflowActive
        : null;
  return {
    kind: "unknown",
    reason: failed?.reason ?? "invalid",
    ...(failed?.retryAt ? { retryAt: failed.retryAt } : {}),
  };
}

// 수동 배포 요청 수의 기준 날(KST 자정부터). now와 같은 날이면 null(오늘), 아니면 M/D
export function manualDay(since: string, now: number): string | null {
  return sameKstDay(since, new Date(now).toISOString())
    ? null
    : kstHm(Date.parse(since)).date;
}

// 토큰 만료: 날짜 태그가 없으면 숨김, 확인 못 하면 unknown, 30일 안(또는 지남)이면 경고
export const TOKEN_WARN_DAYS = 30;
export type TokenExpiryState =
  | { kind: "hidden" }
  | { kind: "unknown"; reason: SiteDeployReason; retryAt?: string }
  | { kind: "ok"; date: string; days: number }
  | { kind: "soon"; date: string; days: number }
  | { kind: "expired"; date: string };

export function tokenExpiryState(
  f: Field<string | null>,
  now: number,
): TokenExpiryState {
  if (f.status === "unknown")
    return {
      kind: "unknown",
      reason: f.reason,
      ...(f.retryAt ? { retryAt: f.retryAt } : {}),
    };
  if (f.value === null) return { kind: "hidden" };
  // 만료일(YYYY-MM-DD)은 그날 끝까지 쓸 수 있다고 보고 KST 날짜 차이로 셈
  const days =
    Math.floor(Date.parse(`${f.value}T00:00:00Z`) / DAY_MS) - kstDay(now);
  if (days < 0) return { kind: "expired", date: f.value };
  if (days <= TOKEN_WARN_DAYS) return { kind: "soon", date: f.value, days };
  return { kind: "ok", date: f.value, days };
}

// 저장소 주소(링크용). workflowUrl에서만 꺼냄
export function repoUrl(
  view: Pick<SiteDeployView, "workflowUrl">,
): string | null {
  const match = view.workflowUrl ? WORKFLOW_URL.exec(view.workflowUrl) : null;
  return match ? `https://github.com/${match[1]}` : null;
}

// 커밋 제목 앞 GH-번호(이슈 링크). 제목에 쓰인 글자 그대로 잘라 나머지 제목을 돌려줌
export function issuePrefix(
  title: string,
): { issue: number; label: string; rest: string } | null {
  const match = /^GH-(\d+)\b/.exec(title);
  return match
    ? {
        issue: Number(match[1]),
        label: match[0],
        rest: title.slice(match[0].length),
      }
    : null;
}

export const COMMIT_LIMIT = 10;

// 두 사이트의 아직 안 나간 커밋을 하나로(중복 제거, 최신 먼저). 확인 못 한 사이트가 있으면 complete=false
export function pendingCommits(sites: readonly SiteView[]): {
  commits: DeployCommit[];
  total: number;
  complete: boolean;
  compareUrl: string | null;
} {
  const seen = new Map<string, DeployCommit>();
  const known = sites.flatMap((s) =>
    s.changes.status === "known"
      ? [{ changes: s.changes.value, compareUrl: s.compareUrl }]
      : [],
  );
  const complete = known.length === sites.length;
  // 긴 범위(더 뒤처진 사이트)의 순서를 기준으로 합침. 두 범위 모두 main 최신에서 끝나 짧은 쪽이 긴 쪽 안에 듦
  // 긴 쪽에 없는 커밋(기록이 갈라진 경우)은 맨 아래(가장 오래된 쪽)에 둠 → 최신 커밋이 잘리지 않음
  const ordered = [...known].sort(
    (a, b) => b.changes.commits.length - a.changes.commits.length,
  );
  const widest = ordered[0] ?? null;
  for (const c of widest?.changes.commits ?? []) seen.set(c.sha, c);
  const extra: DeployCommit[] = [];
  for (const value of ordered.slice(1))
    for (const c of value.changes.commits)
      if (!seen.has(c.sha)) {
        seen.set(c.sha, c);
        extra.push(c);
      }
  // GitHub Compare는 오래된 커밋부터 줌 → 최신 먼저
  const all = [...extra, ...(widest?.changes.commits ?? [])].reverse();
  return {
    commits: all.slice(0, COMMIT_LIMIT),
    total: all.length,
    complete,
    compareUrl: widest?.compareUrl ?? null,
  };
}

// 진행 중·승인 대기면 30초, 그 밖은 1분(화면 설계서 ADM-PUB 다시 읽기)
export function refreshInterval(readiness: Readiness | null): number {
  return readiness === "deploying" || readiness === "approval_pending"
    ? 30_000
    : 60_000;
}

// 승인 대기 실행 주소(승인 ID와 같은 진행 중 실행). 없으면 첫 진행 중 실행
export function actionRunUrl(view: SiteDeployView): string | null {
  if (view.deployments.status !== "known") return null;
  const active = view.deployments.value.active;
  if (
    view.readiness === "approval_pending" &&
    view.approvals.status === "known"
  ) {
    const id = view.approvals.value[0];
    const match = active.find((r) => r.id === id);
    if (match) return match.url;
  }
  return active[0]?.url ?? null;
}

// 칸 가운데 인증 실패가 있는지(만료일 확인 못 함과 인증 실패를 나눠 보이려고, ADM-PUB 토큰 만료일)
export function authFailed(view: SiteDeployView): boolean {
  const fields: Field<unknown>[] = [
    view.main,
    view.ci,
    view.settings,
    view.workflowActive,
    view.deployments,
    view.approvals,
    view.recentJobs,
    view.manualCount,
    ...view.sites.flatMap((s) => [s.detail, s.changes]),
  ];
  return fields.some(
    (f) => f.status === "unknown" && f.reason === "unauthorized",
  );
}

// 확인 못 한 사유 → 사람 말(내부 코드를 보이지 않음). 조회 한도는 다시 확인할 시각(KST)과 함께
export function reasonText(
  reason: SiteDeployReason,
  now: number,
  retryAt?: string | undefined,
): string {
  const r = messages.siteDeploy.reason;
  // 다시 확인할 시각이 이미 지났으면 시각 없이(지난 시각 '이후'로 보이지 않게)
  if (reason === "rate_limit")
    return retryAt && Date.parse(retryAt) > now
      ? fill(r.rateLimitAt, { time: kstTime(retryAt, now) })
      : r.rate_limit;
  if (reason === "credential_missing" || reason === "credentials")
    return r.credentials;
  if (
    reason === "unconfigured" ||
    reason === "unauthorized" ||
    reason === "truncated" ||
    reason === "not_ancestor"
  )
    return r[reason];
  return r.other;
}

// 확인 못 한 칸에 앞 값이 있으면 '마지막으로 확인한 값 · HH:MM 기준'. 없으면 null
export function lastText(field: Field<unknown>, now: number): string | null {
  if (field.status !== "unknown" || !field.last) return null;
  return fill(messages.siteDeploy.last, {
    time: kstTime(field.last.checkedAt, now),
  });
}
