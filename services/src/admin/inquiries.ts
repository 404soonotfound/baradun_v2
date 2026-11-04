import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  INQUIRY_STATUSES,
  INQUIRY_STATUS_INDEX_NAME,
  isInquiryStatus,
  type InquiryStatus,
} from "../inquiry/policy";
import type { OperatorRole } from "./policy";
import type { Sender } from "./writes";

// 운영자 화면 문의 (BRD-153, 결정 기록 D16-B4·D5·D6·D7, 화면 설계서 6장 ADM-INQ)
// - 목록: 상태 + 접수 시각 GSI(요약만 projection). 접수 먼저, 같은 상태 안에서는 최근 접수 순
//   상태를 고르지 않으면 4개 상태를 이 순서로 이어 붙여 한 목록으로 보여 줌(구현 제안 I08)
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
  readonly receivedAt: string;
  readonly status: InquiryStatus;
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

export type InquiryCounts = Readonly<Record<InquiryStatus, number>>;

export interface InquiryPage {
  readonly items: readonly InquirySummary[];
  readonly nextCursor: string | null;
  // 첫 쪽(cursor 없음)에만 실음: 상태 탭의 문의 수(보관 기한이 지난 문의 제외)
  readonly counts?: InquiryCounts;
}

type Raw = Record<string, unknown>;

function alive(item: Raw, nowSec: number): boolean {
  return typeof item.ttl === "number" && item.ttl > nowSec;
}

// 저장된 모양이 틀리면 목록에서 조용히 빼지 않고 던짐(500) → 데이터 문제를 숨기지 않음
function toSummary(item: Raw): InquirySummary {
  if (
    typeof item.inquiryId !== "string" ||
    typeof item.inquiryType !== "string" ||
    typeof item.receivedAt !== "string" ||
    !isInquiryStatus(item.inquiryStatus) ||
    typeof item.version !== "number"
  ) {
    throw new Error("문의 항목 모양이 틀림");
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
    const { s, k } = value as { s?: unknown; k?: unknown };
    if (!isInquiryStatus(s)) return null;
    if (k === undefined) return { s };
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
    return { s, k: k as Record<string, string> };
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

export async function listInquiries(
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
