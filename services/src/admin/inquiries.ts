import { listAudit, parseAuditQuery } from "./audit";
import { GetCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  INQUIRY_STATUSES,
  INQUIRY_STATUS_INDEX_NAME,
  isInquiryStatus,
  type InquiryStatus,
} from "../inquiry/policy";
import { safeLog } from "./http";
import {
  matchesInquiryBeach,
  matchesInquiryMessage,
  matchesInquiryMetadata,
  withInquiryPreview,
  type InquiryFilters,
} from "./inquiry-list";
import type { OperatorRole } from "./policy";
import type { Sender } from "./writes";

// 운영자 화면 문의 (BRD-153, 결정 기록 D16-B4·D5·D6·D7, 화면 설계서 6장 ADM-INQ)
// - 목록: 상태 + 접수 시각 GSI(요약만 projection). 접수 먼저, 같은 상태 안에서는 최근 접수 순
//   상태를 고르지 않으면 4개 상태를 이 순서로 이어 붙여 한 목록으로 보여 줌(구현 제안 I08)
// - 모르는 처리 상태(4종 밖)는 원래 값 그대로 내려 줌(아키텍처 18.3, #521). 상태 변경·필터는 4종만 받음
//   GSI 파티션이 상태라 4종 Query로는 안 잡힘 → 첫 쪽에서 GSI를 4종 밖만 걸러 Scan 한 번으로 읽어
//   '전체' 목록 맨 위(마지막 쪽까지 넘겨야 보이면 사실상 숨김)와 수(counts.unknown)에 함께 씀. 4개 탭 수에는 넣지 않음
// - 보관 기한(ttl)이 지난 문의는 TTL로 지워지기 전이라도 목록·상세·수정에서 뺌(구현 제안 I07)
// - GSI는 최종적 일관성이라 저장 직후 목록이 잠시 이전 값일 수 있음. 상세는 강한 일관성으로 읽음
// - 보기 권한은 본문·메모·반려 이유를 받지 않음(민감 필드 제한, 캔버스 S1 권한표)
// - 판단 상태는 여기서도 바꾸지 않음(G1)

export const INQUIRY_PAGE_DEFAULT = 20;
export const INQUIRY_PAGE_MAX = 50;
// 반려 이유·내부 메모 길이 상한(글자). 화면 입력 상한과 같게 맞춤(BRD-148 화면에서 확인)
export const REJECT_REASON_MAX = 500;
export const MEMO_MAX = 2000;
// 개인정보 가리기: 한 번에 가릴 수 있는 부분 수와 가린 자리에 넣는 표시(화면 설계서 6장 ADM-INQ)
export const REDACTION_MAX = 20;
export const REDACTION_MARK = "[가림]";

// 목록 항목의 version은 GSI(최종적 일관성) 값이라 저장 직후 이전 값일 수 있음
// 처리(PATCH)에는 상세(강한 일관성)에서 받은 version을 씀
export interface InquirySummary {
  readonly inquiryId: string;
  readonly type: string;
  readonly beachId?: string;
  readonly activity?: string;
  readonly messagePreview?: string;
  readonly messagePreviewUnavailableReason?: "restricted" | "empty";
  readonly receivedAt: string;
  // 4종(InquiryStatus) 또는 모르는 원래 값(4종으로 바꾸거나 숨기지 않음, #521)
  readonly status: string;
  readonly version: number;
  // 상태 기록 전에 들어온 문의(이전 도구가 '접수'로 채움) → 화면 '이전 문의·처리 이력 없음'
  readonly legacy: boolean;
}

export interface InquiryDetail extends InquirySummary {
  // 보기 권한이면 본문·메모·반려 이유를 빼고 restricted: true
  readonly restricted: boolean;
  readonly message?: string;
  readonly memo?: string | null;
  readonly rejectReason?: string | null;
  readonly updatedAt?: string;
  // 출시에는 이메일·사진을 받지 않음(D13-1). 화면은 '받지 않아요'로 고정 표시
  readonly emailCollected: false;
  readonly photosCollected: false;
}

export type InquiryCounts = Readonly<Record<InquiryStatus, number>> & {
  // 4종 밖 상태 수(#521, 모르는 상태 목록 길이와 같음). 4개 탭 수에는 넣지 않고 '전체' 수와 목록 위 안내에만 씀
  // null은 확인 못 함(Scan 실패)
  readonly unknown?: number | null;
  readonly receivedLast7d?: number | null;
  readonly resolvedLast7d?: number | null;
  readonly oldestUnprocessedAt?: string | null;
};

export interface InquiryPage {
  readonly items: readonly InquirySummary[];
  readonly nextCursor: string | null;
  // 첫 쪽(cursor 없음)에만 실음: 상태 탭의 문의 수(보관 기한이 지난 문의 제외)
  readonly counts?: InquiryCounts;
  // 첫 쪽에서 모르는 처리 상태 문의를 읽지 못함(#521). 목록·4종 수는 그대로이고 화면이 '확인 못 함'을 알림
  readonly unknownStatusUnavailable?: true;
}

type Raw = Record<string, unknown>;

function alive(item: Raw, nowSec: number): boolean {
  return typeof item.ttl === "number" && item.ttl > nowSec;
}

// 로그에 남기는 모르는 상태 값 길이 상한(손으로 고친 값이 길어도 로그 한 줄을 키우지 않게)
const UNKNOWN_STATUS_LOG_MAX = 40;

// 저장된 모양이 틀리면 목록에서 조용히 빼지 않고 던짐(500) → 데이터 문제를 숨기지 않음
// 상태는 빈 값이 아닌 글자면 받음. 4종 밖이면 원래 값 그대로 내려 주고 warn 로그를 남김
// (500이 나지 않아 5xx 경보에 잡히지 않으므로 로그로 찾음. 새 경보는 두지 않음, #521)
function toSummary(item: Raw): InquirySummary {
  if (
    typeof item.inquiryId !== "string" ||
    typeof item.inquiryType !== "string" ||
    typeof item.receivedAt !== "string" ||
    typeof item.inquiryStatus !== "string" ||
    item.inquiryStatus === "" ||
    typeof item.version !== "number"
  ) {
    throw new Error("문의 항목 모양이 틀림");
  }
  if (!isInquiryStatus(item.inquiryStatus)) {
    safeLog("warn", "ops_inquiry_unknown_status", {
      inquiryId: item.inquiryId,
      status: item.inquiryStatus.slice(0, UNKNOWN_STATUS_LOG_MAX),
    });
  }
  return {
    inquiryId: item.inquiryId,
    type: item.inquiryType,
    ...(typeof item.beachId === "string" ? { beachId: item.beachId } : {}),
    ...(typeof item.activity === "string" ? { activity: item.activity } : {}),
    receivedAt: item.receivedAt,
    status: item.inquiryStatus,
    version: item.version,
    legacy: item.legacy === true,
  };
}

// 불투명 cursor: { s: 상태, k: GSI LastEvaluatedKey }를 base64url JSON으로 감쌈
interface CursorState {
  readonly s: InquiryStatus;
  readonly k?: Record<string, string>;
  readonly f?: string;
}

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

export function decodeCursor(cursor: string): CursorState | null {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const { s, k, f } = value as { s?: unknown; k?: unknown; f?: unknown };
    if (
      !isInquiryStatus(s) ||
      (f !== undefined && (typeof f !== "string" || !/^[a-f0-9]{64}$/.test(f)))
    ) {
      return null;
    }
    const state = { s, ...(f === undefined ? {} : { f }) };
    if (k === undefined) return state;
    if (
      typeof k !== "object" ||
      k === null ||
      !Object.values(k).every((v) => typeof v === "string") ||
      !["pk", "inquiryStatus", "receivedAt"].every(
        (name) => typeof (k as Raw)[name] === "string",
      ) ||
      (k as Raw).inquiryStatus !== s
    ) {
      return null;
    }
    return { ...state, k: k as Record<string, string> };
  } catch {
    return null;
  }
}

export interface ListQuery {
  // 없으면 4개 상태 전체
  readonly status?: InquiryStatus;
  readonly cursor?: CursorState;
  readonly limit: number;
}

// 시간 상한이 있는 읽기(운영 홈 지표·모르는 상태 문의, #521)
// 상한이 지나면 요청을 끊고, 이 sender로 보낸 요청은 응답을 기다리지 않고 TimeoutError로 실패함
// (SDK가 끊김 신호를 늦게 받아도 기다리지 않게 경주시킴). 다 쓰면 done()으로 타이머를 정리함
interface BoundedReads {
  readonly sender: Sender;
  readonly signal: AbortSignal;
  readonly done: () => void;
}

function boundedReads(client: Sender, timeoutMs: number): BoundedReads {
  const controller = new AbortController();
  const timedOut = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason),
      { once: true },
    );
  });
  // 기다리는 요청이 없을 때 처리 안 된 거부로 남지 않게 함
  timedOut.catch(() => {});
  const timer = setTimeout(() => {
    const error = new Error("시간 상한 초과");
    error.name = "TimeoutError";
    controller.abort(error);
  }, timeoutMs);
  return {
    sender: {
      send: ((command: QueryCommand) => {
        controller.signal.throwIfAborted();
        return Promise.race([
          client.send(command, { abortSignal: controller.signal }),
          timedOut,
        ]);
      }) as Sender["send"],
    },
    signal: controller.signal,
    done: () => clearTimeout(timer),
  };
}

// 4종 밖 상태 문의(#521). 첫 쪽에서 한 번 읽어 '전체' 목록 맨 위와 수(unknown = items 길이)에 함께 씀
// ok: false는 읽지 못함(권한·쓰로틀 등) → 목록·4종 수는 그대로 내려 주고 '확인 못 함'만 알림
export type UnknownStatuses =
  | { readonly ok: true; readonly items: readonly InquirySummary[] }
  | { readonly ok: false };

// 모르는 상태 Scan 시간 상한. 넘으면 '확인 못 함'으로 두고 목록·4종 수는 기다리지 않음(운영 홈 지표와 같은 1.5초)
export const UNKNOWN_STATUS_TIMEOUT_MS = 1_500;

// 상태 GSI를 4종 밖·보관 기한 안만 걸러 Scan으로 끝까지 읽음(#521). GSI에는 상태가 있는 문의만 들어 있음
// - GSI 파티션이 상태라 4종 Query로는 안 잡힘. 걸러 읽기라 쪽마다 0건일 수 있어 LastEvaluatedKey가 있으면 이어 읽음
// - Limit을 두지 않아 한 번에 1MB까지 읽음(작은 Limit으로 여러 번 부르면 왕복마다 읽기 용량이 듦)
// - 읽기 실패·시간 초과는 던지지 않고 warn 로그 + ok: false. 저장된 모양이 틀린 문의는 지금처럼 던짐(데이터 문제를 숨기지 않음)
export async function readUnknownStatuses(
  client: Sender,
  tableName: string,
  now: Date,
  timeoutMs = UNKNOWN_STATUS_TIMEOUT_MS,
): Promise<UnknownStatuses> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const raws: Raw[] = [];
  const reads = boundedReads(client, timeoutMs);
  try {
    let key: Record<string, unknown> | undefined;
    do {
      const result = await reads.sender.send(
        new ScanCommand({
          TableName: tableName,
          IndexName: INQUIRY_STATUS_INDEX_NAME,
          FilterExpression:
            `NOT (#s IN (${INQUIRY_STATUSES.map((_, i) => `:k${i}`).join(", ")}))` +
            " AND #t > :now",
          ExpressionAttributeNames: { "#s": "inquiryStatus", "#t": "ttl" },
          ExpressionAttributeValues: {
            ...Object.fromEntries(
              INQUIRY_STATUSES.map((s, i) => [`:k${i}`, s]),
            ),
            ":now": nowSec,
          },
          ...(key ? { ExclusiveStartKey: key } : {}),
        }),
      );
      raws.push(...((result.Items ?? []) as Raw[]));
      key = result.LastEvaluatedKey;
    } while (key);
  } catch (error) {
    safeLog("warn", "ops_inquiry_unknown_status_unavailable", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return { ok: false };
  } finally {
    reads.done();
  }
  // 최근 접수 먼저(Scan은 접수 순서를 지키지 않음)
  const items = raws
    .filter((raw) => alive(raw, nowSec))
    .map(toSummary)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return { ok: true, items };
}

// 상태 GSI의 요약 후보 8개 또는 본문이 필요한 후보 4개를 한 쪽에서 조회함.
// 찾은 행이 적어도 다음 cursor에서 이어 읽음. GSI는 1 RCU이며 기존 목록과 공유함.
const FILTER_PAGE_MAX = 8;
const BODY_PAGE_MAX = 4;

// unknown: 상태를 고르지 않은 첫 쪽(cursor 없음)이면 4종 밖 상태 문의 전부를 같은 조건으로 걸러 맨 앞에 붙이고(#521)
// 이어서 '접수' 첫 묶음을 지금처럼 읽음(모르는 상태만 담은 빈 쪽을 따로 돌려주지 않음)
export async function listFilteredInquiries(
  client: Sender,
  tableName: string,
  query: ListQuery,
  filters: InquiryFilters,
  scope: string,
  role: OperatorRole,
  now: Date,
  beachSearch = matchesInquiryBeach,
  unknown?: UnknownStatuses,
): Promise<InquiryPage> {
  const status = query.status ?? query.cursor?.s ?? INQUIRY_STATUSES[0];
  const { from, to, q, preview } = filters;
  const readBody = role !== "viewer" && (q !== undefined || preview === true);
  const nowSec = Math.floor(now.getTime() / 1000);
  const items: InquirySummary[] = [];
  // 거르기·본문 검색. 모르는 상태 문의는 보통 0건이라 개수를 묶지 않음(묶으면 검색에서 빠져 숨겨짐)
  const pick = async (candidates: readonly InquirySummary[]) => {
    for (const item of candidates) {
      if (!matchesInquiryMetadata(item, filters)) continue;
      const beachMatch =
        q !== undefined &&
        item.beachId !== undefined &&
        beachSearch(item.beachId, q);
      if (q !== undefined && !beachMatch && !readBody) continue;
      if (readBody && (preview || !beachMatch)) {
        const detail = await getInquiry(
          client,
          tableName,
          item.inquiryId,
          role,
          now,
        );
        // GSI 반영 전 만료·상태 변경 또는 가림 처리 이전의 본문을 읽지 않음.
        if (!detail || detail.status !== item.status) continue;
        if (detail.restricted) {
          if (q === undefined || beachMatch) {
            items.push(
              preview
                ? { ...item, messagePreviewUnavailableReason: "restricted" }
                : item,
            );
          }
          continue;
        }
        const message = detail.message ?? "";
        if (
          q !== undefined &&
          !beachMatch &&
          !matchesInquiryMessage(message, q)
        )
          continue;
        items.push(preview ? withInquiryPreview(item, message) : item);
      } else {
        items.push(
          preview && role === "viewer"
            ? { ...item, messagePreviewUnavailableReason: "restricted" }
            : item,
        );
      }
    }
  };
  if (!query.status && !query.cursor && unknown?.ok) await pick(unknown.items);
  const dateCondition =
    from && to ? " BETWEEN :from AND :to" : from ? " >= :from" : " <= :to";
  const result = await client.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: INQUIRY_STATUS_INDEX_NAME,
      KeyConditionExpression:
        "#s = :s" + (from || to ? ` AND #received${dateCondition}` : ""),
      ExpressionAttributeNames: {
        "#s": "inquiryStatus",
        ...(from || to ? { "#received": "receivedAt" } : {}),
      },
      ExpressionAttributeValues: {
        ":s": status,
        ...(from ? { ":from": from } : {}),
        ...(to ? { ":to": to } : {}),
      },
      ScanIndexForward: false,
      Limit: Math.min(query.limit, readBody ? BODY_PAGE_MAX : FILTER_PAGE_MAX),
      ...(query.cursor?.k ? { ExclusiveStartKey: query.cursor.k } : {}),
    }),
  );
  await pick(
    ((result.Items ?? []) as Raw[])
      .filter((raw) => alive(raw, nowSec))
      .map(toSummary),
  );
  const lastKey = result.LastEvaluatedKey as Record<string, string> | undefined;
  const nextStatus = query.status
    ? undefined
    : INQUIRY_STATUSES[INQUIRY_STATUSES.indexOf(status) + 1];
  return {
    items,
    nextCursor: lastKey
      ? encodeCursor({ s: status, k: lastKey, f: scope })
      : nextStatus
        ? encodeCursor({ s: nextStatus, f: scope })
        : null,
  };
}

// unknown: 상태를 고르지 않은 첫 쪽(cursor 없음)이면 맨 위에 모르는 상태 문의를 모두 놓음(#521)
// 마지막 쪽까지 넘겨야 보이면 사실상 숨김이라 맨 위에 둠. limit에 세지 않음 → 첫 쪽은 '모르는 상태 전부 + 4종 한 쪽'
// (4종 cursor는 지금 그대로라 빈 다음 쪽이 생기지 않음)
export async function listInquiries(
  client: Sender,
  tableName: string,
  query: ListQuery,
  now: Date,
  unknown?: UnknownStatuses,
): Promise<InquiryPage> {
  const page = await listKnownInquiries(client, tableName, query, now);
  return !query.status && !query.cursor && unknown?.ok
    ? { ...page, items: [...unknown.items, ...page.items] }
    : page;
}

async function listKnownInquiries(
  client: Sender,
  tableName: string,
  query: ListQuery,
  now: Date,
): Promise<InquiryPage> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const statuses = query.status
    ? [query.status]
    : INQUIRY_STATUSES.slice(
        query.cursor ? INQUIRY_STATUSES.indexOf(query.cursor.s) : 0,
      );
  const items: InquirySummary[] = [];
  let startKey = query.cursor?.k;

  for (const status of statuses) {
    let lastKey: Record<string, string> | undefined = startKey;
    startKey = undefined;
    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: INQUIRY_STATUS_INDEX_NAME,
          KeyConditionExpression: "#s = :s",
          ExpressionAttributeNames: { "#s": "inquiryStatus" },
          ExpressionAttributeValues: { ":s": status },
          // 최근 접수 먼저
          ScanIndexForward: false,
          Limit: query.limit - items.length,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      for (const raw of (result.Items ?? []) as Raw[]) {
        if (alive(raw, nowSec)) items.push(toSummary(raw));
      }
      lastKey = result.LastEvaluatedKey as Record<string, string> | undefined;
      if (items.length >= query.limit) {
        // 이 상태에 더 있으면 같은 상태에서, 없으면 다음 상태부터 이어 감
        const nextStatus = lastKey
          ? status
          : statuses[statuses.indexOf(status) + 1];
        return {
          items,
          nextCursor: nextStatus
            ? encodeCursor(
                lastKey ? { s: status, k: lastKey } : { s: nextStatus },
              )
            : null,
        };
      }
    } while (lastKey);
  }
  return { items, nextCursor: null };
}

// 상태별 문의 수 (화면 6장 ADM-INQ '상단 탭에 접수 수'). 상태 GSI를 COUNT로 읽음
// 보관 기한(ttl)이 지난 문의는 목록과 같게 뺌. COUNT도 읽은 항목만큼 읽기 용량을 씀
// 상태 GSI는 읽기 용량 1(infra settings INQUIRY_STATUS_INDEX)이라 한꺼번에 몰리지 않게 상태를 하나씩 셈
// 문의는 90일 보관이고 요약만 projection이라 한 번에 읽는 양이 작음
export async function countInquiries(
  client: Sender,
  tableName: string,
  now: Date,
): Promise<InquiryCounts> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const counts = {} as Record<InquiryStatus, number>;
  for (const status of INQUIRY_STATUSES) {
    let count = 0;
    let lastKey: Record<string, unknown> | undefined;
    do {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: INQUIRY_STATUS_INDEX_NAME,
          KeyConditionExpression: "#s = :s",
          FilterExpression: "#t > :now",
          ExpressionAttributeNames: { "#s": "inquiryStatus", "#t": "ttl" },
          ExpressionAttributeValues: { ":s": status, ":now": nowSec },
          Select: "COUNT",
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      if (typeof result.Count !== "number") {
        throw new Error("문의 수 응답 모양이 틀림");
      }
      count += result.Count;
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    counts[status] = count;
  }
  return counts;
}

const INQUIRY_METRIC_PAGE_LIMIT = 4;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type InquiryCountDetails = Pick<
  InquiryCounts,
  "receivedLast7d" | "resolvedLast7d" | "oldestUnprocessedAt"
>;
const UNKNOWN_INQUIRY_COUNTS = {
  receivedLast7d: null,
  resolvedLast7d: null,
  oldestUnprocessedAt: null,
} satisfies InquiryCountDetails;
const inquiryMetrics = new WeakMap<
  Sender,
  {
    inquiryTable: string;
    opsTable: string;
    expiresAt: number;
    pending: Promise<InquiryCountDetails>;
  }
>();
export const INQUIRY_METRICS_TIMEOUT_MS = 1_500;
const INQUIRY_METRICS_CACHE_MS = 60_000;

export async function inquiryCountDetails(
  client: Sender,
  tableName: string,
  opsTable: string,
  now: Date,
): Promise<InquiryCountDetails> {
  const cached = inquiryMetrics.get(client);
  const time = now.getTime();
  if (
    cached &&
    cached.inquiryTable === tableName &&
    cached.opsTable === opsTable &&
    time < cached.expiresAt
  ) {
    const details = await cached.pending;
    return {
      ...details,
      oldestUnprocessedAt: details.oldestUnprocessedAt ?? null,
    };
  }

  // 상한이 지나면 진행 중인 읽기가 바로 실패해 각 지표가 null(확인 못 함)이 됨
  const reads = boundedReads(client, INQUIRY_METRICS_TIMEOUT_MS);
  const pending = readInquiryCountDetails(
    reads.sender,
    tableName,
    opsTable,
    now,
  )
    .catch(() => UNKNOWN_INQUIRY_COUNTS)
    .finally(reads.done);
  const entry = {
    inquiryTable: tableName,
    opsTable,
    expiresAt: time + INQUIRY_METRICS_CACHE_MS,
    pending,
  };
  inquiryMetrics.set(client, entry);
  const details = await pending;
  if (
    (reads.signal.aborted ||
      details.receivedLast7d === null ||
      details.resolvedLast7d === null ||
      details.oldestUnprocessedAt === undefined) &&
    inquiryMetrics.get(client) === entry
  )
    inquiryMetrics.delete(client);
  return {
    ...details,
    oldestUnprocessedAt: details.oldestUnprocessedAt ?? null,
  };
}

// bounded: 시간 상한이 걸린 sender(boundedReads)
async function readInquiryCountDetails(
  bounded: Sender,
  tableName: string,
  opsTable: string,
  now: Date,
): Promise<InquiryCountDetails> {
  const from = new Date(now.getTime() - SEVEN_DAYS_MS).toISOString();
  const to = now.toISOString();
  const nowSec = Math.floor(now.getTime() / 1000);

  async function receivedLast7d() {
    let count = 0;
    for (const status of INQUIRY_STATUSES) {
      let startKey: Record<string, unknown> | undefined;
      for (let page = 0; page < INQUIRY_METRIC_PAGE_LIMIT; page += 1) {
        const result = await bounded.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: INQUIRY_STATUS_INDEX_NAME,
            KeyConditionExpression:
              "#s = :s AND receivedAt BETWEEN :from AND :to",
            FilterExpression: "#t > :now",
            ExpressionAttributeNames: { "#s": "inquiryStatus", "#t": "ttl" },
            ExpressionAttributeValues: {
              ":s": status,
              ":from": from,
              ":to": to,
              ":now": nowSec,
            },
            Select: "COUNT",
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          }),
        );
        if (
          typeof result.Count !== "number" ||
          !Number.isSafeInteger(result.Count) ||
          result.Count < 0
        ) {
          throw new Error("최근 접수 수 응답 모양이 틀림");
        }
        count += result.Count;
        startKey = result.LastEvaluatedKey;
        if (!startKey) break;
      }
      if (startKey) return null;
    }
    return count;
  }

  async function oldestUnprocessedAt() {
    let oldest: string | null = null;
    for (const status of ["received", "in_progress"] as const) {
      let startKey: Record<string, unknown> | undefined;
      for (let page = 0; page < INQUIRY_METRIC_PAGE_LIMIT; page += 1) {
        const result = await bounded.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: INQUIRY_STATUS_INDEX_NAME,
            KeyConditionExpression: "#s = :s",
            FilterExpression: "#t > :now",
            ProjectionExpression: "receivedAt",
            ExpressionAttributeNames: { "#s": "inquiryStatus", "#t": "ttl" },
            ExpressionAttributeValues: { ":s": status, ":now": nowSec },
            ScanIndexForward: true,
            Limit: 20,
            ...(startKey ? { ExclusiveStartKey: startKey } : {}),
          }),
        );
        if (result.Items?.length) {
          const at = result.Items[0]?.receivedAt;
          if (
            typeof at !== "string" ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(at) ||
            !Number.isFinite(Date.parse(at))
          ) {
            throw new Error("가장 오래된 문의 시각 모양이 틀림");
          }
          const normalized = new Date(at).toISOString();
          if (oldest === null || normalized < oldest) oldest = normalized;
          startKey = undefined;
          break;
        }
        startKey = result.LastEvaluatedKey;
        if (!startKey) break;
      }
      if (startKey) return undefined;
    }
    return oldest;
  }

  async function resolvedLast7d() {
    const resolved = new Set<string>();
    let cursor: Parameters<typeof listAudit>[2]["cursor"];
    for (let page = 0; page < INQUIRY_METRIC_PAGE_LIMIT; page += 1) {
      const result = await listAudit(
        bounded,
        opsTable,
        {
          filter: { from, to, action: "inquiry.update" },
          limit: 100,
          ...(cursor ? { cursor } : {}),
        },
        now,
      );
      for (const entry of result.items) {
        if (
          entry.target.kind === "inquiry" &&
          entry.statusTo === "resolved" &&
          entry.statusFrom === undefined
        )
          return null;
        if (
          entry.target.kind === "inquiry" &&
          entry.statusTo === "resolved" &&
          entry.statusFrom !== "resolved"
        )
          resolved.add(entry.target.id);
      }
      if (!result.nextCursor) return resolved.size;
      const next = parseAuditQuery({ cursor: result.nextCursor }, now);
      if (!next.ok || !next.query.cursor) return null;
      cursor = next.query.cursor;
    }
    return null;
  }

  // 문의 GSI 읽기 용량에 맞춰 같은 인덱스 조회는 순서대로 수행함
  const completion = resolvedLast7d().catch(() => null);
  const received = await receivedLast7d().catch(() => null);
  const oldest = await oldestUnprocessedAt().catch(() => undefined);
  return {
    receivedLast7d: received,
    resolvedLast7d: await completion,
    ...(oldest !== undefined ? { oldestUnprocessedAt: oldest } : {}),
  };
}

export async function getInquiry(
  client: Sender,
  tableName: string,
  inquiryId: string,
  role: OperatorRole,
  now: Date,
): Promise<InquiryDetail | null> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk: `INQUIRY#${inquiryId}` },
      ConsistentRead: true,
    }),
  );
  const item = result.Item as Raw | undefined;
  if (!item || item.kind !== "inquiry") return null;
  if (!alive(item, Math.floor(now.getTime() / 1000))) return null;
  // 이전 도구를 돌리기 전 문의는 상태가 없음 → '접수'·version 0으로 보여 주고 version 0 조건으로 바꾸게 함
  const summary = toSummary({
    ...item,
    inquiryStatus: item.inquiryStatus ?? "received",
    version: item.version ?? 0,
    legacy: item.legacy ?? item.inquiryStatus === undefined,
  });
  const base = {
    ...summary,
    ...(typeof item.updatedAt === "string"
      ? { updatedAt: item.updatedAt }
      : {}),
    emailCollected: false as const,
    photosCollected: false as const,
  };
  if (role === "viewer") return { ...base, restricted: true };
  return {
    ...base,
    restricted: false,
    message: typeof item.message === "string" ? item.message : "",
    memo: typeof item.memo === "string" ? item.memo : null,
    rejectReason:
      typeof item.rejectReason === "string" ? item.rejectReason : null,
  };
}

export interface InquiryPatch {
  readonly version: number;
  readonly status?: InquiryStatus;
  readonly memo?: string | null;
  readonly rejectReason?: string;
  readonly redactions?: readonly Redaction[];
}

// 본문에서 가릴 부분. start·end는 저장된 본문의 UTF-16 위치(끝 미포함), text는 그 자리의 글
// text를 함께 받아 화면이 본 본문과 서버 본문이 어긋나면 거부함(엉뚱한 곳을 지우지 않게)
export interface Redaction {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export type PatchCheck =
  | { readonly ok: true; readonly patch: InquiryPatch }
  | { readonly ok: false; readonly field: string };

// 요청 본문 검사. 모르는 칸이 있으면 거부(조용히 무시하지 않음)
export function parseInquiryPatch(body: unknown): PatchCheck {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, field: "body" };
  }
  const value = body as Raw;
  const allowed = new Set([
    "version",
    "status",
    "memo",
    "rejectReason",
    "redactions",
  ]);
  const unknown = Object.keys(value).find((k) => !allowed.has(k));
  if (unknown) return { ok: false, field: unknown };
  const { version, status, memo, rejectReason, redactions } = value;
  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    return { ok: false, field: "version" };
  }
  if (status !== undefined && !isInquiryStatus(status)) {
    return { ok: false, field: "status" };
  }
  if (
    memo !== undefined &&
    memo !== null &&
    (typeof memo !== "string" || [...memo].length > MEMO_MAX)
  ) {
    return { ok: false, field: "memo" };
  }
  // 반려 이유는 반려할 때 필수, 공백만은 거부(D16-D6). 반려가 아닌 상태로 바꾸면서 보내면 거부
  if (status === "rejected") {
    if (
      typeof rejectReason !== "string" ||
      rejectReason.trim() === "" ||
      [...rejectReason].length > REJECT_REASON_MAX
    ) {
      return { ok: false, field: "rejectReason" };
    }
  } else if (rejectReason !== undefined) {
    return { ok: false, field: "rejectReason" };
  }
  const ranges = redactions === undefined ? undefined : parseRanges(redactions);
  if (ranges === null) return { ok: false, field: "redactions" };
  if (status === undefined && memo === undefined && ranges === undefined) {
    return { ok: false, field: "body" };
  }
  return {
    ok: true,
    patch: {
      version: version as number,
      ...(status !== undefined ? { status: status as InquiryStatus } : {}),
      ...(memo !== undefined ? { memo: memo as string | null } : {}),
      ...(status === "rejected"
        ? { rejectReason: (rejectReason as string).trim() }
        : {}),
      ...(ranges !== undefined ? { redactions: ranges } : {}),
    },
  };
}

// 모양만 검사(1~20개, 정수 위치, 겹치지 않게 앞에서부터). 본문과 맞는지는 applyRedactions가 봄
function parseRanges(value: unknown): Redaction[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > REDACTION_MAX) return null;
  const ranges: Redaction[] = [];
  let last = 0;
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const keys = Object.keys(entry as Raw);
    if (keys.some((k) => k !== "start" && k !== "end" && k !== "text")) {
      return null;
    }
    const { start, end, text } = entry as Raw;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      typeof text !== "string" ||
      (start as number) < last ||
      (end as number) <= (start as number) ||
      text.length !== (end as number) - (start as number)
    ) {
      return null;
    }
    ranges.push({ start: start as number, end: end as number, text });
    last = end as number;
  }
  return ranges;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// 가린 본문. 범위가 본문 밖이거나, 그 자리 글이 text와 다르거나, 글자(서로게이트 쌍) 가운데를 자르면 null
// 공백만 고른 범위도 거부함(가린 것처럼 보이지만 지운 개인정보가 없음)
export function applyRedactions(
  message: string,
  ranges: readonly Redaction[],
): string | null {
  let out = "";
  let at = 0;
  for (const { start, end, text } of ranges) {
    if (end > message.length) return null;
    if (message.slice(start, end) !== text || text.trim() === "") return null;
    if (
      isLow(message.charCodeAt(start)) &&
      isHigh(message.charCodeAt(start - 1))
    ) {
      return null;
    }
    if (isHigh(message.charCodeAt(end - 1)) && isLow(message.charCodeAt(end))) {
      return null;
    }
    out += message.slice(at, start) + REDACTION_MARK;
    at = end;
  }
  return out + message.slice(at);
}

// 저장할 속성. 반려가 아닌 상태로 바꾸면 반려 이유를 지움(null)
export function inquiryPatchFields(
  patch: InquiryPatch,
): Record<string, unknown> {
  return {
    ...(patch.status !== undefined ? { inquiryStatus: patch.status } : {}),
    ...(patch.status === "rejected"
      ? { rejectReason: patch.rejectReason }
      : patch.status !== undefined
        ? { rejectReason: null }
        : {}),
    ...(patch.memo !== undefined ? { memo: patch.memo } : {}),
  };
}

// 감사 기록의 바뀐 항목 이름(값은 넣지 않음, D16-B5·D6). 개인정보 가리기는 'message'만 남김(가린 글은 복사 안 함)
// 반려가 아닌 상태로 바꿔 반려 이유가 지워지는 경우도 바뀐 항목으로 셈
export function inquiryAuditChanges(
  patch: InquiryPatch,
  current: Pick<InquiryDetail, "rejectReason">,
): string[] {
  const clearsReason =
    patch.status !== undefined &&
    patch.status !== "rejected" &&
    typeof current.rejectReason === "string";
  return [
    ...(patch.status !== undefined ? ["status"] : []),
    ...(patch.rejectReason !== undefined || clearsReason
      ? ["rejectReason"]
      : []),
    ...(patch.memo !== undefined ? ["memo"] : []),
    ...(patch.redactions !== undefined ? ["message"] : []),
  ];
}
