import {
  CloudWatchClient,
  DescribeAlarmHistoryCommand,
  DescribeAlarmsCommand,
} from "@aws-sdk/client-cloudwatch";
import type { CollectionJob, Incident } from "./collection";

// 수집 현황 · CloudWatch 경보 (BRD-187, 화면 ADM-COLLECT)
// 운영 경보(infra/lib/ops/alarms.ts)의 설정·상태와 7일 상태 변경 기록을 읽음. 이름이 스택 접두어(BaradunV2-)인 경보만
// - 받는 주소(SNS 구독)는 읽지 않고 내보내지 않음
// - 읽지 못하면 unavailable. 화면은 '경보 기록 없음'이 아니라 '확인 못 함'으로 보여 줌
// - 알림 '출처 응답 없음 N분'은 경보 설정(구간 × 구간 수) 그대로. 화면에 숫자를 따로 적지 않음

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 8;
// 장애 앞뒤로 경보가 늦게 울리는 시간(오류 경보 5분 구간 + 평가 지연)
const ALARM_LAG_MS = 10 * 60 * 1000;

export type AlarmState = "OK" | "ALARM" | "INSUFFICIENT_DATA" | "unknown";

export interface AlarmView {
  readonly id: string; // 접두어를 뺀 이름(예: OceanErrors). 화면 문구 키로 씀
  readonly name: string; // 전체 이름(CloudWatch 콘솔 링크)
  readonly state: AlarmState;
  readonly stateUpdatedAt: string | null;
  readonly description: string;
  // 울리기까지 보는 시간(구간 × 평가 구간 수, 분). 모르면 null
  readonly windowMinutes: number | null;
  readonly functionName: string | null; // 대상 Lambda(콘솔 링크). 없으면 null
}

export interface AlarmEvent {
  readonly id: string;
  readonly name: string;
  readonly at: string; // UTC ISO
  readonly from: AlarmState;
  readonly to: AlarmState;
}

export type AlarmsView =
  | {
      readonly status: "ok";
      readonly region: string;
      readonly list: readonly AlarmView[];
      readonly history: readonly AlarmEvent[]; // 최신 먼저
    }
  | { readonly status: "unavailable" };

// CloudWatch 호출을 감싼 것. 테스트는 가짜를 넣음
export interface AlarmReader {
  readonly region: string;
  readonly prefix: string; // 예: "BaradunV2-"
  describe(): Promise<readonly unknown[]>; // MetricAlarms 원본
  history(name: string, since: Date): Promise<readonly unknown[]>; // AlarmHistoryItems 원본
}

const STATES: readonly AlarmState[] = ["OK", "ALARM", "INSUFFICIENT_DATA"];

function toState(value: unknown): AlarmState {
  return STATES.includes(value as AlarmState)
    ? (value as AlarmState)
    : "unknown";
}

function toIso(value: unknown): string | null {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

type Dimension = { Name?: unknown; Value?: unknown };
type MetricQuery = {
  Period?: unknown;
  MetricStat?: { Period?: unknown; Metric?: { Dimensions?: Dimension[] } };
};

function functionOf(dimensions: Dimension[] | undefined): string | null {
  const found = dimensions?.find((d) => d.Name === "FunctionName")?.Value;
  return typeof found === "string" ? found : null;
}

export function toAlarmView(raw: unknown, prefix: string): AlarmView | null {
  const alarm = (raw ?? {}) as Record<string, unknown>;
  const name = alarm.AlarmName;
  if (typeof name !== "string" || !name.startsWith(prefix)) return null;
  const metrics = (
    Array.isArray(alarm.Metrics) ? alarm.Metrics : []
  ) as MetricQuery[];
  const periods = [
    alarm.Period,
    ...metrics.flatMap((m) => [m.Period, m.MetricStat?.Period]),
  ].filter((p): p is number => typeof p === "number" && p > 0);
  const evaluation = alarm.EvaluationPeriods;
  const windowMinutes =
    periods.length > 0 && typeof evaluation === "number"
      ? (Math.max(...periods) / 60) * evaluation
      : null;
  return {
    id: name.slice(prefix.length),
    name,
    state: toState(alarm.StateValue),
    stateUpdatedAt: toIso(alarm.StateUpdatedTimestamp),
    description:
      typeof alarm.AlarmDescription === "string" ? alarm.AlarmDescription : "",
    windowMinutes,
    functionName:
      functionOf(alarm.Dimensions as Dimension[] | undefined) ??
      metrics
        .map((m) => functionOf(m.MetricStat?.Metric?.Dimensions))
        .find((f) => f !== null) ??
      null,
  };
}

// 상태 변경 기록 한 건. HistoryData(JSON)의 oldState·newState
export function toAlarmEvent(raw: unknown, prefix: string): AlarmEvent | null {
  const item = (raw ?? {}) as Record<string, unknown>;
  const name = item.AlarmName;
  const at = toIso(item.Timestamp);
  if (typeof name !== "string" || !name.startsWith(prefix) || at === null)
    return null;
  let data: {
    oldState?: { stateValue?: unknown };
    newState?: { stateValue?: unknown };
  } = {};
  try {
    data =
      typeof item.HistoryData === "string" ? JSON.parse(item.HistoryData) : {};
  } catch {
    data = {};
  }
  return {
    id: name.slice(prefix.length),
    name,
    at,
    from: toState(data.oldState?.stateValue),
    to: toState(data.newState?.stateValue),
  };
}

export async function readAlarms(
  reader: AlarmReader | null,
  now: Date,
): Promise<AlarmsView> {
  if (!reader) return { status: "unavailable" };
  try {
    const list = (await reader.describe())
      .map((raw) => toAlarmView(raw, reader.prefix))
      .filter((a): a is AlarmView => a !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
    const since = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);
    // 한 경보라도 기록을 읽지 못하면 전체를 확인 못 함으로(일부만 보여 주며 '경보 없음'으로 읽히지 않게)
    const items = await Promise.all(
      list.map((alarm) => reader.history(alarm.name, since)),
    );
    const history = items
      .flat()
      .map((raw) => toAlarmEvent(raw, reader.prefix))
      .filter((e): e is AlarmEvent => e !== null)
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    return { status: "ok", region: reader.region, list, history };
  } catch {
    return { status: "unavailable" };
  }
}

// 경보 이름 앞부분 → 수집기(infra/lib/ops/alarms.ts의 경보 ID). Publish·LoginAbuse·NotificationFailed는 수집기 경보가 아님
const ALARM_JOBS: readonly [string, CollectionJob][] = [
  ["Warnings", "collect-warnings"],
  ["Ocean", "collect-ocean"],
  ["Rip", "collect-rip"],
  ["Catalog", "collect-catalog"],
  ["Weather", "collect-weather"],
];

export function alarmJob(id: string): CollectionJob | null {
  return ALARM_JOBS.find(([head]) => id.startsWith(head))?.[1] ?? null;
}

// 장애 동안(앞뒤 여유 포함) 그 수집기 경보가 ALARM으로 바뀐 기록. 읽지 못했으면 null
export function incidentAlarms(
  view: AlarmsView,
  job: CollectionJob,
  incident: Incident,
  nowMs: number,
): AlarmEvent[] | null {
  if (view.status !== "ok") return null;
  const from = Date.parse(incident.startedAt) - ALARM_LAG_MS;
  const to =
    (incident.endedAt === null ? nowMs : Date.parse(incident.endedAt)) +
    ALARM_LAG_MS;
  return view.history
    .filter((event) => {
      const at = Date.parse(event.at);
      return (
        event.to === "ALARM" &&
        alarmJob(event.id) === job &&
        at >= from &&
        at <= to
      );
    })
    .sort((a, b) => (a.at < b.at ? -1 : 1));
}

// 운영 Lambda에서 쓰는 실제 읽기. 지표 경보만(복합 경보는 권한을 경보 단위로 좁힐 수 없어 쓰지 않음)
export function cloudWatchAlarmReader(
  region: string,
  prefix: string,
  client = new CloudWatchClient({ region }),
): AlarmReader {
  return {
    region,
    prefix,
    async describe() {
      const alarms: unknown[] = [];
      let nextToken: string | undefined;
      do {
        const result = await client.send(
          new DescribeAlarmsCommand({
            AlarmNamePrefix: prefix,
            AlarmTypes: ["MetricAlarm"],
            ...(nextToken ? { NextToken: nextToken } : {}),
          }),
        );
        alarms.push(...(result.MetricAlarms ?? []));
        nextToken = result.NextToken;
      } while (nextToken);
      return alarms;
    },
    async history(name, since) {
      const result = await client.send(
        new DescribeAlarmHistoryCommand({
          AlarmName: name,
          AlarmTypes: ["MetricAlarm"],
          HistoryItemType: "StateUpdate",
          StartDate: since,
          ScanBy: "TimestampDescending",
          MaxRecords: 100,
        }),
      );
      return result.AlarmHistoryItems ?? [];
    },
  };
}
