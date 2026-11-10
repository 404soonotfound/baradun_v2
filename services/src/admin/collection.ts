import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  runLogPk,
  type RunFailure,
  type RunStatus,
} from "../core/collect/run-log";
import { inRipSeason } from "../core/rip/rip-current";
import { PUBLISHED_VERSION_KEY } from "../core/store/dynamodb";
import {
  incidentAlarms,
  readAlarms,
  type AlarmEvent,
  type AlarmReader,
  type AlarmsView,
} from "./collection-alarms";
import {
  incidentImpact,
  readPublishSummaries,
  type ImpactView,
  type PublishView,
} from "./collection-publish";
import type { Sender } from "./writes";

// 수집 현황 (BRD-149, 화면 ADM-COLLECT, 시안 4차 V9·VM2)
// 수집기가 남긴 실행 기록(core/collect/run-log.ts)만 읽어 출처별 성공률·마지막 성공·시간별 성공률·장애 기록을 만듦
// - State 테이블(수집 사실)은 읽지 않음(G1·D16-B2). 판단 상태도 바꾸지 않음
// - 기록이 없는 출처를 정상으로 보지 않음: lastRun null → 화면은 '기록 없음'
// - partial(일부 실패)도 성공으로 세지 않음. 실패 사유는 그대로 돌려줌(모르는 사유도 숨기지 않음)
// - '지연' 기준(D15-9, 2026-11-10 사용자 결정 BRD-187): 마지막 성공 뒤 주기+5분(LATE_AFTER_MINUTES)
//   알림 '출처 응답 없음'은 CloudWatch 경보 설정 그대로(collection-alarms.ts가 읽음)

// 수집기 이름(services/src/collectors의 *_JOB과 같아야 함, collection.test.ts가 확인)
export const COLLECTION_JOBS = [
  "collect-warnings",
  "collect-ocean",
  "collect-rip",
  "collect-weather",
  "collect-catalog",
] as const;
export type CollectionJob = (typeof COLLECTION_JOBS)[number];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const COLLECTION_WINDOW_DAYS = 7;
// 한 수집기에서 읽는 쪽 수 상한. 7일 기록은 15분 주기도 672건(1쪽 안). 상한을 넘으면 truncated로 알림
// 최신부터 읽음 → 잘려도 빠지는 쪽은 오래된 기록(마지막 실행·마지막 성공이 옛 값이 되지 않게)
const MAX_PAGES = 10;

// 막대 '지연' 기준(분). 마지막 성공 뒤 이만큼 지나도록 새 성공이 없으면 지연
// 특보 15분·관측·이안류 30분 주기 + 5분(심장박동 경보 창 infra/lib/ops/alarms.ts HEARTBEAT_WINDOWS보다 앞섬)
// 날씨(매시 15분)는 WeatherFailing 경보와 같은 3시간. 사진(하루 1회, 판단에 안 씀)은 지연 표시 없음(null)
// 이안류 비수기(10~5월)는 하루 1회 슬롯만 기록이 남아 지연 표시 없음(lateAfterMinutes)
export const LATE_AFTER_MINUTES: Record<CollectionJob, number | null> = {
  "collect-warnings": 20,
  "collect-ocean": 35,
  "collect-rip": 35,
  "collect-weather": 180,
  "collect-catalog": null,
};

export function lateAfterMinutes(
  job: CollectionJob,
  nowMs: number,
): number | null {
  if (job === "collect-rip" && !inRipSeason(nowMs)) return null;
  return LATE_AFTER_MINUTES[job];
}

export interface RunView {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: RunStatus;
  readonly failures: readonly RunFailure[];
  // 빠진 관측소(collect-ocean, BRD-187). 없으면 대조하지 못함·옛 기록
  readonly missingStations?: readonly string[];
  readonly missingStationsTotal?: number;
}

export interface RunCounts {
  readonly runs: number;
  readonly ok: number;
}

export interface HourBucket extends RunCounts {
  readonly hour: string; // 그 시간의 시작(UTC ISO)
  // 그 시간 안에 마지막 성공 뒤 지연 기준을 넘긴 때가 있었음. 기준이 없는 출처는 항상 false
  readonly late: boolean;
}

// 장애 안에서 빠졌던 관측소 하나. returnedAt: 대조한 성공 실행에서 다시 값이 들어온 시각(null이면 아직)
export interface StationGap {
  readonly id: string;
  readonly firstMissingAt: string;
  readonly lastMissingAt: string;
  readonly returnedAt: string | null;
}

// failure: 이어진 실패·일부 실패(다음 성공 실행에서 끝남)
// stations: 빠진 관측소(collect-ocean, 대조한 성공 실행에서 빠진 곳이 없을 때 끝남)
// 둘을 나눠 오래 빠진 관측소 하나가 그 사이 출처 실패·경보를 한 장애로 삼키지 않게 함
export type IncidentKind = "failure" | "stations";

export interface Incident {
  readonly kind: IncidentKind;
  readonly startedAt: string;
  // 끝난 실행 시작 시각. null이면 아직 이어지는 중
  readonly endedAt: string | null;
  // failure: 실패한 실행 수. stations: 관측소가 빠진 실행 수
  readonly runs: number;
  readonly failures: readonly RunFailure[];
  // 장애 동안 빠졌던 관측소(stations 장애). failure 장애는 빈 배열
  readonly stations: readonly StationGap[];
  // 한 실행의 빠진 관측소가 기록 상한을 넘어 일부만 남음 → 영향 범위를 출처 전체로 봄
  readonly missingTruncated: boolean;
  // 해변 영향(collect-ocean만, 게시 요약으로 판정). 다른 수집기는 없음
  readonly impact?: ImpactView;
  // 이 장애 동안 울린 경보. null이면 경보 기록을 읽지 못함('경보 없음'으로 보지 않음)
  readonly alarms?: readonly AlarmEvent[] | null;
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
  // 지연 기준(분). null이면 이 출처는 지연을 표시하지 않음
  readonly lateAfterMinutes: number | null;
  // 지금 마지막 성공 뒤 지연 기준을 넘김. 7일 동안 성공이 없어도 true(기록을 다 읽지 못했으면 false)
  readonly overdue: boolean;
}

export interface CollectionView {
  readonly generatedAt: string;
  // 지금 앱에 보이는 게시본 버전(Ops publish/version). 없으면 null
  readonly publishedVersion: string | null;
  readonly jobs: readonly JobCollection[];
  // 지금 게시본의 요약(BRD-187). 요약이 없거나 버전이 다르면 null('확인 못 함')
  readonly publish: PublishView | null;
  // CloudWatch 경보 설정·기록. 읽지 못하면 unavailable
  readonly alarms: AlarmsView;
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
function toMissing(item: Record<string, unknown>) {
  const { missingStations, missingStationsTotal } = item;
  if (!Array.isArray(missingStations)) return {};
  return {
    missingStations: missingStations.filter(
      (id): id is string => typeof id === "string",
    ),
    ...(typeof missingStationsTotal === "number"
      ? { missingStationsTotal }
      : {}),
  };
}

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
    ...toMissing(item),
  };
}

function count(runs: readonly RunView[]): RunCounts {
  return {
    runs: runs.length,
    ok: runs.filter((run) => run.status === "complete").length,
  };
}

// 장애 안의 실패 사유를 한 줄씩. count는 한 실행 안에서 같은 사유로 실패한 해변 수라
// 실행끼리 더하지 않고 가장 많았던 실행의 값을 둠(화면이 'N곳'으로 보여 줌. 실행 수는 Incident.runs)
function mergeFailures(runs: readonly RunView[]): RunFailure[] {
  const merged = new Map<string, RunFailure>();
  for (const run of runs) {
    for (const failure of run.failures) {
      const id = JSON.stringify([failure.source, failure.reason, failure.code]);
      const current = merged.get(id);
      if (!current || (failure.count ?? 1) > (current.count ?? 1)) {
        merged.set(id, failure);
      }
    }
  }
  return [...merged.values()];
}

// 관측소가 돌아온 시각: 마지막으로 빠진 뒤, 대조한 성공 실행에서 다시 빠지지 않은 첫 실행
// 출처가 실패한 실행은 대조하지 않아 돌아온 것으로 보지 않음
function stationGaps(
  open: readonly RunView[],
  later: readonly RunView[],
): StationGap[] {
  const gaps = new Map<string, { first: string; last: string }>();
  for (const run of open) {
    for (const id of run.missingStations ?? []) {
      const gap = gaps.get(id);
      gaps.set(id, { first: gap?.first ?? run.startedAt, last: run.startedAt });
    }
  }
  return [...gaps.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, gap]) => {
      const back = later.find(
        (run) =>
          run.startedAt > gap.last &&
          run.status === "complete" &&
          run.missingStations !== undefined &&
          !run.missingStations.includes(id),
      );
      return {
        id,
        firstMissingAt: gap.first,
        lastMissingAt: gap.last,
        returnedAt: back?.startedAt ?? null,
      };
    });
}

// 이어진 실패(partial 포함). 다음 성공 실행에서 끝남
function failureIncidents(runs: readonly RunView[]): Incident[] {
  const incidents: Incident[] = [];
  let open: RunView[] = [];
  const close = (endedAt: string | null) => {
    if (open.length === 0) return;
    incidents.push({
      kind: "failure",
      startedAt: open[0]!.startedAt,
      endedAt,
      runs: open.length,
      failures: mergeFailures(open),
      stations: [],
      missingTruncated: false,
    });
    open = [];
  };
  for (const run of runs) {
    if (run.status === "complete") close(run.startedAt);
    else open.push(run);
  }
  close(null);
  return incidents;
}

// 빠진 관측소. 대조해서 빠진 곳이 없는 성공 실행에서만 끝남
// 대조하지 못한 실행(칸 없음)·일부 실패 실행은 끝내지도 세지도 않음(돌아왔다고 보지 않음)
function stationIncidents(runs: readonly RunView[]): Incident[] {
  const incidents: Incident[] = [];
  let open: RunView[] = [];
  const close = (endedAt: string | null, index: number) => {
    if (open.length === 0) return;
    incidents.push({
      kind: "stations",
      startedAt: open[0]!.startedAt,
      endedAt,
      runs: open.length,
      failures: [],
      stations: stationGaps(
        open,
        runs.slice(runs.indexOf(open[0]!), index + 1),
      ),
      missingTruncated: open.some(
        (run) =>
          (run.missingStationsTotal ?? 0) > (run.missingStations?.length ?? 0),
      ),
    });
    open = [];
  };
  runs.forEach((run, index) => {
    if (run.missingStations?.length) open.push(run);
    else if (run.status === "complete" && run.missingStations !== undefined)
      close(run.startedAt, index);
  });
  close(null, runs.length - 1);
  return incidents;
}

// 실패 장애와 빠진 관측소 장애. 최신 장애가 먼저
export function incidentsOf(runs: readonly RunView[]): Incident[] {
  return [...failureIncidents(runs), ...stationIncidents(runs)].sort((a, b) =>
    a.startedAt === b.startedAt
      ? a.kind.localeCompare(b.kind)
      : a.startedAt < b.startedAt
        ? 1
        : -1,
  );
}

// 지연 구간: 성공과 다음 성공(없으면 지금) 사이가 기준보다 길면 (성공 + 기준, 다음 성공)
// windowStartMs: 7일 창 시작. 그 전 성공은 창 시작보다 앞이므로, 첫 성공 전도 창 시작 + 기준부터 지연
//   기록을 다 읽지 못했으면(truncated) null → 첫 성공 전은 판정하지 않음
// applies: 그 성공 뒤에 지연을 볼지(이안류는 비수기 성공 뒤 하루 1회 간격을 지연으로 보지 않음)
function lateRanges(
  runs: readonly RunView[],
  lateMs: number,
  nowMs: number,
  windowStartMs: number | null,
  applies: (ms: number) => boolean,
): [number, number][] {
  const successes = runs
    .filter((run) => run.status === "complete")
    .map((run) => Date.parse(run.startedAt));
  const starts =
    windowStartMs === null ? successes : [windowStartMs, ...successes];
  const ranges: [number, number][] = [];
  starts.forEach((at, i) => {
    const next = starts[i + 1] ?? nowMs;
    if (next - at > lateMs && applies(at)) ranges.push([at + lateMs, next]);
  });
  return ranges;
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
  const late = lateAfterMinutes(job, nowMs);
  const ranges =
    late === null
      ? []
      : lateRanges(
          runs,
          late * 60_000,
          nowMs,
          truncated ? null : nowMs - COLLECTION_WINDOW_DAYS * DAY_MS,
          job === "collect-rip" ? inRipSeason : () => true,
        );
  const hourly: HourBucket[] = Array.from({ length: 24 }, (_, i) => {
    const start = firstHour + i * HOUR_MS;
    const end = Math.min(start + HOUR_MS, nowMs);
    const inHour = runs.filter((run) => {
      const at = Date.parse(run.startedAt);
      return at >= start && at < start + HOUR_MS;
    });
    return {
      hour: new Date(start).toISOString(),
      ...count(inHour),
      late: ranges.some(([from, to]) => from < end && to > start),
    };
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
    lateAfterMinutes: late,
    // 마지막 지연 구간이 지금까지 이어짐
    overdue: ranges.some(([from, to]) => from <= nowMs && to >= nowMs),
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
        ProjectionExpression:
          "startedAt, finishedAt, #status, failures, missingStations, missingStationsTotal",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":pk": runLogPk(job), ":from": from },
        ScanIndexForward: false,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of (result.Items ?? []) as Record<string, unknown>[]) {
      const run = toRunView(item);
      if (run) runs.push(run);
    }
    startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!startKey) return { runs: runs.reverse(), truncated: false };
  }
  return { runs: runs.reverse(), truncated: true };
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
  alarmReader: AlarmReader | null = null,
): Promise<CollectionView> {
  const nowMs = now.getTime();
  const [publishedVersion, alarms, jobs] = await Promise.all([
    readPublishedVersion(client, opsTable),
    readAlarms(alarmReader, now),
    Promise.all(
      COLLECTION_JOBS.map(async (job) => {
        const { runs, truncated } = await readRuns(client, opsTable, job, now);
        return summarizeJob(job, runs, now, truncated);
      }),
    ),
  ]);
  // 해변 영향은 관측 장애에만 → 게시 요약은 가장 오래된 관측 장애 시작부터만 읽음(Ops 읽기 용량)
  const oceanStarts = jobs
    .filter((job) => job.job === "collect-ocean")
    .flatMap((job) => job.incidents.map((i) => Date.parse(i.startedAt)));
  const read = await readPublishSummaries(
    client,
    opsTable,
    oceanStarts.length > 0 ? Math.min(...oceanStarts) : null,
  );
  return {
    generatedAt: now.toISOString(),
    publishedVersion,
    jobs: jobs.map((job) => ({
      ...job,
      incidents: job.incidents.map((incident) => ({
        ...incident,
        ...(job.job === "collect-ocean"
          ? { impact: incidentImpact(incident, read, publishedVersion, nowMs) }
          : {}),
        // 경보는 실행 실패에서 울림 → 실패 장애에만 붙임(빠진 관측소는 실행 상태를 바꾸지 않음)
        ...(incident.kind === "failure"
          ? { alarms: incidentAlarms(alarms, job.job, incident, nowMs) }
          : {}),
      })),
    })),
    publish: read.live(publishedVersion),
    alarms,
  };
}
