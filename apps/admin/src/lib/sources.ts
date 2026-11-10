import { opsFetch, type OpsResult } from "./auth/ops-fetch";
import { validFailure, type CollectionJobId, type RunView } from "./collection";

// 데이터 출처 (BRD-149·GH-328, 화면 설계서 6장 ADM-SRC, 시안 4차 V12·V13·VM13)
// 운영 API GET /ops/sources 응답 모양과 화면용 계산. 서버(services/src/admin/sources.ts)가 원본이라 모양만 맞춤
// - 읽기 전용. 인증키는 등록 여부·만료일만(값은 서버도 읽지 않음). 원본 응답은 저장하지 않으므로 보여 주지 않음
// - 최근 실행을 읽지 못하면(null) '확인 못 함', 빈 배열은 '기록 없음'. 둘을 섞지 않고 정상으로 보지 않음
// - 지연 판정은 수집 현황(서버 overdue)이 맡음. 여기서 다시 정하지 않음

export type Provider = "kma" | "khoa" | "kto";
export type KeyName = "data-go-kr" | "kma-apihub";

export interface SourceCall {
  readonly url: string;
  readonly operation: string;
  readonly rowLimit: number | null;
  readonly issued: {
    readonly hoursKst: readonly number[];
    readonly delayMinutes: number;
  } | null;
}

export interface SourceSchedule {
  readonly periodMinutes: number;
  readonly offsetMinutes: number;
  readonly offSeason: {
    readonly slotUtcMinutes: number;
    readonly seasonMonths: readonly number[];
  } | null;
}

export interface SourceView {
  readonly id: CollectionJobId;
  readonly provider: Provider;
  readonly key: KeyName;
  readonly judgment: boolean;
  readonly calls: readonly SourceCall[];
  readonly schedule: SourceSchedule;
  readonly budgetMs: number | null;
  readonly extraRetryMax: number | null;
  readonly lateAfterMinutes: number | null;
  readonly recentRuns: readonly RunView[] | null;
  readonly unreadableRuns: number;
}

export type KeyStatus = "registered" | "missing" | "unknown";

export interface KeyView {
  readonly name: KeyName;
  readonly status: KeyStatus;
  readonly expiresOn: string | null;
  readonly daysLeft: number | null;
  readonly expiresInvalid: boolean;
}

export interface SourcesView {
  readonly generatedAt: string;
  readonly sources: readonly SourceView[];
  readonly http: { readonly timeoutMs: number; readonly retries: number };
  readonly keys: readonly KeyView[];
  readonly keysHidden: boolean;
}

const JOBS: readonly CollectionJobId[] = [
  "collect-warnings",
  "collect-ocean",
  "collect-rip",
  "collect-weather",
  "collect-catalog",
];
const PROVIDERS: readonly Provider[] = ["kma", "khoa", "kto"];
const KEYS: readonly KeyName[] = ["data-go-kr", "kma-apihub"];
const KEY_STATUSES: readonly KeyStatus[] = ["registered", "missing", "unknown"];
const RUN_STATUSES = ["complete", "partial", "failed"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown) => v === null || isNum(v);
const numList = (v: unknown) => Array.isArray(v) && v.every(isNum);
// 시각 문자열은 날짜로 읽혀야 함(못 읽는 값은 KST 표시에서 깨지므로 불러오기 실패로)
const isTime = (v: unknown) =>
  typeof v === "string" && Number.isFinite(Date.parse(v));

function validCall(v: unknown): boolean {
  if (!isObj(v)) return false;
  const issued = v.issued;
  return (
    typeof v.url === "string" &&
    typeof v.operation === "string" &&
    numOrNull(v.rowLimit) &&
    (issued === null ||
      (isObj(issued) && numList(issued.hoursKst) && isNum(issued.delayMinutes)))
  );
}

function validSchedule(v: unknown): boolean {
  if (!isObj(v)) return false;
  const off = v.offSeason;
  return (
    Number.isInteger(v.periodMinutes) &&
    (v.periodMinutes as number) > 0 &&
    Number.isInteger(v.offsetMinutes) &&
    (v.offsetMinutes as number) >= 0 &&
    (off === null ||
      (isObj(off) && isNum(off.slotUtcMinutes) && numList(off.seasonMonths)))
  );
}

function validRun(v: unknown): boolean {
  return (
    isObj(v) &&
    isTime(v.startedAt) &&
    isTime(v.finishedAt) &&
    RUN_STATUSES.includes(v.status as string) &&
    Array.isArray(v.failures) &&
    v.failures.every(validFailure) &&
    // 빠진 관측소(collect-ocean)는 있으면 모양까지 봄(틀리면 성공만 보이고 빠진 곳이 숨지 않게 불러오기 실패)
    (v.missingStations === undefined ||
      (Array.isArray(v.missingStations) &&
        v.missingStations.every((s) => typeof s === "string"))) &&
    (v.missingStationsTotal === undefined || isNum(v.missingStationsTotal))
  );
}

function validSource(v: unknown): boolean {
  return (
    isObj(v) &&
    JOBS.includes(v.id as CollectionJobId) &&
    PROVIDERS.includes(v.provider as Provider) &&
    KEYS.includes(v.key as KeyName) &&
    typeof v.judgment === "boolean" &&
    Array.isArray(v.calls) &&
    v.calls.every(validCall) &&
    validSchedule(v.schedule) &&
    numOrNull(v.budgetMs) &&
    numOrNull(v.extraRetryMax) &&
    numOrNull(v.lateAfterMinutes) &&
    (v.recentRuns === null ||
      (Array.isArray(v.recentRuns) && v.recentRuns.every(validRun))) &&
    isNum(v.unreadableRuns)
  );
}

function validKey(v: unknown): boolean {
  return (
    isObj(v) &&
    KEYS.includes(v.name as KeyName) &&
    KEY_STATUSES.includes(v.status as KeyStatus) &&
    (v.expiresOn === null || typeof v.expiresOn === "string") &&
    numOrNull(v.daysLeft) &&
    typeof v.expiresInvalid === "boolean"
  );
}

// 모양이 하나라도 틀리면 불러오기 실패. 빈 목록·'기록 없음'·'등록 안 됨'으로 채우지 않음
export function validSources(body: unknown): body is SourcesView {
  if (!isObj(body) || !Array.isArray(body.sources)) return false;
  const sources: readonly unknown[] = body.sources;
  return (
    isTime(body.generatedAt) &&
    sources.every(validSource) &&
    // 출처 5곳이 한 번씩 모두 있어야 함. 빠지면(판단 출처 포함) '0/0'·'연결된 출처 0곳'처럼 정상으로 보이고,
    // 같은 출처가 두 번 오면 상세·목록 키가 겹침
    sources.length === JOBS.length &&
    JOBS.every((job) => sources.some((s) => (s as Obj).id === job)) &&
    isObj(body.http) &&
    isNum(body.http.timeoutMs) &&
    isNum(body.http.retries) &&
    Array.isArray(body.keys) &&
    body.keys.every(validKey) &&
    typeof body.keysHidden === "boolean"
  );
}

export async function fetchSources(
  accessToken: () => Promise<string | null>,
): Promise<OpsResult<SourcesView>> {
  const result = await opsFetch<unknown>("/ops/sources", accessToken);
  if (!result.ok) return result;
  if (!validSources(result.body)) {
    return {
      ok: false,
      status: result.status,
      code: "format",
      requestId: null,
    };
  }
  return { ...result, body: result.body };
}

// 최근 실행 상태: 정상·일부 실패·실패 · 기록 없음(빈 배열) · 확인 못 함(읽지 못함)
// 읽지 못한 기록이 있으면 최신 실행이 빠졌을 수 있어 '확인 못 함'(정상으로 보이지 않게)
export type RunState = "complete" | "partial" | "failed" | "none" | "unknown";

export function latestState(source: SourceView): RunState {
  if (source.recentRuns === null || source.unreadableRuns > 0) return "unknown";
  return source.recentRuns[0]?.status ?? "none";
}

// 수집 시각(KST 분). 격자는 UTC 자정에서 offsetMinutes 뒤부터 periodMinutes마다
// 매시 같은 분에 돌면(60을 나누는 주기) 분만(:03 :18 …), 그 밖은 하루 시각(04:20)
const KST_OFFSET = 9 * 60;
const DAY = 24 * 60;
const pad = (n: number) => String(n).padStart(2, "0");

export function kstClock(utcMinutes: number): string {
  const m = (((utcMinutes + KST_OFFSET) % DAY) + DAY) % DAY;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function scheduleSlots(schedule: SourceSchedule): string[] {
  const { periodMinutes, offsetMinutes } = schedule;
  if (60 % periodMinutes === 0) {
    const slots: string[] = [];
    for (let m = offsetMinutes % periodMinutes; m < 60; m += periodMinutes) {
      slots.push(`:${pad(m)}`);
    }
    return slots;
  }
  const slots: string[] = [];
  for (let m = offsetMinutes % periodMinutes; m < DAY; m += periodMinutes) {
    slots.push(kstClock(m));
  }
  return slots.sort();
}

// 시즌 달을 이어지는 구간으로([6,7,8,9] → [[6,9]], [11,12,1,2] → [[11,2]], [6,8] → [[6,6],[8,8]])
export function monthRanges(months: readonly number[]): [number, number][] {
  const sorted = [...new Set(months)].sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  for (const m of sorted) {
    const last = ranges.at(-1);
    if (last && m === last[1] + 1) last[1] = m;
    else ranges.push([m, m]);
  }
  // 12월과 1월이 이어지면 해를 넘는 한 구간으로
  const first = ranges[0];
  const tail = ranges.at(-1);
  if (ranges.length > 1 && first && tail && first[0] === 1 && tail[1] === 12) {
    ranges.pop();
    ranges[0] = [tail[0], first[1]];
    ranges.push(ranges.shift()!);
  }
  return ranges;
}

// 출처들이 쓰는 인증키 이름(요약·키 목록이 같은 목록을 씀)
export function keyNames(view: SourcesView): KeyName[] {
  return [...new Set(view.sources.map((s) => s.key))];
}

export function keyOf(view: SourcesView, name: KeyName): KeyView | undefined {
  return view.keys.find((k) => k.name === name);
}

// 인증키 표시 상태. 만료일이 지난 것만 따로 알림(며칠 전부터 경고할지는 정하지 않음 → 남은 날만 보여 줌)
export type KeyState =
  | "hidden"
  | "unknown"
  | "missing"
  | "expired"
  | "invalid"
  | "noExpiry"
  | "registered";

export function keyState(view: SourcesView, name: KeyName): KeyState {
  if (view.keysHidden) return "hidden";
  const key = keyOf(view, name);
  // 응답에 키가 빠졌으면 '등록 안 됨'이 아니라 '확인 못 함'
  if (!key || key.status === "unknown") return "unknown";
  if (key.status === "missing") return "missing";
  if (key.expiresInvalid) return "invalid";
  if (key.daysLeft === null) return "noExpiry";
  return key.daysLeft < 0 ? "expired" : "registered";
}
