import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  runLogPk,
  type RunFailure,
  type RunStatus,
} from "../core/collect/run-log";
import { PUBLISHED_VERSION_KEY } from "../core/store/dynamodb";
import type { Sender } from "./writes";

// 수집 현황 (BRD-149, 화면 ADM-COLLECT, 시안 4차 V9·VM2)
// 수집기가 남긴 실행 기록(core/collect/run-log.ts)만 읽어 출처별 성공률·마지막 성공·시간별 성공률·장애 기록을 만듦
// - State 테이블(수집 사실)은 읽지 않음(G1·D16-B2). 판단 상태도 바꾸지 않음
// - 기록이 없는 출처를 정상으로 보지 않음: lastRun null → 화면은 '기록 없음'
// - partial(일부 실패)도 성공으로 세지 않음. 실패 사유는 그대로 돌려줌(모르는 사유도 숨기지 않음)
// - '지연' 기준(N분)은 미결(D15-9) → 여기서 정하지 않고 마지막 실행·마지막 성공 시각만 돌려줌

// 수집기 이름(services/src/collectors의 *_JOB과 같아야 함, collection.test.ts가 확인)
export const COLLECTION_JOBS = [
  "collect-warnings",
  "collect-ocean",
  "collect-rip",
  "collect-catalog",
] as const;
export type CollectionJob = (typeof COLLECTION_JOBS)[number];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const COLLECTION_WINDOW_DAYS = 7;
// 한 수집기에서 읽는 쪽 수 상한. 7일 기록은 15분 주기도 672건(1쪽 안). 상한을 넘으면 truncated로 알림
const MAX_PAGES = 10;

export interface RunView {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: RunStatus;
  readonly failures: readonly RunFailure[];
}

export interface RunCounts {
  readonly runs: number;
  readonly ok: number;
}

export interface HourBucket extends RunCounts {
  readonly hour: string; // 그 시간의 시작(UTC ISO)
}

export interface Incident {
  readonly startedAt: string;
  // 다음 성공 실행 시작 시각. null이면 아직 이어지는 중
  readonly endedAt: string | null;
  readonly runs: number;
  readonly failures: readonly RunFailure[];
}

export interface JobCollection {
  readonly job: CollectionJob;
  readonly lastRun: RunView | null;
  readonly lastSuccessAt: string | null;
  readonly day: RunCounts;
  readonly week: RunCounts;
  readonly hourly: readonly HourBucket[];
  readonly incidents: readonly Incident[];
  // 읽은 기록이 상한을 넘어 일부만 셈
  readonly truncated: boolean;
}

export interface CollectionView {
  readonly generatedAt: string;
  // 지금 앱에 보이는 게시본 버전(Ops publish/version). 없으면 null
  readonly publishedVersion: string | null;
  readonly jobs: readonly JobCollection[];
}

const RUN_STATUSES: readonly RunStatus[] = ["complete", "partial", "failed"];

function toFailure(value: unknown): RunFailure | null {
  if (typeof value !== "object" || value === null) return null;
  const { source, reason, code, message, count } = value as Record<
    string,
    unknown
  >;
  if (typeof source !== "string" || typeof reason !== "string") return null;
  return {
    source,
    reason,
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof message === "string" ? { message } : {}),
    ...(typeof count === "number" ? { count } : {}),
  };
}

// 모양이 틀린 기록은 버리지 않고 실패로 셈(모르는 형식을 정상으로 읽지 않음)
export function toRunView(item: Record<string, unknown>): RunView | null {
  const { startedAt, finishedAt, status, failures } = item;
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) {
    return null;
  }
  const known = RUN_STATUSES.includes(status as RunStatus);
  const list = Array.isArray(failures)
    ? failures.map(toFailure).filter((f): f is RunFailure => f !== null)
    : [];
  return {
    startedAt,
    finishedAt: typeof finishedAt === "string" ? finishedAt : startedAt,
    status: known ? (status as RunStatus) : "failed",
    failures: known
      ? list
      : [...list, { source: "record", reason: "unknown_status" }],
  };
}

function count(runs: readonly RunView[]): RunCounts {
  return {
    runs: runs.length,
    ok: runs.filter((run) => run.status === "complete").length,
  };
}

function mergeFailures(runs: readonly RunView[]): RunFailure[] {
  const merged = new Map<string, RunFailure>();
  for (const run of runs) {
    for (const failure of run.failures) {
      const id = JSON.stringify([failure.source, failure.reason, failure.code]);
      const current = merged.get(id);
      merged.set(
        id,
        current
          ? { ...current, count: (current.count ?? 1) + (failure.count ?? 1) }
          : failure,
      );
    }
  }
  return [...merged.values()];
}

// 이어진 실패(partial 포함)를 한 장애로 묶음. 최신 장애가 먼저
export function incidentsOf(runs: readonly RunView[]): Incident[] {
  const incidents: Incident[] = [];
  let open: RunView[] = [];
  const close = (endedAt: string | null) => {
    if (open.length === 0) return;
    incidents.push({
      startedAt: open[0]!.startedAt,
      endedAt,
      runs: open.length,
      failures: mergeFailures(open),
    });
    open = [];
  };
  for (const run of runs) {
    if (run.status === "complete") close(run.startedAt);
    else open.push(run);
  }
  close(null);
  return incidents.reverse();
}

// runs: 시작 시각 오름차순
export function summarizeJob(
  job: CollectionJob,
  runs: readonly RunView[],
  now: Date,
  truncated: boolean,
): JobCollection {
  const nowMs = now.getTime();
  const dayStart = nowMs - DAY_MS;
  const day = runs.filter((run) => Date.parse(run.startedAt) > dayStart);
  const firstHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS - 23 * HOUR_MS;
  const hourly: HourBucket[] = Array.from({ length: 24 }, (_, i) => {
    const start = firstHour + i * HOUR_MS;
    const inHour = runs.filter((run) => {
      const at = Date.parse(run.startedAt);
      return at >= start && at < start + HOUR_MS;
    });
    return { hour: new Date(start).toISOString(), ...count(inHour) };
  });
  const lastSuccess = [...runs].reverse().find((r) => r.status === "complete");
  return {
    job,
    lastRun: runs.at(-1) ?? null,
    lastSuccessAt: lastSuccess?.startedAt ?? null,
    day: count(day),
    week: count(runs),
    hourly,
    incidents: incidentsOf(runs),
    truncated,
  };
}

async function readRuns(
  client: Sender,
  opsTable: string,
  job: CollectionJob,
  now: Date,
): Promise<{ runs: RunView[]; truncated: boolean }> {
  const from = new Date(
    now.getTime() - COLLECTION_WINDOW_DAYS * DAY_MS,
  ).toISOString();
  const runs: RunView[] = [];
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.send(
      new QueryCommand({
        TableName: opsTable,
        KeyConditionExpression: "pk = :pk AND sk >= :from",
        ProjectionExpression: "startedAt, finishedAt, #status, failures",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":pk": runLogPk(job), ":from": from },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of (result.Items ?? []) as Record<string, unknown>[]) {
      const run = toRunView(item);
      if (run) runs.push(run);
    }
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) return { runs, truncated: false };
  }
  return { runs, truncated: true };
}

async function readPublishedVersion(
  client: Sender,
  opsTable: string,
): Promise<string | null> {
  const result = await client.send(
    new GetCommand({ TableName: opsTable, Key: PUBLISHED_VERSION_KEY }),
  );
  const version = (result.Item as Record<string, unknown> | undefined)?.version;
  return typeof version === "string" ? version : null;
}

export async function readCollection(
  client: Sender,
  opsTable: string,
  now: Date,
): Promise<CollectionView> {
  const [publishedVersion, ...jobs] = await Promise.all([
    readPublishedVersion(client, opsTable),
    ...COLLECTION_JOBS.map(async (job) => {
      const { runs, truncated } = await readRuns(client, opsTable, job, now);
      return summarizeJob(job, runs, now, truncated);
    }),
  ]);
  return {
    generatedAt: now.toISOString(),
    publishedVersion: publishedVersion as string | null,
    jobs: jobs as JobCollection[],
  };
}
