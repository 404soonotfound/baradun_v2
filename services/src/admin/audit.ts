import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { Principal } from "./auth";
import type { RequestIds } from "./http";
import { AUDIT_PREFIX, auditKey } from "./keys";
import { AUDIT_TTL_SECONDS, OPERATOR_ROLES, type OperatorRole } from "./policy";
import type { Sender } from "./writes";
import { isInquiryStatus, type InquiryStatus } from "../inquiry/policy";
import type { NoticeContent } from "./notices";

// 변경 이력(감사 기록) (BRD-155, D16-B5, 아키텍처 18.3, 화면 ADM-AUD)
// - 남기는 것: 시각·운영자(Cognito sub)·종류·대상·바뀐 항목 이름. 처리 상태는 앞·뒤 값도 남김(정해진 4개 값)
// - 남기지 않는 것: 문의 본문·내부 메모·반려 이유 글·이메일(바뀐 항목 이름만 남김)
// - 운영 API 쓰기는 업무 변경과 같은 트랜잭션에 넣음(versionedWrite) → 기록 없는 변경·변경 없는 기록이 없음
// - 샘플 계정은 로그인(/ops/me)·조회·거절된 요청을 모두 남김. 기록에 실패하면 응답하지 않음(500)
// - 추가 전용: 새 키에만 씀(attribute_not_exists). 운영 API 역할은 감사 키를 바꾸거나 지울 수 없음(IAM Deny)
// - 보관 1년(TTL). 재해 복구(PITR·백업)는 따로 정함(미확정, 구현 제안 I10)

export const AUDIT_ACTIONS = [
  // 문의 처리 상태·반려 이유·내부 메모 변경(BRD-153)
  "inquiry.update",
  // 공지 만들기·문구 저장·노출·노출 끝내기·지우기(BRD-151)
  "notice.create",
  "notice.update",
  "notice.expose",
  "notice.end",
  "notice.delete",
  // 샘플 계정이 허용된 조회를 함(로그인 뒤 /ops/me 포함)
  "sample.read",
  // 샘플 계정 요청을 거절함(쓰기·허용 밖 경로)
  "sample.denied",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: unknown): value is AuditAction {
  return (AUDIT_ACTIONS as readonly unknown[]).includes(value);
}

// 화면 탭 분류(시안 4차 V23). 종류 이름 앞부분(notice.·inquiry.…)으로 정함
// 해변(저장소 커밋)·게시·권한·로그인 기록은 그 기능이 생길 때 같은 앞부분으로 더함
// 데모 계정 기록(sample.*)은 어느 분류에도 넣지 않고 전체에만 보임
export const AUDIT_CATEGORIES = [
  "notice",
  "beach",
  "publish",
  "inquiry",
  "permission",
  "login",
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export function isAuditCategory(value: unknown): value is AuditCategory {
  return (AUDIT_CATEGORIES as readonly unknown[]).includes(value);
}

export function categoryOf(action: string): AuditCategory | null {
  const head = action.split(".")[0];
  return isAuditCategory(head) ? head : null;
}

export type AuditCounts = Readonly<Record<AuditCategory | "all", number>>;

// 찾기 글자 상한(대상 이름·ID 일부)
export const AUDIT_SEARCH_MAX = 50;

export interface AuditActor {
  readonly sub: string;
  readonly kind: Principal["kind"];
  readonly role: OperatorRole | "sample";
}

export function actorOf(principal: Principal): AuditActor {
  return {
    sub: principal.sub,
    kind: principal.kind,
    role: principal.kind === "operator" ? principal.role : "sample",
  };
}

// 대상: 문의는 문의 ID, 공지는 공지 ID, 샘플 요청은 "METHOD 경로 모양"(실제 경로 값은 넣지 않음)
export interface AuditTarget {
  readonly kind: "inquiry" | "notice" | "route";
  readonly id: string;
}

export interface AuditEntry {
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly target: AuditTarget;
  // 화면에 보일 대상 이름(공지는 한국어 제목). 문의는 넣지 않음(본문·이메일을 복사하지 않음)
  readonly targetLabel?: string;
  // 공지 문구 앞·뒤(시안 V23 바뀐 내용 펼치기). 공지는 공개 문구라 넣음. 문의 본문은 넣지 않음(D16-B5)
  readonly notice?: {
    readonly before: NoticeContent | null;
    readonly after: NoticeContent | null;
  };
  // 바뀐 항목 이름(status·memo·rejectReason 등). 값은 넣지 않음
  readonly changes: readonly string[];
  readonly statusFrom?: InquiryStatus;
  readonly statusTo?: InquiryStatus;
  readonly ids: RequestIds;
}

// 저장할 항목. at은 UTC ISO(화면이 Asia/Seoul로 바꿔 보여 줌, 구현 제안 I09)
export function auditItem(
  entry: AuditEntry,
  now: Date,
): Record<string, unknown> {
  const at = now.toISOString();
  return {
    ...auditKey(at, entry.ids.traceId),
    kind: "audit",
    at,
    actorSub: entry.actor.sub,
    actorKind: entry.actor.kind,
    role: entry.actor.role,
    action: entry.action,
    targetKind: entry.target.kind,
    targetId: entry.target.id,
    changes: [...entry.changes],
    ...(entry.targetLabel ? { targetLabel: entry.targetLabel } : {}),
    ...(entry.notice
      ? { noticeBefore: entry.notice.before, noticeAfter: entry.notice.after }
      : {}),
    ...(entry.statusFrom ? { statusFrom: entry.statusFrom } : {}),
    ...(entry.statusTo ? { statusTo: entry.statusTo } : {}),
    requestId: entry.ids.requestId,
    traceId: entry.ids.traceId,
    ttl: Math.floor(now.getTime() / 1000) + AUDIT_TTL_SECONDS,
  };
}

// 업무 변경 없이 기록만 남김(샘플 요청). 같은 키가 이미 있으면 덮어쓰지 않고 던짐
export async function recordAudit(
  client: Sender,
  opsTable: string,
  entry: AuditEntry,
  now: Date,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: opsTable,
      Item: auditItem(entry, now),
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );
}

// ---- 목록 GET /ops/audit?from=&to=&action=&actor=&cursor=&limit= ----

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 100;
// 기본 기간 30일, 최대 기간은 보관 기간과 같은 366일
export const AUDIT_DEFAULT_DAYS = 30;
export const AUDIT_MAX_DAYS = 366;
// 한 번 요청에 읽는 쪽 수 상한(필터에 맞는 기록이 드물 때 응답이 늦어지지 않게). 넘으면 cursor로 이어 감
const MAX_QUERIES_PER_PAGE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

// 시각은 UTC(Z)만 받음. 시간대 없는 값·+09:00은 거부(KST·UTC를 섞지 않음)
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
// Cognito sub(UUID)와 테스트용 짧은 sub
const ACTOR = /^[0-9A-Za-z-]{1,128}$/;
const MONTH = /^\d{4}-\d{2}$/;

export interface AuditFilter {
  readonly from: string;
  readonly to: string;
  readonly action?: AuditAction;
  readonly category?: AuditCategory;
  readonly actor?: string;
  // 대상 이름·ID에 들어 있는 글자(대소문자 그대로)
  readonly q?: string;
}

// 불투명 cursor: 필터 + 읽던 월(m) + 그 월의 LastEvaluatedKey(k)
interface AuditCursor extends AuditFilter {
  readonly m: string;
  readonly k?: { readonly pk: string; readonly sk: string };
}

export interface AuditQuery {
  readonly filter: AuditFilter;
  readonly limit: number;
  readonly cursor?: AuditCursor;
}

export interface AuditView {
  readonly at: string;
  readonly actorSub: string;
  readonly actorKind: Principal["kind"];
  readonly role: OperatorRole | "sample";
  readonly action: AuditAction;
  readonly target: AuditTarget;
  readonly targetLabel?: string;
  readonly changes: readonly string[];
  readonly statusFrom?: InquiryStatus;
  readonly statusTo?: InquiryStatus;
  readonly notice?: {
    readonly before: NoticeContent | null;
    readonly after: NoticeContent | null;
  };
  readonly requestId: string;
}

export interface AuditPage {
  // 화면이 실제로 적용된 기간을 보여 주게 돌려줌(기본값을 쓴 경우 포함)
  readonly filter: AuditFilter;
  readonly items: readonly AuditView[];
  readonly nextCursor: string | null;
  // 첫 쪽(cursor 없음)에만: 기간·운영자·찾기에 맞는 분류별 수(탭 수). 종류·분류 거르기는 빼고 셈
  readonly counts?: AuditCounts;
}

function encodeCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(text: string): AuditCursor | null {
  try {
    const value = JSON.parse(
      Buffer.from(text, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (typeof value !== "object" || value === null) return null;
    const { from, to, action, category, actor, q, m, k } = value;
    if (
      typeof from !== "string" ||
      !UTC_ISO.test(from) ||
      typeof to !== "string" ||
      !UTC_ISO.test(to) ||
      (action !== undefined && !isAuditAction(action)) ||
      (category !== undefined && !isAuditCategory(category)) ||
      (actor !== undefined &&
        (typeof actor !== "string" || !ACTOR.test(actor))) ||
      (q !== undefined && !validSearch(q))
    ) {
      return null;
    }
    // 읽던 월은 기간 안이어야 하고, 키는 그 월의 감사 키여야 함
    if (
      typeof m !== "string" ||
      !MONTH.test(m) ||
      m < from.slice(0, 7) ||
      m > to.slice(0, 7)
    ) {
      return null;
    }
    let key: AuditCursor["k"];
    if (k !== undefined) {
      const { pk, sk } = (k ?? {}) as Record<string, unknown>;
      if (
        typeof k !== "object" ||
        k === null ||
        Object.keys(k).length !== 2 ||
        pk !== `${AUDIT_PREFIX}${m}` ||
        typeof sk !== "string"
      ) {
        return null;
      }
      key = { pk, sk };
    }
    return {
      from,
      to,
      ...(action !== undefined ? { action } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(actor !== undefined ? { actor: actor as string } : {}),
      ...(q !== undefined ? { q: q as string } : {}),
      m,
      ...(key ? { k: key } : {}),
    };
  } catch {
    return null;
  }
}

function validSearch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value !== "" &&
    [...value].length <= AUDIT_SEARCH_MAX
  );
}

// 기간 검사: 시작 ≤ 끝, 최대 366일. 처음 요청과 cursor에 담긴 기간에 똑같이 씀
function validPeriod(from: string, to: string): boolean {
  const span = Date.parse(to) - Date.parse(from);
  return span >= 0 && span <= AUDIT_MAX_DAYS * DAY_MS;
}

export type AuditQueryCheck =
  | { readonly ok: true; readonly query: AuditQuery }
  | { readonly ok: false; readonly field: string };

// 요청 값 검사. cursor가 있으면 필터는 cursor에 담긴 값을 쓰고, 함께 보낸 값이 다르면 거부(다른 목록과 섞지 않음)
export function parseAuditQuery(
  params: Readonly<Record<string, string | undefined>>,
  now: Date,
): AuditQueryCheck {
  const {
    from,
    to,
    action,
    category,
    actor,
    q,
    cursor,
    limit: limitText,
  } = params;
  const limit =
    limitText === undefined ? AUDIT_PAGE_DEFAULT : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_PAGE_MAX) {
    return { ok: false, field: "limit" };
  }
  for (const [field, value] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (
      value !== undefined &&
      (!UTC_ISO.test(value) || Number.isNaN(Date.parse(value)))
    ) {
      return { ok: false, field };
    }
  }
  if (action !== undefined && !isAuditAction(action)) {
    return { ok: false, field: "action" };
  }
  if (category !== undefined && !isAuditCategory(category)) {
    return { ok: false, field: "category" };
  }
  if (actor !== undefined && !ACTOR.test(actor)) {
    return { ok: false, field: "actor" };
  }
  if (q !== undefined && !validSearch(q)) {
    return { ok: false, field: "q" };
  }

  if (cursor !== undefined) {
    const state = decodeCursor(cursor);
    const iso = (v: string | undefined) =>
      v === undefined ? undefined : new Date(v).toISOString();
    if (
      !state ||
      !validPeriod(state.from, state.to) ||
      (from !== undefined && iso(from) !== state.from) ||
      (to !== undefined && iso(to) !== state.to) ||
      (action !== undefined && action !== state.action) ||
      (category !== undefined && category !== state.category) ||
      (actor !== undefined && actor !== state.actor) ||
      (q !== undefined && q !== state.q)
    ) {
      return { ok: false, field: "cursor" };
    }
    const { m: _m, k: _k, ...filter } = state;
    return { ok: true, query: { filter, limit, cursor: state } };
  }

  const toDate = to === undefined ? now : new Date(to);
  const fromDate =
    from === undefined
      ? new Date(toDate.getTime() - AUDIT_DEFAULT_DAYS * DAY_MS)
      : new Date(from);
  if (!validPeriod(fromDate.toISOString(), toDate.toISOString())) {
    return { ok: false, field: "from" };
  }
  return {
    ok: true,
    query: {
      filter: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        ...(action !== undefined ? { action } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(actor !== undefined ? { actor } : {}),
        ...(q !== undefined ? { q } : {}),
      },
      limit,
    },
  };
}

function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

function toView(item: Record<string, unknown>): AuditView {
  const {
    at,
    actorSub,
    actorKind,
    role,
    action,
    targetKind,
    targetId,
    changes,
    statusFrom,
    statusTo,
    requestId,
    targetLabel,
    noticeBefore,
    noticeAfter,
  } = item;
  if (
    typeof at !== "string" ||
    typeof actorSub !== "string" ||
    (actorKind !== "operator" && actorKind !== "sample") ||
    !(
      role === "sample" || (OPERATOR_ROLES as readonly unknown[]).includes(role)
    ) ||
    !isAuditAction(action) ||
    (targetKind !== "inquiry" &&
      targetKind !== "notice" &&
      targetKind !== "route") ||
    typeof targetId !== "string" ||
    !Array.isArray(changes) ||
    !changes.every((c) => typeof c === "string") ||
    (statusFrom !== undefined && !isInquiryStatus(statusFrom)) ||
    (statusTo !== undefined && !isInquiryStatus(statusTo)) ||
    typeof requestId !== "string" ||
    (targetLabel !== undefined && typeof targetLabel !== "string") ||
    (noticeBefore !== undefined && !isNoticeSnapshot(noticeBefore)) ||
    (noticeAfter !== undefined && !isNoticeSnapshot(noticeAfter))
  ) {
    // 모양이 틀린 기록을 조용히 빼면 이력이 빠진 것처럼 보이지 않으므로 던짐(500)
    throw new Error("감사 기록 모양이 틀림");
  }
  return {
    at,
    actorSub,
    actorKind,
    role: role as AuditView["role"],
    action,
    target: { kind: targetKind, id: targetId },
    ...(typeof targetLabel === "string" ? { targetLabel } : {}),
    changes: changes as string[],
    ...(statusFrom !== undefined ? { statusFrom } : {}),
    ...(statusTo !== undefined ? { statusTo } : {}),
    ...(noticeBefore !== undefined || noticeAfter !== undefined
      ? {
          notice: {
            before: (noticeBefore ?? null) as NoticeContent | null,
            after: (noticeAfter ?? null) as NoticeContent | null,
          },
        }
      : {}),
    requestId,
  };
}

// 공지 앞·뒤 모양 검사(null은 '없음': 만들기 전·지운 뒤)
function isNoticeSnapshot(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const text = (t: unknown) =>
    typeof t === "object" &&
    t !== null &&
    typeof (t as Record<string, unknown>).ko === "string" &&
    typeof (t as Record<string, unknown>).en === "string";
  return (
    typeof v.kind === "string" &&
    text(v.title) &&
    text(v.body) &&
    typeof v.startsAt === "string" &&
    (v.endsAt === null || typeof v.endsAt === "string")
  );
}

// 거르기 식(보관 기한·종류·분류·운영자·찾기). 분류는 종류 이름 앞부분으로 거름
function filterExpression(
  filter: AuditFilter,
  now: Date,
  options: { readonly withKind: boolean },
): {
  expression: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
} {
  const names: Record<string, string> = { "#ttl": "ttl" };
  const values: Record<string, unknown> = {
    ":nowSec": Math.floor(now.getTime() / 1000),
  };
  const parts = ["#ttl > :nowSec"];
  if (options.withKind && filter.action) {
    names["#action"] = "action";
    values[":action"] = filter.action;
    parts.push("#action = :action");
  }
  if (options.withKind && filter.category) {
    names["#action"] = "action";
    values[":category"] = `${filter.category}.`;
    parts.push("begins_with(#action, :category)");
  }
  if (filter.actor) {
    values[":actor"] = filter.actor;
    parts.push("actorSub = :actor");
  }
  if (filter.q) {
    values[":q"] = filter.q;
    parts.push("(contains(targetLabel, :q) OR contains(targetId, :q))");
  }
  return { expression: parts.join(" AND "), names, values };
}

// 탭 수: 기간 안 기록을 모두 읽어 분류별로 셈(종류·분류 거르기는 빼고 운영자·찾기만 적용)
// 운영 기록은 하루 몇십 건 수준이라 1년을 읽어도 작음. 종류 이름만 가져옴
export async function countAudit(
  client: Sender,
  opsTable: string,
  filter: AuditFilter,
  now: Date,
): Promise<AuditCounts> {
  const counts: Record<AuditCategory | "all", number> = {
    all: 0,
    notice: 0,
    beach: 0,
    publish: 0,
    inquiry: 0,
    permission: 0,
    login: 0,
  };
  const { expression, names, values } = filterExpression(filter, now, {
    withKind: false,
  });
  const fromMonth = filter.from.slice(0, 7);
  for (
    let month = filter.to.slice(0, 7);
    month >= fromMonth;
    month = previousMonth(month)
  ) {
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await client.send(
        new QueryCommand({
          TableName: opsTable,
          KeyConditionExpression: "pk = :pk AND #sk BETWEEN :from AND :to",
          FilterExpression: expression,
          ProjectionExpression: "#action",
          ExpressionAttributeNames: {
            ...names,
            "#sk": "sk",
            "#action": "action",
          },
          ExpressionAttributeValues: {
            ...values,
            ":pk": AUDIT_PREFIX + month,
            ":from": filter.from,
            ":to": `${filter.to}#~`,
          },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      for (const item of page.Items ?? []) {
        counts.all += 1;
        const category = categoryOf(String(item.action));
        if (category) counts[category] += 1;
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);
  }
  return counts;
}

// 최근 기록부터. 월 파티션을 to 월 → from 월로 내려가며 읽음
// 보관 기한(ttl)이 지난 기록은 TTL 삭제 전이라도 뺌(보관 1년 밖을 보여 주지 않음)
// 필터(보관 기한·종류·운영자)는 읽은 뒤 거름 → Limit을 남은 개수로 두어 한 쪽에서 넘치지 않게 하고 LastEvaluatedKey를 cursor로 씀
export async function listAudit(
  client: Sender,
  opsTable: string,
  query: AuditQuery,
  now: Date,
): Promise<AuditPage> {
  const { filter } = query;
  const fromMonth = filter.from.slice(0, 7);
  let month = query.cursor?.m ?? filter.to.slice(0, 7);
  let startKey: AuditCursor["k"] = query.cursor?.k;
  const items: AuditView[] = [];
  const built = filterExpression(filter, now, { withKind: true });
  const names: Record<string, string> = { ...built.names, "#sk": "sk" };
  const values: Record<string, unknown> = {
    ...built.values,
    ":from": filter.from,
    // sk = {시각}#{traceId}. "~"는 traceId 글자(16진수·-)보다 뒤라 to 시각의 기록까지 포함
    ":to": `${filter.to}#~`,
  };

  for (let queries = 0; queries < MAX_QUERIES_PER_PAGE; queries++) {
    const page = await client.send(
      new QueryCommand({
        TableName: opsTable,
        KeyConditionExpression: "pk = :pk AND #sk BETWEEN :from AND :to",
        FilterExpression: built.expression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: { ...values, ":pk": AUDIT_PREFIX + month },
        ScanIndexForward: false,
        Limit: query.limit - items.length,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of (page.Items ?? []) as Record<string, unknown>[]) {
      items.push(toView(item));
    }
    const last = page.LastEvaluatedKey as Record<string, string> | undefined;
    if (last) {
      startKey = { pk: String(last.pk), sk: String(last.sk) };
    } else {
      if (month <= fromMonth) {
        return { filter, items, nextCursor: null };
      }
      month = previousMonth(month);
      startKey = undefined;
    }
    if (items.length >= query.limit) break;
  }
  return {
    filter,
    items,
    nextCursor: encodeCursor({
      ...filter,
      m: month,
      ...(startKey ? { k: startKey } : {}),
    }),
  };
}
