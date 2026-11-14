import { lookupActorEmails, type OperatorEmailLookup } from "./actor-emails";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { ManifestFile, Notice } from "@baradun/contracts";
import { COLLECT_POLICY } from "../collectors/policy";
import { nextSlot } from "../collectors/schedule";
import {
  PUBLISH_JOB_RUN_LIMIT_MS,
  PUBLISH_JOB_START_LIMIT_MS,
  publishJobKey,
  toPublishJob,
  type PublishJob,
} from "../core/collect/publish-job";
import {
  canonicalJson as canonical,
  PUBLISH_CATEGORIES,
  PUBLISH_RUN_LAST_SK,
  PUBLISH_RUN_HISTORY_PREFIX,
  PUBLISH_RUN_PK,
  PUBLISH_SUMMARY_PK,
  type CategoryCounts,
  type PublishSource,
  type PublishRunDetails,
} from "../core/collect/publish-summary";
import type { SnapshotStore } from "../core/snapshots/types";
import {
  DynamoOpsStore,
  lockKey,
  NOTICE_HOLD_KEY,
  toNoticeHold,
} from "../core/store/dynamodb";
import type { NoticeHold } from "../core/store/types";
import { MANIFEST_SETTINGS, PUBLISH_POLICY } from "../publisher/policy";
import {
  applyNoticeHold,
  currentNotices,
  MANIFEST_PATH,
  noticeHoldFor,
  parseManifest,
  publishableNotices,
} from "../publisher/notice-select";
import { PUBLISH_JOB_SLOT_KEY } from "./keys";
import { liveNotices, queryNotices, type NoticeRecord } from "./notices";
import type { RelatedWrite, Sender } from "./writes";

// 데이터 게시 현황 읽기 (#331, 화면 ADM-PUB, 아키텍처 18.4·결정 기록 D16-C2·C4·D20-2)
// 읽기만 함. 게시 판단을 다시 하지 않고 publisher가 남긴 기록·게시본을 그대로 옮김(G1)
// - 지금 앱에 보이는 게시본: 게시 버킷 manifest(공개 웹이 읽는 바로 그 파일)
// - 게시 기록: 게시 요약(성공) + 실패한 실행 기록. 변경이 없어 생략한 실행은 마지막 실행에만 남음(D16-C2)
// - 다음 자동 게시: 수집 일정(특보 15분·관측 30분)의 다음 시각. 게시는 수집을 마친 뒤 깨어남(아키텍처 6.2)
// - 대기 중인 공지: 다음 게시에 실릴 공지와 지금 게시본 공지의 차이(확정한 노출본만, 되돌림 반영)
// - 되돌림 상태인 공지: 되돌림 포인터(D20-2)
// 칸마다 따로 읽어, 읽지 못한 칸은 ok: false('확인 못 함')로 둠. 빈 목록·0으로 바꾸지 않음
// Ops 읽기 용량이 작아(5) 요약은 최근 HISTORY_LIMIT + 1건만, 필요한 칸만 읽음

export const HISTORY_LIMIT = 20;

export type Section<T> = ({ readonly ok: true } & T) | { readonly ok: false };

export interface PublishChanges {
  // 공지가 앞 게시와 다름. null: 요약값이 없어 모름
  readonly notices: boolean | null;
  // 분류별 해변 수와 앞 게시 대비 증감. null: 모름
  readonly categoryCounts: CategoryCounts | null;
  readonly categoryDelta: CategoryCounts | null;
  // 관측 지연 해변 수와 증감(증감 null: 앞 게시 요약이 없음)
  readonly delayedBeaches: number;
  readonly delayedDelta: number | null;
}

export interface HistoryItem {
  readonly checks?: PublishRunDetails["checks"];
  readonly operator?: string;
  // published: 이 버전이 게시됨 · failed: 시도한 버전(게시되지 않음, 앞 게시본 유지)
  readonly result: "published" | "failed";
  readonly version: string;
  readonly at: string; // 게시 시각(성공) · 실행 시작(실패), UTC ISO
  readonly source: PublishSource;
  readonly target?: string;
  readonly reason?: string;
  readonly jobId?: string;
  readonly beachCount?: number;
  // 성공한 게시만. null이면 앞 게시와 견줄 수 없음(첫 게시·앞 요약 빠짐·이전 형식)
  readonly changes?: PublishChanges | null;
  // 바로 앞 게시본의 요약이 빠짐(previous 사슬이 끊김) → 그 사이 게시를 확인 못 함
  readonly gapBefore?: boolean;
}

export interface RunView {
  readonly at: string;
  readonly source: PublishSource;
  readonly result: "published" | "unchanged" | "failed";
  readonly version: string;
  readonly reason?: string;
  readonly target?: string;
}

export interface PendingNotice {
  readonly id: string;
  readonly before?: Notice;
  readonly updatedBy?: string;
  // add: 새로 실림 · update: 바뀐 문구·시각으로 실림 · remove: 빠짐(끝남·노출 끝내기·되돌림)
  readonly change: "add" | "update" | "remove";
  readonly kind: string;
  readonly title: string; // 한국어 제목
  readonly startsAt: string;
  readonly endsAt: string | null;
}

export interface HeldNoticeView {
  readonly id: string;
  // 운영 DB 공지의 한국어 제목. 공지가 지워졌으면 되돌린 노출본의 제목, 둘 다 없으면 null
  readonly title: string | null;
  readonly target: string; // 되돌리기에서 고른 게시본
  readonly at: string; // 되돌린 시각
  // true: 그때 노출본으로 싣는 중 · false: 그때 없던 공지라 빼는 중
  readonly restoresLive: boolean;
}

export interface JobView extends Omit<PublishJob, "createdAtMs"> {
  // 대기·실행이 시간 제한을 넘김. 실패로 단정하지 않음(D16-C4). 화면 문구는 ADM-PUB(#331)에서 정함
  readonly overdue: boolean;
}

export interface PublishOverview {
  // 다음 게시에 쓰는 정책 설정값
  readonly settings: {
    readonly maintenance: {
      readonly active: boolean;
      readonly until: string | null;
    };
    readonly minWebBuild: number;
  };
  readonly last24h: Section<{
    readonly runs: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly skipped: number;
  }>;
  readonly current: Section<{
    // null: 아직 게시본이 없음(첫 게시 전)
    readonly version: string | null;
    readonly generatedAt: string | null;
    readonly maintenance?: ManifestFile["maintenance"];
    readonly minWebBuild?: number;
  }>;
  readonly history: Section<{ readonly items: readonly HistoryItem[] }>;
  readonly lastRun: Section<{ readonly run: RunView | null }>;
  readonly nextAuto: {
    readonly warnings: string; // 다음 특보 수집 시각(UTC ISO)
    readonly observations: string; // 다음 관측 수집 시각
  };
  readonly pendingNotices: Section<{
    readonly items: readonly PendingNotice[];
    // 저장소 점검 설정이 지금 게시본과 다름(다음 게시에 반영). null: 게시본이 없어 견줄 수 없음
    readonly maintenancePending: boolean | null;
  }>;
  readonly heldNotices: Section<{
    // 되돌림 포인터 version('다시 적용' 요청에 보냄). 포인터가 없으면 0
    readonly version: number;
    readonly items: readonly HeldNoticeView[];
  }>;
  // 마지막으로 만든 작업(끝난 작업 포함). 진행 중인지는 job.state·overdue로 봄
  readonly latestJob: Section<{ readonly job: JobView | null }>;
}

const SUMMARY_PROJECTION = {
  ProjectionExpression:
    "#v, #p, #at, #n, #d, #src, #tg, #cc, #nd, #job, #checks, #operator",
  ExpressionAttributeNames: {
    "#v": "version",
    "#p": "previous",
    "#at": "publishedAt",
    "#n": "beachCount",
    "#d": "delayedBeachIds",
    "#src": "source",
    "#tg": "target",
    "#cc": "categoryCounts",
    "#nd": "noticeDigest",
    "#job": "jobId",
    "#checks": "checks",
    "#operator": "operatorSub",
  },
} as const;

const SOURCES: readonly PublishSource[] = [
  "auto",
  "operator",
  "rollback",
  "republish",
];

interface SummaryRow extends PublishRunDetails {
  readonly version: string;
  readonly previous: string | null;
  readonly publishedAt: string;
  readonly beachCount: number;
  readonly delayed: number;
  readonly source: PublishSource;
  readonly target?: string;
  readonly categoryCounts: CategoryCounts | null;
  readonly noticeDigest: string | null;
  readonly jobId?: string;
}

function toCounts(value: unknown): CategoryCounts | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    !PUBLISH_CATEGORIES.every(
      (c) => Number.isSafeInteger(record[c]) && (record[c] as number) >= 0,
    )
  ) {
    return null;
  }
  return {
    clear: record.clear as number,
    unavailable: record.unavailable as number,
    undetermined: record.undetermined as number,
  };
}

function runDetails(item: Record<string, unknown>): PublishRunDetails {
  const raw = item.checks;
  const fields = ["format", "required", "beachIds"] as const;
  const checks =
    raw && typeof raw === "object"
      ? Object.fromEntries(
          fields.flatMap((field) => {
            const value = (raw as Record<string, unknown>)[field];
            return typeof value === "boolean" ? [[field, value]] : [];
          }),
        )
      : {};
  return {
    ...(Object.keys(checks).length ? { checks } : {}),
    ...(typeof item.operatorSub === "string" && item.source === "operator"
      ? { operatorSub: item.operatorSub }
      : {}),
  };
}

// 모양이 틀린 요약은 던짐 → 게시 기록 칸 전체가 '확인 못 함'(틀린 기록을 조용히 빼지 않음)
function toSummaryRow(item: Record<string, unknown>): SummaryRow {
  const {
    version,
    previous,
    publishedAt,
    beachCount,
    delayedBeachIds,
    source,
    target,
    categoryCounts,
    noticeDigest,
    jobId,
  } = item;
  if (
    typeof version !== "string" ||
    !(previous === null || typeof previous === "string") ||
    typeof publishedAt !== "string" ||
    typeof beachCount !== "number" ||
    !Array.isArray(delayedBeachIds) ||
    !(source === undefined || SOURCES.includes(source as PublishSource)) ||
    !(target === undefined || typeof target === "string") ||
    !(jobId === undefined || typeof jobId === "string")
  ) {
    throw new Error("게시 요약 모양이 틀림");
  }
  return {
    ...runDetails(item),
    version,
    previous,
    publishedAt,
    beachCount,
    delayed: delayedBeachIds.length,
    // 이 칸이 생기기 전 요약은 자동 게시만 있었음(publish-summary.ts)
    source: (source as PublishSource | undefined) ?? "auto",
    ...(target !== undefined ? { target: target as string } : {}),
    categoryCounts: toCounts(categoryCounts),
    noticeDigest: typeof noticeDigest === "string" ? noticeDigest : null,
    ...(jobId !== undefined ? { jobId: jobId as string } : {}),
  };
}

function toRunView(item: Record<string, unknown>): RunView {
  const { at, source, result, version, reason, target } = item;
  if (
    typeof at !== "string" ||
    !SOURCES.includes(source as PublishSource) ||
    !["published", "unchanged", "failed"].includes(result as string) ||
    typeof version !== "string" ||
    !(reason === undefined || typeof reason === "string") ||
    !(target === undefined || typeof target === "string")
  ) {
    throw new Error("게시 실행 기록 모양이 틀림");
  }
  return {
    at,
    source: source as PublishSource,
    result: result as RunView["result"],
    version,
    ...(reason !== undefined ? { reason: reason as string } : {}),
    ...(target !== undefined ? { target: target as string } : {}),
  };
}

function changesOf(row: SummaryRow, prev: SummaryRow | undefined) {
  if (prev === undefined) return null;
  const delta =
    row.categoryCounts && prev.categoryCounts
      ? {
          clear: row.categoryCounts.clear - prev.categoryCounts.clear,
          unavailable:
            row.categoryCounts.unavailable - prev.categoryCounts.unavailable,
          undetermined:
            row.categoryCounts.undetermined - prev.categoryCounts.undetermined,
        }
      : null;
  return {
    notices:
      row.noticeDigest !== null && prev.noticeDigest !== null
        ? row.noticeDigest !== prev.noticeDigest
        : null,
    categoryCounts: row.categoryCounts,
    categoryDelta: delta,
    delayedBeaches: row.delayed,
    delayedDelta: row.delayed - prev.delayed,
  };
}

// 성공(요약)과 실패(실행 기록)를 버전 순(최근 먼저)으로 합침
// summaries는 최근 HISTORY_LIMIT + 1건(한 건 더 읽어 목록 끝 게시도 앞 게시와 견줌). 합친 뒤 HISTORY_LIMIT건만 돌려줌
export function buildHistory(
  summaries: readonly SummaryRow[],
  failedRuns: readonly (RunView & PublishRunDetails & { jobId?: string })[],
): HistoryItem[] {
  const byVersion = new Map(summaries.map((row) => [row.version, row]));
  const oldest = summaries.at(-1)?.version;
  const published: HistoryItem[] = summaries.map((row) => {
    const prev =
      row.previous === null ? undefined : byVersion.get(row.previous);
    return {
      result: "published",
      version: row.version,
      at: row.publishedAt,
      source: row.source,
      ...(row.target !== undefined ? { target: row.target } : {}),
      ...(row.jobId !== undefined ? { jobId: row.jobId } : {}),
      beachCount: row.beachCount,
      changes: changesOf(row, prev),
      ...(row.checks ? { checks: row.checks } : {}),
      // 앞 요약이 목록 범위 안(가장 오래된 것보다 새로움)인데 없으면 빠진 것
      gapBefore:
        row.previous !== null &&
        prev === undefined &&
        oldest !== undefined &&
        row.previous > oldest,
    };
  });
  const failed: HistoryItem[] = failedRuns.map((run) => ({
    result: "failed",
    version: run.version,
    at: run.at,
    source: run.source,
    ...(run.target !== undefined ? { target: run.target } : {}),
    ...(run.reason !== undefined ? { reason: run.reason } : {}),
    ...(run.checks ? { checks: run.checks } : {}),
    ...(run.jobId !== undefined ? { jobId: run.jobId } : {}),
  }));
  return [...published, ...failed]
    .sort((a, b) =>
      a.version < b.version ? 1 : a.version > b.version ? -1 : 0,
    )
    .slice(0, HISTORY_LIMIT);
}

// 다음 게시에 실릴 공지와 지금 게시본 공지의 차이. publisher와 같은 함수로 계산함(다시 판단하지 않음)
export function pendingNoticesOf(
  records: readonly NoticeRecord[],
  hold: NoticeHold | null,
  published: readonly Notice[],
  nowMs: number,
): PendingNotice[] {
  const next = publishableNotices(
    applyNoticeHold(liveNotices(records), hold),
    nowMs,
    () => undefined,
  );
  const nextById = new Map(next.map((n) => [n.id, n]));
  const nowById = new Map(published.map((n) => [n.id, n]));
  const view = (n: Notice, change: PendingNotice["change"]): PendingNotice => ({
    id: n.id,
    change,
    kind: n.kind,
    title: n.title.ko,
    startsAt: n.startsAt,
    endsAt: n.endsAt,
  });
  const items: PendingNotice[] = [];
  for (const notice of next) {
    const was = nowById.get(notice.id);
    if (!was) items.push(view(notice, "add"));
    else if (canonical(was) !== canonical(notice)) {
      items.push({ ...view(notice, "update"), before: was });
    }
  }
  for (const notice of published) {
    if (!nextById.has(notice.id)) items.push(view(notice, "remove"));
  }
  return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function heldNoticesOf(
  hold: NoticeHold | null,
  records: readonly NoticeRecord[],
): HeldNoticeView[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  return Object.entries(hold?.notices ?? {})
    .map(([id, entry]) => {
      const record = byId.get(id);
      return {
        id,
        // 빈 제목(대기본은 비워 저장할 수 있음)도 다음 후보로 넘김
        title:
          [
            record && record.deletedAt === null ? record.draft.title.ko : "",
            entry.live?.title.ko ?? "",
          ]
            .map((t) => t.trim())
            .find((t) => t !== "") ?? null,
        target: entry.target,
        at: entry.at,
        restoresLive: entry.live !== null,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function jobViewOf(job: PublishJob, nowMs: number): JobView {
  const { createdAtMs, ...rest } = job;
  const overdue =
    (job.state === "pending" &&
      nowMs >= createdAtMs + PUBLISH_JOB_START_LIMIT_MS) ||
    (job.state === "running" &&
      nowMs >=
        Date.parse(job.startedAt ?? job.createdAt) + PUBLISH_JOB_RUN_LIMIT_MS);
  return { ...rest, overdue };
}

// 수집 일정의 다음 시각. 자동 게시는 수집을 마친 뒤 깨어나므로 실제 게시는 이보다 조금 뒤(아키텍처 6.2)
export function nextAutoOf(nowMs: number): PublishOverview["nextAuto"] {
  const next = (schedule: { periodMinutes: number; offsetMinutes: number }) =>
    new Date(nextSlot(nowMs, schedule)).toISOString();
  return {
    warnings: next(COLLECT_POLICY.warningsSchedule),
    observations: next(COLLECT_POLICY.oceanSchedule),
  };
}

async function section<T>(read: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, ...(await read()) };
  } catch {
    return { ok: false };
  }
}

// range: 기본은 최근 순 전체. from·forward를 주면 그 버전부터 오래된 순(작업 결과 찾기)
export async function readSummaries(
  client: Sender,
  opsTable: string,
  limit: number,
  range: { from?: string; forward?: boolean } = {},
): Promise<SummaryRow[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: opsTable,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ...SUMMARY_PROJECTION,
      // 게시 버전(20261017T053000Z 모양)만. 숫자로 시작하는 범위
      ExpressionAttributeValues: {
        ":pk": PUBLISH_SUMMARY_PK,
        ":from": range.from ?? "0",
        ":to": "9~",
      },
      ScanIndexForward: range.forward ?? false,
      Limit: limit,
    }),
  );
  return ((result.Items ?? []) as Record<string, unknown>[]).map(toSummaryRow);
}

// 실패한 실행 기록(버전별). 마지막 실행(sk "last")은 범위 밖
export async function readFailedRuns(
  client: Sender,
  opsTable: string,
  limit: number,
  range: { from?: string; forward?: boolean } = {},
): Promise<(RunView & PublishRunDetails & { jobId?: string })[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: opsTable,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": PUBLISH_RUN_PK,
        ":from": range.from ?? "0",
        ":to": "9~",
      },
      ScanIndexForward: range.forward ?? false,
      Limit: limit,
    }),
  );
  return ((result.Items ?? []) as Record<string, unknown>[]).map((item) => ({
    ...toRunView(item),
    ...runDetails(item),
    ...(typeof item.jobId === "string" ? { jobId: item.jobId } : {}),
  }));
}

export async function readLastRun(
  client: Sender,
  opsTable: string,
): Promise<(RunView & { jobId?: string }) | null> {
  const result = await client.send(
    new GetCommand({
      TableName: opsTable,
      Key: { pk: PUBLISH_RUN_PK, sk: PUBLISH_RUN_LAST_SK },
    }),
  );
  if (!result.Item) return null;
  return {
    ...toRunView(result.Item),
    ...(typeof result.Item.jobId === "string"
      ? { jobId: result.Item.jobId }
      : {}),
  };
}

export async function readNoticeHold(
  client: Sender,
  opsTable: string,
): Promise<NoticeHold | null> {
  const result = await client.send(
    new GetCommand({
      TableName: opsTable,
      Key: NOTICE_HOLD_KEY,
      ConsistentRead: true,
    }),
  );
  return result.Item ? toNoticeHold(result.Item) : null;
}

// 작업 기록. 없으면 null, 모양이 틀리면 던짐
export async function readJob(
  client: Sender,
  opsTable: string,
  jobId: string,
): Promise<PublishJob | null> {
  const result = await client.send(
    new GetCommand({
      TableName: opsTable,
      Key: publishJobKey(jobId),
      ConsistentRead: true,
    }),
  );
  if (!result.Item) return null;
  const job = toPublishJob(result.Item);
  if (!job) throw new Error("게시 작업 모양이 틀림");
  return job;
}

// 지금 작업 자리(admin#publish / job): 마지막으로 만든 작업 ID와 version
export async function readJobSlot(
  client: Sender,
  opsTable: string,
): Promise<{ jobId: string; version: number } | null> {
  const result = await client.send(
    new GetCommand({
      TableName: opsTable,
      Key: PUBLISH_JOB_SLOT_KEY,
      ConsistentRead: true,
    }),
  );
  const item = result.Item;
  if (!item) return null;
  if (typeof item.jobId !== "string" || typeof item.version !== "number") {
    throw new Error("게시 작업 자리 모양이 틀림");
  }
  return { jobId: item.jobId, version: item.version };
}

async function readManifest(
  snapshots: SnapshotStore | null,
): Promise<ManifestFile | null> {
  if (!snapshots) throw new Error("게시 버킷 없음");
  const body = await snapshots.getFile(MANIFEST_PATH);
  if (body === null) return null;
  const manifest = parseManifest(body);
  // 계약에 맞지 않는 manifest는 '없음'이 아니라 '확인 못 함'
  if (manifest === null) throw new Error("manifest 모양이 틀림");
  return manifest;
}

// 대기 게시본을 실제로 확정·끝내거나 지운 작업의 수정자만 씀
function pendingActor(
  item: PendingNotice,
  record: NoticeRecord | undefined,
  held: boolean,
): string | undefined {
  if (!record || held) return undefined;
  if (record.liveUpdatedBySub) return record.liveUpdatedBySub;
  // 노출 변경자를 따로 남기기 전 기록에만 적용함
  const liveEdited =
    record.updatedAt === record.exposedAt ||
    record.updatedAt === record.live?.endsAt;
  if (item.change === "remove") {
    if (record.updatedAt === record.deletedAt || liveEdited)
      return record.updatedBySub;
    return undefined;
  }
  return liveEdited ? record.updatedBySub : undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RUN_PAGES = 4;

// 새 실행 기록이 24시간 경계에 닿기 전에는 옛 건너뜀을 셀 수 없음
export async function readPublishLast24h(
  client: Sender,
  opsTable: string,
  now: Date,
) {
  const from = new Date(now.getTime() - DAY_MS).toISOString();
  const to = now.toISOString();
  const query = (start: string, end: string) => ({
    TableName: opsTable,
    KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
    ExpressionAttributeValues: {
      ":pk": PUBLISH_RUN_PK,
      ":from": PUBLISH_RUN_HISTORY_PREFIX + start,
      ":to": PUBLISH_RUN_HISTORY_PREFIX + end,
    },
    ConsistentRead: true,
  });
  // 잠금 획득과 함께 증가한 번호를 결과와 대조함. 실행이 죽거나 기록 쓰기에 실패해도 번호는 남음
  const readHead = () =>
    client.send(
      new GetCommand({
        TableName: opsTable,
        Key: lockKey(PUBLISH_POLICY.lockName),
        ConsistentRead: true,
      }),
    );
  const head = await readHead();
  const sequence = head.Item?.sequence;
  if (
    typeof sequence !== "number" ||
    !Number.isSafeInteger(sequence) ||
    typeof head.Item?.startedAtMs !== "number" ||
    head.Item.startedAtMs > now.getTime()
  ) {
    throw new Error("게시 실행 순번 확인 못 함");
  }
  const baseline = await client.send(
    new QueryCommand({
      ...query("", from),
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const previous = baseline.Items?.[0]?.sequence;
  if (
    typeof previous !== "number" ||
    !Number.isSafeInteger(previous) ||
    previous > sequence
  ) {
    throw new Error("24시간 실행 기록 없음");
  }
  let expected = previous + 1;
  const counts = { runs: 0, succeeded: 0, failed: 0, skipped: 0 };
  let startKey: Record<string, unknown> | undefined;
  for (let page = 0; page < MAX_RUN_PAGES; page += 1) {
    const result = await client.send(
      new QueryCommand({
        ...query(from, to),
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of result.Items ?? []) {
      if (
        typeof item.at !== "string" ||
        item.at < from ||
        item.at > to ||
        item.sk !== PUBLISH_RUN_HISTORY_PREFIX + item.at
      ) {
        throw new Error("게시 실행 시각 모양이 틀림");
      }
      if (item.at === from) continue;
      if (item.sequence !== expected || expected > sequence) {
        throw new Error("게시 실행 집계 순번 누락");
      }
      expected += 1;
      if (item.result === "published") counts.succeeded += 1;
      else if (item.result === "failed") counts.failed += 1;
      else if (item.result === "unchanged") counts.skipped += 1;
      else throw new Error("게시 실행 결과 모양이 틀림");
      counts.runs += 1;
    }
    startKey = result.LastEvaluatedKey;
    if (!startKey) {
      if (expected !== sequence + 1)
        throw new Error("게시 실행 집계 순번 누락");
      if ((await readHead()).Item?.sequence !== sequence)
        throw new Error("게시 실행 조회 중 순번 변경");
      return counts;
    }
  }
  throw new Error("게시 실행 기록 조회 상한");
}

export async function readPublishOverview(
  client: Sender,
  opsTable: string,
  snapshots: SnapshotStore | null,
  now: Date,
  actorEmails?: OperatorEmailLookup | null,
): Promise<PublishOverview> {
  const nowMs = now.getTime();
  // 실패해도 다른 칸은 보여 줌. 공지·포인터·manifest는 두 칸이 같이 씀
  const settle = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    );
  const [manifest, records, hold, history, lastRun, latestJob] =
    await Promise.all([
      settle(readManifest(snapshots)),
      settle(queryNotices(client, opsTable)),
      settle(readNoticeHold(client, opsTable)),
      section(async () => {
        const [summaries, failed] = await Promise.all([
          readSummaries(client, opsTable, HISTORY_LIMIT + 1),
          readFailedRuns(client, opsTable, HISTORY_LIMIT),
        ]);
        const actors = new Map(
          [...summaries, ...failed].flatMap((row) =>
            row.jobId && row.operatorSub ? [[row.jobId, row.operatorSub]] : [],
          ),
        );
        return { items: buildHistory(summaries, failed), actors };
      }),
      section(async () => {
        const run = await readLastRun(client, opsTable);
        if (run === null) return { run: null };
        const { jobId: _jobId, ...view } = run;
        return { run: view };
      }),
      section(async () => {
        const slot = await readJobSlot(client, opsTable);
        const job = slot ? await readJob(client, opsTable, slot.jobId) : null;
        return { job: job ? jobViewOf(job, nowMs) : null };
      }),
    ]);
  const pending =
    manifest.ok && records.ok && hold.ok
      ? pendingNoticesOf(
          records.value,
          hold.value,
          manifest.value?.notices ?? [],
          nowMs,
        )
      : null;
  const noticesById = new Map(
    records.ok ? records.value.map((record) => [record.id, record]) : [],
  );
  const noticeActors = new Map(
    (pending ?? []).flatMap((item) => {
      const sub = pendingActor(
        item,
        noticesById.get(item.id),
        hold.ok && Object.hasOwn(hold.value?.notices ?? {}, item.id),
      );
      return sub ? [[item.id, sub]] : [];
    }),
  );
  const [last24h, emails] = await Promise.all([
    section(() => readPublishLast24h(client, opsTable, now)),
    lookupActorEmails(
      [
        ...(history.ok ? history.actors.values() : []),
        ...noticeActors.values(),
      ],
      actorEmails,
    ),
  ]);
  return {
    current: manifest.ok
      ? {
          ok: true,
          version: manifest.value?.snapshotVersion ?? null,
          generatedAt: manifest.value?.generatedAt ?? null,
          ...(manifest.value
            ? {
                maintenance: manifest.value.maintenance,
                minWebBuild: manifest.value.minWebBuild,
              }
            : {}),
        }
      : { ok: false },
    settings: {
      maintenance: MANIFEST_SETTINGS.maintenance,
      minWebBuild: MANIFEST_SETTINGS.minWebBuild,
    },
    last24h,
    history: history.ok
      ? {
          ok: true,
          items: history.items.map((item) => {
            const sub = item.jobId ? history.actors.get(item.jobId) : undefined;
            const operator = sub ? emails.get(sub) : undefined;
            return operator ? { ...item, operator } : item;
          }),
        }
      : history,
    lastRun,
    nextAuto: nextAutoOf(nowMs),
    pendingNotices:
      manifest.ok && pending
        ? {
            ok: true,
            items: pending.map((item) => {
              const sub = noticeActors.get(item.id);
              const updatedBy = sub ? emails.get(sub) : undefined;
              return updatedBy ? { ...item, updatedBy } : item;
            }),
            maintenancePending: manifest.value
              ? canonical(manifest.value.maintenance) !==
                canonical(MANIFEST_SETTINGS.maintenance)
              : null,
          }
        : { ok: false },
    heldNotices:
      records.ok && hold.ok
        ? {
            ok: true,
            version: hold.value?.version ?? 0,
            items: heldNoticesOf(hold.value, records.value),
          }
        : { ok: false },
    latestJob,
  };
}

// 공지를 되돌림 포인터에서 뺄 관련 쓰기. 그 공지가 되돌림 상태가 아니면 빈 목록
// 되돌린 공지를 운영자가 다시 노출·노출 끝내기 하면 그 공지의 되돌림도 풂(사용자 결정 2026-11-12)
export async function holdReleaseFor(
  client: Sender,
  opsTable: string,
  noticeId: string,
): Promise<RelatedWrite[]> {
  const hold = await readNoticeHold(client, opsTable);
  if (!hold || !Object.hasOwn(hold.notices, noticeId)) return [];
  const rest = Object.fromEntries(
    Object.entries(hold.notices).filter(([id]) => id !== noticeId),
  );
  return [
    {
      kind: "update",
      key: NOTICE_HOLD_KEY,
      expectedVersion: hold.version,
      set: { notices: rest },
    },
  ];
}

// 되돌리기 미리보기(#331, 확인 창 V30 '그 뒤 운영 변경 N건'). 읽기만 함
// publisher 되돌리기와 같은 계산: 고른 게시본 때 공지 상태와 지금 운영 DB 노출본을 공지별로 견줌(D20-2)
// - restore: 그때 문구·시각으로 돌아감 · remove: 그때 없던(또는 끝난) 공지라 빠짐 · revive: 지금은 없는 공지가 그때 문구로 다시 실림
// - available false: 그 게시본의 공지 기록이 없음(되돌리면 rollback_target_missing으로 끝남)
// 실제 되돌리기 때 시각으로 다시 계산하므로 미리보기와 결과가 다를 수 있음(그사이 공지가 바뀌거나 끝남)
export interface RollbackPreviewItem {
  readonly id: string;
  readonly change: "restore" | "remove" | "revive";
  readonly title: string | null; // 한국어 제목(지금 문구, 없으면 그때 문구)
}

export type RollbackPreview =
  | { readonly available: false; readonly version: string }
  | {
      readonly available: true;
      readonly version: string;
      readonly items: readonly RollbackPreviewItem[];
    };

export async function readRollbackPreview(
  client: Sender,
  opsTable: string,
  version: string,
  now: Date,
): Promise<RollbackPreview> {
  const nowMs = now.getTime();
  const [target, records] = await Promise.all([
    new DynamoOpsStore(client, opsTable).getPublishNotices(version),
    queryNotices(client, opsTable),
  ]);
  if (target === null) return { available: false, version };
  const noop = () => undefined;
  const then = currentNotices(target, nowMs, noop);
  const live = currentNotices(liveNotices(records), nowMs, noop);
  const liveById = new Map(live.map((n) => [n.id, n]));
  const held = noticeHoldFor(then, live, version, now.toISOString());
  const items = Object.entries(held).map(([id, entry]) => {
    const current = liveById.get(id) ?? null;
    const title = (current?.title.ko ?? entry.live?.title.ko ?? "").trim();
    return {
      id,
      change:
        entry.live === null
          ? "remove"
          : current === null
            ? "revive"
            : "restore",
      title: title === "" ? null : title,
    } satisfies RollbackPreviewItem;
  });
  return { available: true, version, items };
}
