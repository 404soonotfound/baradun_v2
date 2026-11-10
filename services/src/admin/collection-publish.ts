import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  PUBLISH_SUMMARY_PK,
  STATION_TABLE_KEY,
  type StationTable,
  type StationUse,
} from "../core/collect/publish-summary";
import type { Incident } from "./collection";
import type { Sender } from "./writes";

// 수집 현황 · 게시 요약 (BRD-187, 화면 ADM-COLLECT)
// publisher가 게시할 때 남긴 요약(core/collect/publish-summary.ts)만 읽어 관측 지연 해변 수와 장애의 해변 영향을 만듦
// - 분류를 다시 계산하지 않음. '관측 지연'은 publisher가 게시한 사유 그대로
// - 요약이 빠졌거나(previous 사슬이 끊김) 읽지 못하면 '확인 못 함'. '영향 없음'·0으로 바꾸지 않음
// - Ops는 고정 읽기 용량(5)이라 기간 요약은 관측 장애가 있을 때 가장 오래된 장애 시작부터만 읽음

const MAX_PAGES = 10;
// 장애 앞뒤로 게시가 늦게 따라오는 시간. 수집 뒤 게시가 깨어나 끝날 때까지
const PUBLISH_LAG_MS = 10 * 60 * 1000;

// 해변 영향 판정에 쓰는 가벼운 요약(관측소 표 없음)
export interface SummaryLite {
  readonly version: string;
  readonly previous: string | null;
  readonly publishedAt: string;
  readonly beachCount: number;
  readonly delayedBeachIds: readonly string[];
}

export interface PublishView {
  readonly version: string;
  readonly publishedAt: string;
  readonly beachCount: number;
  // 사유에 관측 지연이 있는 해변 수(publisher 분류 그대로)
  readonly delayedBeaches: number;
}

export interface SummaryRead {
  // 버전 오름차순. failed면 비어 있음
  readonly list: readonly SummaryLite[];
  // 가장 최근 요약. 없으면 null
  readonly latest: SummaryLite | null;
  // 관측소 표(publisher가 해변 파일로 만든 것). 없거나 모양이 틀리면 null
  readonly stations: StationTable | null;
  // 읽기 실패. 이때는 모든 영향이 '확인 못 함'
  // 상한 초과는 최근 쪽 요약이 빠져 구간 끝 사슬 확인에서 그 장애가 summary_missing이 됨
  readonly failed: boolean;
  // 지금 게시본의 요약. 버전이 다르거나 없으면 null
  live(version: string | null): PublishView | null;
}

export interface StationImpact {
  readonly id: string;
  readonly name: string | null; // 지금 게시본 요약에 없으면 null
  readonly beaches: number | null; // 이 관측소를 쓰는 해변 수
  readonly waveBeaches: number | null; // 이 관측소를 파고로 쓰는 해변 수
}

export type ImpactUnknownReason =
  | "summary_unread" // 요약을 읽지 못함
  | "summary_missing" // 장애 구간의 게시 요약이 빠짐(사슬 끊김·첫 게시본 없음)
  | "station_unknown"; // 빠진 관측소가 지금 게시본 요약에 없음

export interface ImpactView {
  // affected: 장애 구간에 그 관측소를 쓰는 해변이 '관측 지연'으로 게시됨
  // none: 구간 요약을 모두 확인했고 그런 해변이 없음. unknown: 확인 못 함
  readonly status: "affected" | "none" | "unknown";
  readonly reason?: ImpactUnknownReason;
  // 출처 전체 실패(파고를 받는 sea_obs·저장 실패 등) → 모든 파고 관측소가 영향 범위
  readonly wholeSource: boolean;
  // 영향 범위에서 '관측 지연'으로 게시된 해변(unknown이면 빈 배열)
  readonly delayedBeachIds: readonly string[];
  readonly stations: readonly StationImpact[];
}

function toLite(item: Record<string, unknown>): SummaryLite | null {
  const { version, previous, publishedAt, beachCount, delayedBeachIds } = item;
  if (
    typeof version !== "string" ||
    typeof publishedAt !== "string" ||
    typeof beachCount !== "number" ||
    !Array.isArray(delayedBeachIds)
  ) {
    return null;
  }
  return {
    version,
    previous: typeof previous === "string" ? previous : null,
    publishedAt,
    beachCount,
    delayedBeachIds: delayedBeachIds.filter(
      (id): id is string => typeof id === "string",
    ),
  };
}

function toStations(value: unknown): Record<string, StationUse> | null {
  if (typeof value !== "object" || value === null) return null;
  const stations: Record<string, StationUse> = {};
  for (const [id, raw] of Object.entries(value)) {
    const { name, beachIds, waveBeachIds } = (raw ?? {}) as Record<
      string,
      unknown
    >;
    if (
      typeof name !== "string" ||
      !Array.isArray(beachIds) ||
      !Array.isArray(waveBeachIds)
    ) {
      return null; // 모양이 틀린 표로 영향 없음을 만들지 않음
    }
    stations[id] = {
      name,
      beachIds: beachIds.filter((b): b is string => typeof b === "string"),
      waveBeachIds: waveBeachIds.filter(
        (b): b is string => typeof b === "string",
      ),
    };
  }
  return stations;
}

// UTC ISO → 게시 버전 모양(20261104T051000Z). 요약 키(sk)와 비교함
export function versionOf(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

function summaryRead(
  list: readonly SummaryLite[],
  latest: SummaryLite | null,
  stations: StationTable | null,
  failed: boolean,
): SummaryRead {
  return {
    list,
    latest,
    stations,
    failed,
    live(version) {
      if (failed || !latest || version === null || latest.version !== version)
        return null;
      return {
        version: latest.version,
        publishedAt: latest.publishedAt,
        beachCount: latest.beachCount,
        delayedBeaches: latest.delayedBeachIds.length,
      };
    },
  };
}

const LITE_PROJECTION = {
  ProjectionExpression: "#v, #p, #at, #n, #d",
  ExpressionAttributeNames: {
    "#v": "version",
    "#p": "previous",
    "#at": "publishedAt",
    "#n": "beachCount",
    "#d": "delayedBeachIds",
  },
} as const;

// fromMs: 해변 영향을 볼 가장 오래된 장애 시작. null이면 기간 요약을 읽지 않음(최신 요약·관측소 표만)
export async function readPublishSummaries(
  client: Sender,
  opsTable: string,
  fromMs: number | null,
): Promise<SummaryRead> {
  try {
    const query = (
      condition: string,
      values: Record<string, string>,
      forward: boolean,
      extra: Record<string, unknown> = {},
    ) =>
      client.send(
        new QueryCommand({
          TableName: opsTable,
          KeyConditionExpression: condition,
          ...LITE_PROJECTION,
          ExpressionAttributeValues: { ":pk": PUBLISH_SUMMARY_PK, ...values },
          ScanIndexForward: forward,
          ...extra,
        }),
      );
    const items = (result: { Items?: unknown[] | undefined }) =>
      ((result.Items ?? []) as Record<string, unknown>[])
        .map(toLite)
        .filter((lite): lite is SummaryLite => lite !== null);

    const [latestResult, tableResult] = await Promise.all([
      query("pk = :pk", {}, false, { Limit: 1 }),
      client.send(
        new GetCommand({ TableName: opsTable, Key: STATION_TABLE_KEY }),
      ),
    ]);
    const latest = items(latestResult)[0] ?? null;
    const stations = toStations(
      (tableResult.Item as Record<string, unknown> | undefined)?.stations,
    );
    if (fromMs === null) return summaryRead([], latest, stations, false);

    const from = versionOf(fromMs);
    // 장애 시작 때 보이던 게시본(시작 시각 이하에서 가장 최근) 하나
    const before = items(
      await query("pk = :pk AND sk <= :from", { ":from": from }, false, {
        Limit: 1,
      }),
    );
    // 그 뒤 요약은 오래된 순. 상한에 걸리면 최근 쪽이 빠짐(구간 끝 사슬 확인이 '확인 못 함'으로 막음)
    const after: SummaryLite[] = [];
    let startKey: Record<string, unknown> | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await query(
        "pk = :pk AND sk > :from",
        { ":from": from },
        true,
        startKey ? { ExclusiveStartKey: startKey } : {},
      );
      after.push(...items(result));
      startKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (!startKey) break;
    }
    return summaryRead([...before, ...after], latest, stations, false);
  } catch {
    return summaryRead([], null, null, true);
  }
}

// 장애 구간에 앱에 보였던 게시본 요약. 시작 시각에 보이던 게시본부터 끝(+게시 지연)까지
// 사슬(previous)이 끊겼거나(구간 바로 뒤 요약 포함), 뒤 요약이 없는데 마지막이 지금 게시본이 아니면 null
function windowSummaries(
  list: readonly SummaryLite[],
  incident: Incident,
  publishedVersion: string | null,
  nowMs: number,
): SummaryLite[] | null {
  const startVersion = versionOf(Date.parse(incident.startedAt));
  const endMs =
    incident.endedAt === null
      ? nowMs
      : Math.min(nowMs, Date.parse(incident.endedAt) + PUBLISH_LAG_MS);
  const endVersion = versionOf(endMs);
  let first = -1;
  list.forEach((summary, i) => {
    if (summary.version <= startVersion) first = i;
  });
  if (first < 0) return null;
  const window = [list[first]!];
  for (let i = first + 1; i < list.length; i++) {
    if (list[i]!.version > endVersion) break;
    window.push(list[i]!);
  }
  for (let i = 1; i < window.length; i++) {
    if (window[i]!.previous !== window[i - 1]!.version) return null;
  }
  // 구간 마지막 요약 바로 뒤도 사슬로 확인함. 뒤 요약이 없으면 마지막이 지금 게시본이어야 함
  // (구간 끝 직전·시작 직전 요약이 빠진 채 구간 안 요약이 하나뿐이어도 '영향 없음'이 되지 않게)
  const next = list[first + window.length];
  const last = window.at(-1)!.version;
  if (next ? next.previous !== last : last !== publishedVersion) return null;
  return window;
}

function unknown(
  reason: ImpactUnknownReason,
  wholeSource: boolean,
  stations: StationImpact[],
): ImpactView {
  return {
    status: "unknown",
    reason,
    wholeSource,
    delayedBeachIds: [],
    stations,
  };
}

// collect-ocean 장애의 해변 영향. 파고 관측소만 분류(관측 지연)에 쓰이므로 파고로 쓰는 해변만 셈
// 파주기·파향 출처(kma_buoy)만 실패했으면 파고 관측소는 영향 범위가 아님
export function incidentImpact(
  incident: Incident,
  read: SummaryRead,
  publishedVersion: string | null,
  nowMs: number,
): ImpactView {
  const wholeSource = incident.failures.some((f) => f.source !== "kma_buoy");
  const table = read.stations;
  const stations: StationImpact[] = incident.stations.map(({ id }) => {
    const use = table?.[id];
    return {
      id,
      name: use?.name ?? null,
      beaches: use ? use.beachIds.length : null,
      waveBeaches: use ? use.waveBeachIds.length : null,
    };
  });
  if (read.failed) return unknown("summary_unread", wholeSource, stations);
  const window = windowSummaries(read.list, incident, publishedVersion, nowMs);
  if (!window) return unknown("summary_missing", wholeSource, stations);
  let scope: Set<string> | null = null; // null = 모든 해변(출처 전체 실패)
  if (!wholeSource) {
    if (!table || stations.some((s) => s.waveBeaches === null)) {
      return unknown("station_unknown", wholeSource, stations);
    }
    scope = new Set(
      incident.stations.flatMap(({ id }) => table[id]!.waveBeachIds),
    );
  }
  const delayed = new Set<string>();
  for (const summary of window) {
    for (const id of summary.delayedBeachIds) {
      if (scope === null || scope.has(id)) delayed.add(id);
    }
  }
  return {
    status: delayed.size > 0 ? "affected" : "none",
    wholeSource,
    delayedBeachIds: [...delayed].sort(),
    stations,
  };
}
