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

export interface InquiryPage {
  readonly items: readonly InquirySummary[];
  readonly nextCursor: string | null;
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
  const allowed = new Set(["version", "status", "memo", "rejectReason"]);
  const unknown = Object.keys(value).find((k) => !allowed.has(k));
  if (unknown) return { ok: false, field: unknown };
  const { version, status, memo, rejectReason } = value;
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
  if (status === undefined && memo === undefined) {
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
    },
  };
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
