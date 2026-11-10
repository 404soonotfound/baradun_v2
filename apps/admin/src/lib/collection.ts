import { opsFetch, type OpsResult } from "./auth/ops-fetch";
import { fill, messages } from "./messages";

// 수집 현황 (BRD-149·GH-376, 화면 ADM-COLLECT, 시안 4차 V9·VM2 + 2026-11-10 시안)
// 운영 API GET /ops/collection 응답 모양과 화면용 계산. 서버(services/src/admin/collection*.ts)가 원본이라 모양만 맞춤
// - 기록이 없는 출처는 '기록 없음'(정상이 아님). 일부 실패(partial)도 성공으로 세지 않음
// - '지연' 기준(D15-9, GH-375)은 서버가 정해 내려줌(lateAfterMinutes·overdue·hourly.late). 화면에서 다시 정하지 않음
// - 게시 요약·경보를 읽지 못하면 '확인 못 함'. '영향 없음'·'경보 없음'·0으로 바꾸지 않음

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
  readonly missingStations?: readonly string[];
  readonly missingStationsTotal?: number;
}

export interface RunCounts {
  readonly runs: number;
  readonly ok: number;
}

// 시간 칸 하나의 실행 수(모든 출처를 더한 칸은 지연 표시 없이 이것만)
export interface HourCounts extends RunCounts {
  readonly hour: string;
}

export interface HourBucket extends HourCounts {
  // 그 시간 안에 지연 기준을 넘긴 때가 있었음. 기준이 없는 출처는 항상 false
  readonly late: boolean;
}

export interface StationGap {
  readonly id: string;
  readonly firstMissingAt: string;
  readonly lastMissingAt: string;
  readonly returnedAt: string | null;
}

export type IncidentKind = "failure" | "stations";

export interface StationImpact {
  readonly id: string;
  readonly name: string | null;
  readonly beaches: number | null;
  readonly waveBeaches: number | null;
}

export type ImpactUnknownReason =
  "summary_unread" | "summary_missing" | "station_unknown" | "failure_unknown";

export interface ImpactView {
  readonly status: "affected" | "none" | "unknown";
  readonly reason?: ImpactUnknownReason;
  readonly wholeSource: boolean;
  readonly delayedBeachIds: readonly string[];
  readonly stations: readonly StationImpact[];
}

export type AlarmState = "OK" | "ALARM" | "INSUFFICIENT_DATA" | "unknown";

export interface AlarmEvent {
  readonly id: string;
  readonly name: string;
  readonly at: string;
  readonly from: AlarmState;
  readonly to: AlarmState;
}

export interface AlarmView {
  readonly id: string;
  readonly name: string;
  readonly state: AlarmState;
  readonly stateUpdatedAt: string | null;
  readonly description: string;
  readonly windowMinutes: number | null;
  readonly functionName: string | null;
}

export type AlarmsView =
  | {
      readonly status: "ok";
      readonly region: string;
      readonly list: readonly AlarmView[];
      readonly history: readonly AlarmEvent[];
    }
  | { readonly status: "unavailable" };

export interface Incident {
  readonly kind: IncidentKind;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly runs: number;
  readonly failures: readonly RunFailure[];
  readonly stations: readonly StationGap[];
  readonly missingTruncated: boolean;
  readonly impact?: ImpactView;
  // 실패 장애에만 붙음. null: 경보 기록을 읽지 못함('경보 없음'이 아님)
  // 빠진 관측소 장애(stations)는 경보가 울리지 않아 서버가 붙이지 않음
  readonly alarms?: readonly AlarmEvent[] | null;
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
  readonly lateAfterMinutes: number | null;
  // null: 예전 응답이라 지연을 판정하지 못함(정상으로 보지 않음)
  readonly overdue: boolean | null;
}

export interface PublishView {
  readonly version: string;
  readonly publishedAt: string;
  readonly beachCount: number;
  readonly delayedBeaches: number;
}

export interface CollectionView {
  readonly generatedAt: string;
  readonly publishedVersion: string | null;
  readonly jobs: readonly JobCollection[];
  // 지금 게시본 요약. null이면 '확인 못 함'
  readonly publish: PublishView | null;
  readonly alarms: AlarmsView;
}

export async function fetchCollection(
  accessToken: () => Promise<string | null>,
): Promise<OpsResult<CollectionView & { readonly legacy: boolean }>> {
  const result = await opsFetch<unknown>("/ops/collection", accessToken);
  if (!result.ok) return result;
  // 본문을 읽지 못했거나(null) 모양이 틀리면 불러오기 실패. 빈 목록·'기록 없음'으로 채우지 않음
  const body = result.body as { generatedAt?: unknown; jobs?: unknown } | null;
  if (
    typeof body !== "object" ||
    body === null ||
    typeof body.generatedAt !== "string" ||
    !Array.isArray(body.jobs) ||
    !body.jobs.every(validJob)
  ) {
    return {
      ok: false,
      status: result.status,
      code: "format",
      requestId: null,
    };
  }
  return { ...result, body: normalizeCollection(body) };
}

function validPublish(value: unknown): value is PublishView {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.version === "string" &&
    typeof p.publishedAt === "string" &&
    Number.isFinite(p.beachCount) &&
    Number.isFinite(p.delayedBeaches)
  );
}

// 예전 응답에도 있던 필수 칸. 빠지거나 null이면 '장애 없음'·'실행 없음'으로 채우지 않고 본문 오류로 봄
function validJob(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const job = item as Record<string, unknown>;
  return (
    typeof job.job === "string" &&
    Array.isArray(job.hourly) &&
    Array.isArray(job.incidents) &&
    job.incidents.every(validIncident) &&
    typeof job.day === "object" &&
    job.day !== null &&
    typeof job.week === "object" &&
    job.week !== null
  );
}

// 장애 안쪽의 필수 칸. 하나라도 틀리면 그리는 중에 깨지지 않게 본문 오류(불러오기 실패)로 봄
function validIncident(item: unknown): boolean {
  if (typeof item !== "object" || item === null) return false;
  const i = item as Record<string, unknown>;
  return (
    typeof i.startedAt === "string" &&
    (i.endedAt === null || typeof i.endedAt === "string") &&
    Array.isArray(i.failures) &&
    i.failures.every(validFailure) &&
    (i.stations === undefined || Array.isArray(i.stations))
  );
}

// 실패 사유 한 건의 필수 칸(수집 현황·데이터 출처가 같이 씀)
export function validFailure(f: unknown): f is RunFailure {
  return (
    typeof f === "object" &&
    f !== null &&
    typeof (f as Record<string, unknown>).source === "string" &&
    typeof (f as Record<string, unknown>).reason === "string"
  );
}

// 해변 영향은 모양이 맞을 때만. 틀리면 없음으로 둬 화면이 '영향 정보가 응답에 없어요'(확인 못 함)로 보여 줌
function validImpact(value: unknown): value is ImpactView {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.status === "affected" ||
      v.status === "none" ||
      v.status === "unknown") &&
    Array.isArray(v.delayedBeachIds) &&
    Array.isArray(v.stations)
  );
}

// 경보 상태는 아는 값만. 모르는 값은 unknown(배지 글자가 비거나 순서가 깨지지 않게)
const ALARM_STATES: readonly AlarmState[] = [
  "OK",
  "ALARM",
  "INSUFFICIENT_DATA",
];
const toAlarmState = (value: unknown): AlarmState =>
  ALARM_STATES.includes(value as AlarmState)
    ? (value as AlarmState)
    : "unknown";

function toAlarmEvents(value: unknown): AlarmEvent[] | null {
  if (!Array.isArray(value)) return null;
  const valid = value.every(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as Record<string, unknown>).id === "string" &&
      typeof (e as Record<string, unknown>).name === "string" &&
      typeof (e as Record<string, unknown>).at === "string",
  );
  if (!valid) return null; // 틀린 기록은 '경보 없음'이 아니라 '확인 못 함'
  return (value as AlarmEvent[]).map((e) => ({
    ...e,
    from: toAlarmState(e.from),
    to: toAlarmState(e.to),
  }));
}

function toAlarms(value: unknown): AlarmsView {
  const a = value as Record<string, unknown> | undefined;
  if (
    a?.status !== "ok" ||
    typeof a.region !== "string" ||
    !Array.isArray(a.list) ||
    !a.list.every(
      (x) =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as Record<string, unknown>).id === "string" &&
        typeof (x as Record<string, unknown>).name === "string",
    )
  ) {
    return { status: "unavailable" };
  }
  const history = toAlarmEvents(a.history ?? []);
  if (history === null) return { status: "unavailable" };
  return {
    status: "ok",
    region: a.region,
    list: (a.list as AlarmView[]).map((x) => ({
      ...x,
      state: toAlarmState(x.state),
    })),
    history,
  };
}

type Loose<T> = { -readonly [K in keyof T]?: unknown };

// 운영 API가 GH-375 전 응답(지연·게시 요약·경보·장애 종류 없음)을 보내도 화면이 깨지지 않게 채움
// 모르는 값은 '확인 못 함' 쪽으로: 게시 요약 null, 경보 unavailable, 지연 기준 null(지연 표시 안 함)
// legacy: 새 필드가 하나라도 빠진 응답. 화면이 '예전 응답' 안내를 띄워 지연이 없다고 읽지 않게 함
// jobs·hourly·incidents가 배열인지는 fetchCollection(validJob)이 먼저 확인함 → 여기서 빈 배열로 채우지 않음
export function normalizeCollection(raw: unknown): CollectionView & {
  readonly legacy: boolean;
} {
  const view = (raw ?? {}) as Loose<CollectionView>;
  let legacy = !("publish" in view) || !("alarms" in view);
  const jobs = (view.jobs as readonly unknown[]).map((item) => {
    const job = item as Loose<JobCollection> & JobCollection;
    if (typeof job.overdue !== "boolean") legacy = true;
    return {
      ...job,
      lateAfterMinutes:
        typeof job.lateAfterMinutes === "number" ? job.lateAfterMinutes : null,
      overdue: typeof job.overdue === "boolean" ? job.overdue : null,
      hourly: job.hourly.map((bucket) => ({
        ...bucket,
        late: bucket.late === true,
      })),
      incidents: job.incidents.map((incident): Incident => {
        const { impact, alarms: events, ...rest } = incident;
        return {
          ...rest,
          kind: incident.kind === "stations" ? "stations" : "failure",
          stations: Array.isArray(incident.stations) ? incident.stations : [],
          missingTruncated: incident.missingTruncated === true,
          ...(validImpact(impact) ? { impact } : {}),
          ...(events === undefined ? {} : { alarms: toAlarmEvents(events) }),
        };
      }),
    };
  });
  return {
    generatedAt: String(view.generatedAt ?? ""),
    publishedVersion:
      typeof view.publishedVersion === "string" ? view.publishedVersion : null,
    // 칸이 빠지거나 숫자가 아니면 '확인 못 함'(null). 'undefined곳'으로 보이지 않게
    publish: validPublish(view.publish) ? view.publish : null,
    alarms: toAlarms(view.alarms),
    jobs,
    legacy,
  };
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

// 정상: 마지막 실행이 모두 성공 · 지연(마지막 성공 뒤 지연 기준을 넘김) · 일부 실패 · 실패 · 기록 없음(7일 안 실행 없음)
// 실패·일부 실패가 지연보다 앞섬(더 무거운 사유를 먼저). 지연을 판정하지 못한 응답은 '지연 확인 못 함'(unchecked)
export type SourceState =
  "ok" | "late" | "unchecked" | "partial" | "failed" | "none";

export function sourceState(job: JobCollection | undefined): SourceState {
  if (!job?.lastRun) return "none";
  const { status } = job.lastRun;
  if (status !== "complete") return status;
  if (job.overdue === null) return "unchecked";
  return job.overdue ? "late" : "ok";
}

// 24시간 막대 한 칸: 실패(실행 중 실패가 있음) · 지연 · 기록 없음 · 정상
export type BarState = "failed" | "late" | "none" | "ok";

export function barState(bucket: HourBucket): BarState {
  if (bucket.runs > bucket.ok) return "failed";
  if (bucket.late) return "late";
  if (bucket.runs === 0) return "none";
  return "ok";
}

export function barCounts(
  hourly: readonly HourBucket[],
): Record<BarState, number> {
  const counts: Record<BarState, number> = {
    failed: 0,
    late: 0,
    none: 0,
    ok: 0,
  };
  for (const bucket of hourly) counts[barState(bucket)] += 1;
  return counts;
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
export function overallHourly(jobs: readonly JobCollection[]): HourCounts[] {
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
export function lowestHour(hourly: readonly HourCounts[]): HourCounts | null {
  let lowest: HourCounts | null = null;
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

// 장애 하나를 가리키는 키(수집기·종류·시작 시각). 다시 불러와 순서가 바뀌어도 같은 장애를 가리킴
export function incidentKey(incident: JobIncident): string {
  return `${incident.job}|${incident.kind}|${incident.startedAt}`;
}

// 수집기 장애를 한 목록으로(최신 먼저). 같은 시각이면 실패 → 관측소 빠짐, 그다음 수집기 이름 순(목록·↑↓ 순서가 늘 같게)
const KIND_ORDER: Record<IncidentKind, number> = { failure: 0, stations: 1 };

export function allIncidents(jobs: readonly JobCollection[]): JobIncident[] {
  return jobs
    .flatMap((job) => job.incidents.map((i) => ({ ...i, job: job.job })))
    .sort(
      (a, b) =>
        (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0) ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        (a.job < b.job ? -1 : a.job > b.job ? 1 : 0),
    );
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

// 실패 사유 화면 문구(같은 사유가 여러 번이면 횟수를 붙임). 수집 현황·데이터 출처가 같이 씀
export function reasonText(failure: RunFailure): string {
  const t = messages.collection;
  const { key, value } = reasonOf(failure);
  const base = fill(t.reason[key], { value });
  return failure.count && failure.count > 1
    ? fill(t.reasonCount, { reason: base, count: failure.count })
    : base;
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

// 장애 경과: 시작 → 경보 → 관측소 돌아옴 → 해결(시각순). 끝나지 않았으면 맨 끝에 '이어지는 중'
export type TimelineEvent =
  | { readonly type: "start"; readonly at: string }
  | { readonly type: "alarm"; readonly at: string; readonly alarm: AlarmEvent }
  | { readonly type: "returned"; readonly at: string; readonly station: string }
  | { readonly type: "end"; readonly at: string }
  | { readonly type: "ongoing"; readonly at: string };

export function incidentTimeline(
  incident: Incident,
  nowIso: string,
): TimelineEvent[] {
  // 서버는 장애 앞뒤 10분 안의 경보도 붙임 → 시작·해결까지 모두 시각순(같은 시각이면 시작 → 경보 → 돌아옴 → 해결)
  // 이어지는 중은 지금 시각이라 맨 끝
  const events: TimelineEvent[] = [
    { type: "start", at: incident.startedAt },
    ...(incident.alarms ?? []).map((alarm): TimelineEvent => ({
      type: "alarm",
      at: alarm.at,
      alarm,
    })),
    ...incident.stations
      .filter((gap) => gap.returnedAt !== null)
      .map((gap): TimelineEvent => ({
        type: "returned",
        at: gap.returnedAt as string,
        station: gap.id,
      })),
    ...(incident.endedAt
      ? [{ type: "end", at: incident.endedAt } as TimelineEvent]
      : []),
  ];
  const rank: Record<TimelineEvent["type"], number> = {
    start: 0,
    alarm: 1,
    returned: 2,
    end: 3,
    ongoing: 4,
  };
  events.sort(
    (a, b) =>
      Date.parse(a.at) - Date.parse(b.at) || rank[a.type] - rank[b.type],
  );
  return incident.endedAt
    ? events
    : [...events, { type: "ongoing", at: nowIso }];
}

// 경보 이름(접두어 뺀 것) → 묶음과 출처. 모르는 경보는 other(이름을 그대로 보여 줌)
export type AlarmKind = "stopped" | "errors" | "failing" | "other";
export type AlarmSource = CollectionJobId | "publish" | null;

const ALARM_SOURCES: readonly [string, AlarmSource][] = [
  ["Warnings", "collect-warnings"],
  ["Ocean", "collect-ocean"],
  ["Rip", "collect-rip"],
  ["Weather", "collect-weather"],
  ["Catalog", "collect-catalog"],
  ["Publish", "publish"],
];

export function alarmInfo(id: string): {
  kind: AlarmKind;
  source: AlarmSource;
} {
  const entry = ALARM_SOURCES.find(([head]) => id.startsWith(head));
  if (!entry) return { kind: "other", source: null };
  const [head, source] = entry;
  const rest = id.slice(head.length);
  if (rest === "Stopped") return { kind: "stopped", source };
  if (rest === "Errors") return { kind: "errors", source };
  if (rest === "Failing") return { kind: "failing", source };
  return { kind: "other", source };
}

// 울리는 경보를 먼저, 그다음 이름순
const STATE_ORDER: Record<AlarmState, number> = {
  ALARM: 0,
  unknown: 1,
  INSUFFICIENT_DATA: 2,
  OK: 3,
};

export function sortedAlarms(list: readonly AlarmView[]): AlarmView[] {
  return [...list].sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] || (a.id < b.id ? -1 : 1),
  );
}

// AWS 콘솔 주소. region은 운영 API가 준 값(경보를 읽지 못하면 지역 없이 기본 콘솔)
export function cloudWatchUrl(
  region: string | null,
  alarmName?: string,
): string {
  if (!region)
    return "https://console.aws.amazon.com/cloudwatch/home#alarmsV2:";
  const base = `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:`;
  return alarmName ? `${base}alarm/${encodeURIComponent(alarmName)}` : base;
}

export function logsUrl(region: string, functionName: string): string {
  const group = `/aws/lambda/${functionName}`.replace(/\//g, "$252F");
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/${group}`;
}

export function lambdaUrl(region: string, functionName: string): string {
  return `https://${region}.console.aws.amazon.com/lambda/home?region=${region}#/functions/${encodeURIComponent(functionName)}`;
}

// 출처 표 거르기: 전체 · 판단에 씀 · 참고 · 문제 있음(정상이 아닌 출처. 기록 없음도 문제로 봄)
export type SourceFilter = "all" | "judgment" | "reference" | "problem";

export function matchesFilter(
  filter: SourceFilter,
  row: SourceRow,
  state: SourceState,
): boolean {
  if (filter === "judgment") return row.judgment;
  if (filter === "reference") return !row.judgment;
  if (filter === "problem") return state !== "ok";
  return true;
}

// 경보를 묶음별로(출처 응답 없음 · 실행 오류 · 실패 이어짐 · 그 밖). 묶음 안은 울리는 것 먼저
export function groupedAlarms(
  list: readonly AlarmView[],
): { kind: AlarmKind; alarms: AlarmView[] }[] {
  const order: readonly AlarmKind[] = ["stopped", "errors", "failing", "other"];
  const byKind = new Map<AlarmKind, AlarmView[]>();
  for (const alarm of list) {
    const { kind } = alarmInfo(alarm.id);
    byKind.set(kind, [...(byKind.get(kind) ?? []), alarm]);
  }
  return order.flatMap((kind) => {
    const alarms = byKind.get(kind);
    return alarms ? [{ kind, alarms: sortedAlarms(alarms) }] : [];
  });
}
