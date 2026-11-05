import { opsFetch, type OpsResult } from "./auth/ops-fetch";

// 수집 현황 (BRD-149, 화면 ADM-COLLECT, 시안 4차 V9·VM2)
// 운영 API GET /ops/collection 응답 모양과 화면용 계산. 서버(services/src/admin/collection.ts)가 원본이라 모양만 맞춤
// - 기록이 없는 출처는 '기록 없음'(정상이 아님). 일부 실패(partial)도 성공으로 세지 않음
// - '지연' 기준(N분)은 미결(D15-9)이라 여기서 정하지 않음

export type CollectionJobId =
  | "collect-warnings"
  | "collect-ocean"
  | "collect-rip"
  | "collect-weather"
  | "collect-catalog";

export type RunStatus = "complete" | "partial" | "failed";

export interface RunFailure {
  readonly source: string;
  readonly reason: string;
  readonly code?: string;
  readonly message?: string;
  readonly count?: number;
}

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
  readonly hour: string;
}

export interface Incident {
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly runs: number;
  readonly failures: readonly RunFailure[];
}

export interface JobCollection {
  readonly job: string;
  readonly lastRun: RunView | null;
  readonly lastSuccessAt: string | null;
  readonly day: RunCounts;
  readonly week: RunCounts;
  readonly hourly: readonly HourBucket[];
  readonly incidents: readonly Incident[];
  readonly truncated: boolean;
}

export interface CollectionView {
  readonly generatedAt: string;
  readonly publishedVersion: string | null;
  readonly jobs: readonly JobCollection[];
}

export function fetchCollection(
  accessToken: () => Promise<string | null>,
): Promise<OpsResult<CollectionView>> {
  return opsFetch("/ops/collection", accessToken);
}

// 화면 줄 순서와 출처 정보(화면 설계서 6장 '출처 이름은 실제 출처', 아키텍처 5장 주기)
// judgment: 판단에 쓰는 출처(실패하면 앱 표시가 바뀜)
export interface SourceRow {
  readonly job: CollectionJobId;
  readonly judgment: boolean;
}

export const SOURCE_ROWS: readonly SourceRow[] = [
  { job: "collect-warnings", judgment: true },
  { job: "collect-ocean", judgment: true },
  { job: "collect-rip", judgment: false },
  // 날씨 예보(BRD-181): 참고 정보라 판단에 쓰지 않음
  { job: "collect-weather", judgment: false },
  { job: "collect-catalog", judgment: false },
];

// 정상: 마지막 실행이 모두 성공 · 일부 실패 · 실패 · 기록 없음(7일 안 실행 없음)
export type SourceState = "ok" | "partial" | "failed" | "none";

export function sourceState(job: JobCollection | undefined): SourceState {
  const status = job?.lastRun?.status;
  if (status === undefined) return "none";
  return status === "complete" ? "ok" : status;
}

// 성공률(%). 실행이 없으면 null(0%·100%로 바꾸지 않음). 99.95%는 100%로 올리지 않고 99.9%로 둠
export function successRate(counts: RunCounts): number | null {
  if (counts.runs === 0) return null;
  return Math.floor((counts.ok / counts.runs) * 1000) / 10;
}

export function sumCounts(list: readonly RunCounts[]): RunCounts {
  return list.reduce(
    (acc, c) => ({ runs: acc.runs + c.runs, ok: acc.ok + c.ok }),
    { runs: 0, ok: 0 },
  );
}

// 수집기 전체의 시간별 성공(칸 시각이 같은 것끼리 더함)
export function overallHourly(jobs: readonly JobCollection[]): HourBucket[] {
  const byHour = new Map<string, RunCounts>();
  for (const job of jobs) {
    for (const bucket of job.hourly) {
      const current = byHour.get(bucket.hour) ?? { runs: 0, ok: 0 };
      byHour.set(bucket.hour, sumCounts([current, bucket]));
    }
  }
  return [...byHour.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([hour, counts]) => ({ hour, ...counts }));
}

// 성공률이 가장 낮았던 칸(실행이 있는 칸만). 모두 100%면 null
export function lowestHour(hourly: readonly HourBucket[]): HourBucket | null {
  let lowest: HourBucket | null = null;
  for (const bucket of hourly) {
    if (bucket.runs === 0 || bucket.ok === bucket.runs) continue;
    if (!lowest || bucket.ok / bucket.runs < lowest.ok / lowest.runs) {
      lowest = bucket;
    }
  }
  return lowest;
}

export interface JobIncident extends Incident {
  readonly job: string;
}

// 수집기 장애를 한 목록으로(최신 먼저)
export function allIncidents(jobs: readonly JobCollection[]): JobIncident[] {
  return jobs
    .flatMap((job) => job.incidents.map((i) => ({ ...i, job: job.job })))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

// 장애가 이어진 시간(분). 끝나지 않았으면 지금까지
export function incidentMinutes(incident: Incident, nowMs: number): number {
  const end = incident.endedAt ? Date.parse(incident.endedAt) : nowMs;
  return Math.max(
    0,
    Math.round((end - Date.parse(incident.startedAt)) / 60_000),
  );
}

// 사유 글을 화면 문구 키와 값으로 나눔. 모르는 사유는 원래 글 그대로(숨기지 않음)
export type ReasonKey =
  | "timeout"
  | "http"
  | "apiKey"
  | "format"
  | "resultCode"
  | "truncated"
  | "empty"
  | "noData"
  | "unchecked"
  | "storage"
  | "exception"
  | "unknownStatus"
  | "other";

export function reasonOf(failure: RunFailure): {
  key: ReasonKey;
  value: string;
} {
  const { reason } = failure;
  const [head, ...rest] = reason.split(":");
  const tail = rest.join(":");
  if (reason === "timeout") return { key: "timeout", value: "" };
  if (head === "http" && tail) return { key: "http", value: tail };
  if (reason === "api_key") return { key: "apiKey", value: "" };
  if (head === "format") return { key: "format", value: tail };
  if (head === "resultCode" || head === "result")
    return { key: "resultCode", value: failure.code ?? tail };
  if (head === "truncated") return { key: "truncated", value: tail };
  if (reason === "empty") return { key: "empty", value: "" };
  if (reason === "no_data") return { key: "noData", value: "" };
  if (reason === "unchecked") return { key: "unchecked", value: "" };
  if (failure.source === "storage" || head === "state")
    return { key: "storage", value: reason };
  if (head === "exception") return { key: "exception", value: tail };
  if (reason === "unknown_status") return { key: "unknownStatus", value: "" };
  return { key: "other", value: reason };
}

// 게시본 버전(20261104T051000Z) → UTC ISO. 모양이 틀리면 null
export function versionTime(version: string | null): string | null {
  const m =
    version && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(version);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

// UTC ISO → KST 시(0~23). 시간별 칸 이름에 씀
export function kstHour(iso: string): number {
  return new Date(Date.parse(iso) + 9 * 3_600_000).getUTCHours();
}
