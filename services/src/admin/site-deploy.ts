import type {
  SiteDeployApp as App,
  SiteDeployEvent as Event,
  SiteDeployCiState as CiState,
  SiteDeployFileCategory,
  SiteDeployReadiness as Readiness,
  SiteDeployRun as DeployRun,
  SiteDeployScheduleReason,
  SiteDeploySettings,
  SiteDeployView,
  SiteDeployWorkflowActiveField,
  SiteDeployField as Field,
  SiteDeployKnown as Confirmed,
} from "@baradun/contracts";
import { DEPLOY_EVENTS, SITE_APPS } from "@baradun/contracts/site-deploy";
import { SSMClient } from "@aws-sdk/client-ssm";
import appPaths from "../../../.github/site-deploy-paths.json";
import { parseUtcIso } from "../core/warnings/time";
import { createSiteDeployCredential } from "./site-deploy-credential";
import {
  createSiteDeployGitHub,
  record,
  rows,
  SiteDeployError,
} from "./site-deploy-github";

type GitHub = ReturnType<typeof createSiteDeployGitHub>;
type Read = (path: string) => ReturnType<GitHub>;

const SHA = /^[a-f\d]{40}$/;
const ACTIVE = ["queued", "in_progress", "waiting", "pending", "requested"];
const CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
];
export const SITE_DEPLOY_JOBS = SITE_APPS;
export const SITE_DEPLOY_MARKER_STEP = "올린 커밋 표시";
const CACHE_MS = 30_000;
const KST_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const DEPLOY_TIME_MS = (5 * 60 + 17) * 60_000;
const WORKFLOW = "/actions/workflows/deploy.yml";
const RUNS = WORKFLOW + "/runs";
export const DEPLOY_VARIABLES = [
  "DEPLOY_ROLE_ARN",
  "SITE_BUCKET",
  "DISTRIBUTION_ID",
  "SITE_URL",
  "INQUIRY_PHOTO_BUCKET",
  "ADMIN_SITE_BUCKET",
  "ADMIN_DISTRIBUTION_ID",
  "OPERATOR_USER_POOL_ID",
  "OPERATOR_CLIENT_ID",
  "DEMO_USER_POOL_ID",
  "DEMO_CLIENT_ID",
];

function sha(value: unknown): string {
  if (typeof value !== "string" || !SHA.test(value))
    throw new SiteDeployError("invalid");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new SiteDeployError("invalid");
  return value;
}

function date(value: unknown): string {
  const timestamp = text(value);
  if (parseUtcIso(timestamp) === null) throw new SiteDeployError("invalid");
  return timestamp;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SiteDeployError("invalid");
  }
  return value;
}

function runStatus(value: unknown): string {
  const status = text(value);
  if (status !== "completed" && !ACTIVE.includes(status))
    throw new SiteDeployError("invalid");
  return status;
}

function conclusion(value: unknown, status: string): string | null {
  if (status !== "completed" && value === null) return null;
  if (typeof value !== "string" || !CONCLUSIONS.includes(value)) {
    throw new SiteDeployError("invalid");
  }
  return value;
}

function kstMidnight(now: Date): number {
  return Math.floor((now.getTime() + KST_MS) / DAY_MS) * DAY_MS - KST_MS;
}

function nextSchedule(now: Date): string {
  const today = kstMidnight(now) + DEPLOY_TIME_MS;
  return new Date(today > now.getTime() ? today : today + DAY_MS).toISOString();
}

function commit(value: unknown) {
  const item = record(value);
  return {
    sha: sha(item.sha),
    title: text(record(item.commit).message).split("\n", 1)[0]!,
  };
}

async function marker(
  origin: string,
  request: typeof fetch,
  budget: AbortSignal,
  now: Date,
) {
  if (!origin) throw new SiteDeployError("unconfigured");
  const url = new URL("/deploy-version.txt", origin);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new SiteDeployError("unconfigured");
  }
  // 두 배포의 표지 경로는 CloudFront 캐시를 끔. 공개 주소의 관측값을 반환함.
  url.searchParams.set("at", String(now.getTime()));
  const signal = AbortSignal.any([budget, AbortSignal.timeout(2_500)]);
  try {
    const response = await request(url, {
      cache: "no-store",
      redirect: "error",
      signal,
    });
    if (response.status === 404) {
      throw new SiteDeployError("not_found");
    }
    if (response.status === 403) throw new SiteDeployError("forbidden");
    if (!response.ok) throw new SiteDeployError("unavailable");
    return sha((await response.text()).trim());
  } catch (error) {
    if (error instanceof SiteDeployError) throw error;
    throw new SiteDeployError(signal.aborted ? "timeout" : "unavailable");
  }
}

export function classifyDeployPath(path: string): SiteDeployFileCategory {
  if (/^data\/(?:beaches\/|beach-meta\.json$|beach-coverage\.csv$)/.test(path))
    return "beach";
  if (path.startsWith("apps/web/")) return "site";
  if (path.startsWith("apps/admin/")) return "admin";
  return "shared";
}

async function compare(read: Read, from: string, to: string, app: App) {
  if (from === to) return { from, to, files: [], commits: [] };
  // GitHub Compare: 페이지를 쓰지 않으면 커밋 250개, 전체 파일은 첫 페이지 최대 300개임.
  const { body, next } = await read(`/compare/${from}...${to}`);
  const diff = record(body);
  if (diff.status === "behind" || diff.status === "diverged") {
    throw new SiteDeployError("not_ancestor");
  }
  if (
    diff.status !== "ahead" ||
    sha(record(diff.merge_base_commit).sha) !== from
  ) {
    throw new SiteDeployError("invalid");
  }
  const commits = rows(diff.commits);
  const files = rows(diff.files);
  if (
    next ||
    commits.length >= 250 ||
    files.length >= 300 ||
    number(diff.total_commits) > commits.length
  ) {
    throw new SiteDeployError("truncated");
  }
  const belongs = (path: string) =>
    appPaths[app].some(
      (prefix) => path === prefix || path.startsWith(prefix + "/"),
    );
  return {
    from,
    to,
    files: files.flatMap((value) => {
      const entry = record(value);
      const path = text(entry.filename);
      const previous =
        entry.previous_filename === undefined
          ? null
          : text(entry.previous_filename);
      const appPath = belongs(path)
        ? path
        : previous && belongs(previous)
          ? previous
          : null;
      return appPath
        ? [{ path, previous, category: classifyDeployPath(appPath) }]
        : [];
    }),
    commits: commits.map(commit),
  };
}

async function ci(read: Read, head: string): Promise<CiState> {
  const { body, next } = await read(
    `/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${head}&per_page=1`,
  );
  const data = record(body);
  const list = rows(data.workflow_runs);
  if (!list.length) {
    if (next || number(data.total_count) !== 0)
      throw new SiteDeployError("truncated");
    return "missing";
  }
  const run = record(list[0]);
  if (
    run.event !== "push" ||
    run.head_branch !== "main" ||
    sha(run.head_sha) !== head
  )
    throw new SiteDeployError("invalid");
  const status = runStatus(run.status);
  if (status !== "completed") return "pending";
  return conclusion(run.conclusion, status) === "success"
    ? "success"
    : "failure";
}

async function variables(read: Read) {
  let paused = false;
  const values = new Map<string, string>();
  for (let page = 1; ; page++) {
    const result = await read(`/actions/variables?per_page=30&page=${page}`);
    const data = record(result.body);
    for (const value of rows(data.variables)) {
      const item = record(value);
      const name = text(item.name);
      if (values.has(name) || typeof item.value !== "string")
        throw new SiteDeployError("invalid");
      values.set(name, item.value);
      if (name === "DEPLOY_PAUSED")
        paused = item.value.toLowerCase() === "true";
    }
    if (!result.next) {
      if (number(data.total_count) !== values.size)
        throw new SiteDeployError("truncated");
      return {
        paused,
        configured: DEPLOY_VARIABLES.every(
          (name) => !!values.get(name)?.trim(),
        ),
      };
    }
    if (page >= 100) throw new SiteDeployError("truncated");
  }
}

function deployRun(
  value: unknown,
  event: Event,
  repo: string,
  mainOnly = true,
): DeployRun {
  const item = record(value);
  if (item.event !== event || (mainOnly && item.head_branch !== "main")) {
    throw new SiteDeployError("invalid");
  }
  const status = runStatus(item.status);
  const id = number(item.id);
  return {
    id,
    event,
    status,
    attempt: number(item.run_attempt),
    conclusion: conclusion(item.conclusion, status),
    sha: sha(item.head_sha),
    createdAt: date(item.created_at),
    url: `https://github.com/${repo}/actions/runs/${id}`,
  };
}

async function runPages(
  read: Read,
  repo: string,
  event: Event,
  query: string,
  mainOnly = true,
): Promise<DeployRun[]> {
  const runs = new Map<number, DeployRun>();
  for (let page = 1; ; page++) {
    const branch = mainOnly ? "&branch=main" : "";
    const { body, next } = await read(
      `${RUNS}?event=${event}${branch}&per_page=100&page=${page}${query}`,
    );
    const data = record(body);
    // 검색 필터가 있는 실행 목록은 1,000건에서 잘릴 수 있음.
    if (number(data.total_count) >= 1_000)
      throw new SiteDeployError("truncated");
    for (const value of rows(data.workflow_runs)) {
      const run = deployRun(value, event, repo, mainOnly);
      if (runs.has(run.id)) throw new SiteDeployError("truncated");
      runs.set(run.id, run);
    }
    if (!next) {
      // GitHub total_count는 검색에서 근삿값일 수 있어 페이지 링크로 끝을 판단함.
      if (
        number(data.total_count) > runs.size ||
        (page === 10 && runs.size >= 1_000)
      ) {
        throw new SiteDeployError("truncated");
      }
      return [...runs.values()];
    }
    if (page >= 10) throw new SiteDeployError("truncated");
  }
}

async function latest(read: Read, repo: string, event: Event) {
  const { body, next } = await read(
    `${RUNS}?event=${event}&branch=main&per_page=100`,
  );
  const data = record(body);
  const runs = rows(data.workflow_runs).map((value) =>
    deployRun(value, event, repo),
  );
  if (
    (!runs.length && next) ||
    (!next && number(data.total_count) > runs.length)
  )
    throw new SiteDeployError("truncated");
  const active = next
    ? (
        await Promise.all(
          ACTIVE.map((status) =>
            runPages(read, repo, event, `&status=${status}`),
          ),
        )
      ).flat()
    : runs.filter((run) => run.status !== "completed");
  return { recent: runs[0] ?? null, active };
}

async function approvals(read: Read, active: DeployRun[]) {
  const results = await Promise.all(
    active.map(async (run) => {
      // 보호 규칙 대기 조회는 Actions: read. production에 필수 검토자가 있을 때만 승인 대기로 표시함.
      const { body } = await read(
        `/actions/runs/${run.id}/pending_deployments`,
      );
      const required = rows(body)
        .map((entry) => record(entry))
        .filter(
          (entry) =>
            record(entry.environment).name === "production" &&
            rows(entry.reviewers).length > 0,
        );
      return required.length ? run.id : null;
    }),
  );
  return results.filter((id): id is number => id !== null);
}

async function jobs(read: Read, run: DeployRun | null) {
  if (!run) return { site: null, admin: null };
  const { body, next } = await read(
    `/actions/runs/${run.id}/attempts/${run.attempt}/jobs?per_page=100`,
  );
  const data = record(body);
  const list = rows(data.jobs).map(record);
  if (next || number(data.total_count) !== list.length)
    throw new SiteDeployError("truncated");
  const appJob = (app: App) => {
    const item = list.find((entry) => entry.name === app);
    if (!item) return null;
    const status = runStatus(item.status);
    const result = conclusion(item.conclusion, status);
    const steps = rows(item.steps).map(record);
    const wroteMarker = steps.some(
      (step) =>
        step.name === SITE_DEPLOY_MARKER_STEP && step.conclusion === "success",
    );
    return {
      status,
      conclusion: result,
      wroteMarker,
      completedAt: item.completed_at === null ? null : date(item.completed_at),
    };
  };
  return { site: appJob("site"), admin: appJob("admin") };
}

function scheduleUnavailable(
  settings: Field<SiteDeploySettings>,
  workflow: SiteDeployWorkflowActiveField,
): SiteDeployScheduleReason | undefined {
  if (settings.status === "known" && settings.value.paused)
    return { kind: "paused" };
  if (settings.status === "known" && !settings.value.configured)
    return { kind: "unconfigured" };
  if (workflow.status === "known" && !workflow.value)
    return { kind: "workflow_disabled" };
  const missing =
    settings.status === "unknown"
      ? settings
      : workflow.status === "unknown"
        ? workflow
        : null;
  if (!missing) return undefined;
  return {
    kind: "unknown",
    reason: missing.reason,
    ...(missing.retryAt ? { retryAt: missing.retryAt } : {}),
  };
}

interface Config {
  readonly repo: string;
  readonly site: string;
  readonly admin: string;
}

export function createSiteDeployReader(
  config: Config,
  credential: ReturnType<typeof createSiteDeployCredential>,
  now: () => Date,
  request: typeof fetch = fetch,
  budgetMs = 7_000,
) {
  const github = createSiteDeployGitHub(config.repo, request, now);
  let collectPromise: Promise<SiteDeployView> | undefined;
  type Cell = { start: number; scope: string; data: Confirmed<unknown> };
  const cache = new Map<string, Cell>();

  async function collect(): Promise<SiteDeployView> {
    const started = now();
    const budget = AbortSignal.timeout(budgetMs);
    let timedOut: () => void;
    const deadline = new Promise<never>((_, reject) => {
      timedOut = () => reject(new SiteDeployError("timeout"));
      budget.addEventListener("abort", timedOut, { once: true });
    });
    void deadline.catch(() => undefined);
    function observe<T>(
      key: string,
      work: () => Promise<T>,
      scope = "",
    ): Promise<Field<T>> {
      const saved = cache.get(key);
      const last =
        saved?.scope === scope ? (saved.data as Confirmed<T>) : undefined;
      if (
        last &&
        saved?.scope === scope &&
        started.getTime() - saved.start < CACHE_MS
      ) {
        return Promise.resolve(last);
      }
      return Promise.race([Promise.resolve().then(work), deadline]).then(
        (value): Field<T> => {
          const data: Confirmed<T> = {
            status: "known",
            value,
            checkedAt: now().toISOString(),
          };
          cache.set(key, { start: started.getTime(), scope, data });
          return data;
        },
        (error: unknown): Field<T> => {
          const failure =
            error instanceof SiteDeployError
              ? error
              : new SiteDeployError("unavailable");
          return {
            status: "unknown",
            reason: failure.reason,
            checkedAt: now().toISOString(),
            ...(last ? { last } : {}),
            ...(failure.retryAt === undefined
              ? {}
              : { retryAt: new Date(failure.retryAt).toISOString() }),
          };
        },
      );
    }
    const valueOf = <T>(field: Field<T>): T => {
      if (field.status === "unknown") {
        throw new SiteDeployError(
          field.reason,
          field.retryAt ? Date.parse(field.retryAt) : undefined,
        );
      }
      return field.value;
    };
    try {
      let token: Promise<string> | undefined;
      const read: Read = async (path) => {
        const value = await (token ??= credential.token(budget));
        try {
          return await github(path, value, budget);
        } catch (error) {
          if (
            error instanceof SiteDeployError &&
            error.reason === "unauthorized"
          )
            credential.invalidate(value);
          throw error;
        }
      };
      const expiry = observe("expiry", () => credential.expiry(budget));
      const main = observe("main", async () => {
        const { body } = await read("/commits/main");
        return commit(body);
      });
      const ciField = main.then((head) =>
        observe(
          "ci",
          () => ci(read, valueOf(head).sha),
          head.status === "known" ? head.value.sha : "?",
        ),
      );
      const settings = observe("variables", () => variables(read));
      const workflow = observe("workflow", async () => {
        const state = record((await read(WORKFLOW)).body).state;
        if (state === "active") return true;
        if (typeof state === "string" && state.startsWith("disabled_"))
          return false;
        throw new SiteDeployError("invalid");
      });
      const deployments = observe("deployments", async () => {
        const entries = await Promise.all(
          DEPLOY_EVENTS.map((event) => latest(read, config.repo, event)),
        );
        const recent =
          entries
            .flatMap((entry) => (entry.recent ? [entry.recent] : []))
            .sort(
              (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id,
            )[0] ?? null;
        const active = [
          ...new Map(
            entries
              .flatMap((entry) => entry.active)
              .map((run) => [run.id, run] as const),
          ).values(),
        ];
        return { recent, active };
      });
      const approval = deployments.then((field) =>
        observe(
          "approvals",
          () => approvals(read, valueOf(field).active),
          field.status === "known"
            ? field.value.active
                .map((run) => `${run.id}:${run.attempt}:${run.status}`)
                .join(",")
            : "?",
        ),
      );
      const lastJobs = deployments.then((field) =>
        observe(
          "jobs",
          async () => {
            const run = valueOf(field).recent;
            return { run, apps: await jobs(read, run) };
          },
          field.status === "known" ? JSON.stringify(field.value.recent) : "?",
        ),
      );
      const midnight = kstMidnight(started);
      const dayStart = new Date(midnight).toISOString();
      const count = observe(
        "manualCount",
        async () => {
          const all = await runPages(
            read,
            config.repo,
            "workflow_dispatch",
            `&created=${encodeURIComponent(`>=${dayStart}`)}`,
            false,
          );
          return {
            since: dayStart,
            requests: all.filter(
              (run) =>
                Date.parse(run.createdAt) >= midnight &&
                Date.parse(run.createdAt) < midnight + DAY_MS,
            ).length,
          };
        },
        dayStart,
      );
      const sites = Promise.all(
        SITE_DEPLOY_JOBS.map(async (app) => {
          const deployed = observe(`${app}:marker`, () =>
            marker(config[app], request, budget, started),
          );
          const detail = deployed.then((field) =>
            observe(
              `${app}:detail`,
              async () => {
                const observed = valueOf(field);
                const result = commit(
                  (await read(`/commits/${observed}`)).body,
                );
                if (result.sha !== observed)
                  throw new SiteDeployError("invalid");
                return result;
              },
              field.status === "known" ? field.value : "?",
            ),
          );
          const changes = Promise.all([deployed, main]).then(([base, head]) =>
            observe(
              `${app}:changes`,
              async () => compare(read, valueOf(base), valueOf(head).sha, app),
              base.status === "known" && head.status === "known"
                ? `${base.value}:${head.value.sha}`
                : "?",
            ),
          );
          return {
            app,
            deployed: await deployed,
            detail: await detail,
            changes: await changes,
          };
        }),
      );
      const [
        mainResult,
        ciResult,
        settingsResult,
        workflowResult,
        runs,
        approvalsResult,
        jobsResult,
        countResult,
        expiryResult,
        sitesResult,
      ] = await Promise.all([
        main,
        ciField,
        settings,
        workflow,
        deployments,
        approval,
        lastJobs,
        count,
        expiry,
        sites,
      ]);
      const siteResults = sitesResult.map((site) => {
        const current = jobsResult.status === "known" ? jobsResult.value : null;
        const run = current?.run;
        const job = current?.apps[site.app];
        // 정기 배포는 실행 head와 실제 대상이 다를 수 있음. 수동도 공개 표지와 작업을 함께 대조함.
        const matchedRun =
          run?.event === "workflow_dispatch" &&
          job?.wroteMarker &&
          job.conclusion === "success" &&
          site.deployed.status === "known" &&
          site.deployed.value === run.sha
            ? { event: run.event, url: run.url, completedAt: job.completedAt }
            : null;
        return {
          ...site,
          matchedRun,
          ...(site.deployed.status === "known" && mainResult.status === "known"
            ? {
                compareUrl: `https://github.com/${config.repo}/compare/${site.deployed.value}...main`,
              }
            : {}),
        };
      });
      let readiness: Readiness = "unknown";
      if (settingsResult.status === "known" && settingsResult.value.paused)
        readiness = "paused";
      else if (
        approvalsResult.status === "known" &&
        approvalsResult.value.length
      )
        readiness = "approval_pending";
      else if (runs.status === "known" && runs.value.active.length)
        readiness = "deploying";
      else if (ciResult.status === "known" && ciResult.value === "pending")
        readiness = "ci_pending";
      else if (ciResult.status === "known" && ciResult.value === "failure")
        readiness = "ci_failed";
      else if (ciResult.status === "known" && ciResult.value === "missing")
        readiness = "ci_missing";
      else if (
        (settingsResult.status === "known" &&
          !settingsResult.value.configured) ||
        (workflowResult.status === "known" && !workflowResult.value)
      )
        readiness = "unconfigured";
      else if (
        mainResult.status === "known" &&
        ciResult.status === "known" &&
        ciResult.value === "success" &&
        settingsResult.status === "known" &&
        workflowResult.status === "known" &&
        runs.status === "known" &&
        approvalsResult.status === "known" &&
        jobsResult.status === "known" &&
        siteResults.every(
          (site) =>
            site.deployed.status === "known" &&
            site.detail.status === "known" &&
            site.changes.status === "known",
        )
      ) {
        readiness = "ready";
      }
      const scheduleReason = scheduleUnavailable(
        settingsResult,
        workflowResult,
      );
      return {
        generatedAt: started.toISOString(),
        readiness,
        readinessCheckedAt:
          [
            mainResult,
            ciResult,
            settingsResult,
            runs,
            approvalsResult,
            jobsResult,
            ...siteResults.flatMap((site) => [
              site.deployed,
              site.detail,
              site.changes,
            ]),
          ]
            .map((field) => field.checkedAt)
            .sort()[0] ?? started.toISOString(),
        main: mainResult,
        ci: ciResult,
        settings: settingsResult,
        workflowActive: workflowResult,
        deployments: runs,
        approvals: approvalsResult,
        recentJobs: jobsResult,
        manualCount: countResult,
        tokenExpiry: expiryResult,
        sites: siteResults,
        nextScheduledAt: scheduleReason ? null : nextSchedule(started),
        ...(scheduleReason ? { nextScheduledAtReason: scheduleReason } : {}),
        workflowUrl: `https://github.com/${config.repo}/actions/workflows/deploy.yml`,
      };
    } finally {
      budget.removeEventListener("abort", timedOut!);
    }
  }
  return () => {
    collectPromise ??= collect().finally(() => {
      collectPromise = undefined;
    });
    return collectPromise;
  };
}

export type SiteDeployReader = ReturnType<typeof createSiteDeployReader>;

export function siteDeployReader(now: () => Date): SiteDeployReader | null {
  const {
    SITE_URL,
    ADMIN_SITE_URL,
    SITE_DEPLOY_REPOSITORY,
    SITE_DEPLOY_TOKEN_PARAMETER,
    AWS_REGION,
  } = process.env;
  if (
    !SITE_DEPLOY_REPOSITORY ||
    !/^[\w.-]+\/[\w.-]+$/.test(SITE_DEPLOY_REPOSITORY) ||
    !SITE_DEPLOY_TOKEN_PARAMETER ||
    !AWS_REGION
  )
    return null;
  const client = new SSMClient({ region: AWS_REGION, maxAttempts: 1 });
  return createSiteDeployReader(
    {
      repo: SITE_DEPLOY_REPOSITORY,
      site: SITE_URL ?? "",
      admin: ADMIN_SITE_URL ?? "",
    },
    createSiteDeployCredential(client, SITE_DEPLOY_TOKEN_PARAMETER, now),
    now,
  );
}
