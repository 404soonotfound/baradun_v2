import type { Activity, InquiryType } from "@baradun/contracts";
import { opsFetch, type OpsResult } from "./auth/ops-fetch";

// 운영자 문의 화면이 쓰는 운영 API 모양 (BRD-153). services/src/admin/inquiries.ts 응답과 같음
// 판단 상태는 여기서도 바꾸지 않음(G1)

export const INQUIRY_STATUSES = [
  "received",
  "in_progress",
  "resolved",
  "rejected",
] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

export function isInquiryStatus(value: unknown): value is InquiryStatus {
  return (INQUIRY_STATUSES as readonly unknown[]).includes(value);
}

// 받은 날부터 90일 보관(D15-7, services/src/inquiry/policy.ts INQUIRY_BODY_RETENTION_DAYS)
export const RETENTION_DAYS = 90;
// 시안 4차 V20 기준 한 쪽 6행
export const PAGE_SIZE = 6;
// 서버 한 번 요청 최대 수(services/src/admin/inquiries.ts INQUIRY_PAGE_MAX)
export const INQUIRY_PAGE_MAX = 50;

export interface InquirySummary {
  readonly inquiryId: string;
  // 계약의 유형·활동이 아닌 값이 와도 숨기지 않고 그대로 보여 줌(화면에서 '알 수 없는 유형')
  readonly type: InquiryType | string;
  readonly beachId?: string;
  readonly activity?: Activity | string;
  readonly receivedAt: string;
  // 서버가 새 상태를 더해도 화면이 숨기지 않게 넓게 받음(배지가 '알 수 없는 상태'로 보여 줌)
  readonly status: InquiryStatus | string;
  readonly version: number;
  readonly legacy: boolean;
  // preview=true로 요청했을 때만 옴(#491). 공백을 줄여 42자까지, 잘렸으면 '…'
  readonly messagePreview?: string;
  // 미리보기를 뺀 이유: restricted(보기 권한) · empty(본문 없음). 모르는 값도 숨기지 않고 받음
  readonly messagePreviewUnavailableReason?: "restricted" | "empty" | string;
}

export interface InquiryDetail extends InquirySummary {
  readonly restricted: boolean;
  readonly message?: string;
  readonly memo?: string | null;
  readonly rejectReason?: string | null;
  readonly updatedAt?: string;
  readonly emailCollected: false;
  readonly photosCollected: false;
}

// 최근 7일 값은 첫 쪽에만, 데모·이전 서버에는 없음. null은 조회 실패(oldestUnprocessedAt은 미처리 없음도 null)
export type InquiryCounts = Readonly<Record<InquiryStatus, number>> & {
  readonly receivedLast7d?: number | null;
  readonly resolvedLast7d?: number | null;
  readonly oldestUnprocessedAt?: string | null;
};

export interface InquiryPage {
  readonly items: readonly InquirySummary[];
  readonly nextCursor: string | null;
  // 첫 쪽에만 옴
  readonly counts?: InquiryCounts;
}

type Token = () => Promise<string | null>;

// 서버 필터 조건(#491, services/src/admin/inquiry-list.ts). from·to는 포함 경계인 UTC ISO 시각
// 조건이 있으면 서버가 쪽마다 정해진 후보만 읽어 거르므로 항목이 0개여도 nextCursor가 있으면 이어 읽음
// 다음 쪽에도 같은 값을 보냄(cursor가 조건에 묶여 있어 다르면 서버가 400)
export interface InquiryServerQuery {
  readonly q?: string;
  readonly type?: string;
  readonly beachId?: string;
  readonly from?: string;
  readonly to?: string;
}

export function fetchInquiries(
  accessToken: Token,
  query: {
    status?: InquiryStatus;
    cursor?: string;
    limit?: number;
    filters?: InquiryServerQuery;
    // 본문 미리보기 요청(보기 권한은 서버가 restricted로 뺌)
    preview?: boolean;
  },
): Promise<OpsResult<InquiryPage>> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  for (const key of ["q", "type", "beachId", "from", "to"] as const) {
    const value = query.filters?.[key];
    if (value !== undefined) params.set(key, value);
  }
  if (query.preview) params.set("preview", "true");
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", String(query.limit ?? PAGE_SIZE));
  return opsFetch<InquiryPage>(`/ops/inquiries?${params}`, accessToken);
}

export function fetchInquiry(
  accessToken: Token,
  inquiryId: string,
): Promise<OpsResult<InquiryDetail>> {
  return opsFetch<InquiryDetail>(
    `/ops/inquiries/${encodeURIComponent(inquiryId)}`,
    accessToken,
  );
}

// 처리 상태·반려 이유·내부 메모 저장(편집 이상). 서버 상한과 같음(services/src/admin/inquiries.ts)
export const REJECT_REASON_MAX = 500;
export const MEMO_MAX = 2000;

export interface InquiryPatch {
  // 상세(강한 일관성)에서 받은 version. 목록 version은 늦을 수 있어 쓰지 않음
  readonly version: number;
  readonly status?: InquiryStatus;
  readonly memo?: string | null;
  readonly rejectReason?: string;
  readonly redactions?: readonly Redaction[];
}

// 개인정보 가리기(화면 설계서 6장 ADM-INQ). 가린 자리는 서버가 이 표시로 바꿈(services/src/admin/inquiries.ts)
export const REDACTION_MARK = "[가림]";

// 저장된 본문의 UTF-16 위치(끝 미포함)와 그 자리 글. 서버가 글이 맞는지 다시 확인함
export interface Redaction {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

// textarea는 줄바꿈(\r\n·\r)을 \n으로 바꿔 보여 줌 → 화면에서 고른 위치를 원래 본문 위치로 되돌림
export function linesNormalized(message: string): string {
  return message.replace(/\r\n?/g, "\n");
}

export function redactionOf(
  message: string,
  shownStart: number,
  shownEnd: number,
): Redaction | null {
  const toOriginal = (shown: number) => {
    let at = 0;
    for (let i = 0; i < shown && at < message.length; i++) {
      at += message[at] === "\r" && message[at + 1] === "\n" ? 2 : 1;
    }
    return at;
  };
  let start = toOriginal(Math.min(shownStart, shownEnd));
  let end = toOriginal(Math.max(shownStart, shownEnd));
  // 앞뒤 공백은 빼고 가림(가린 표시 양옆 띄어쓰기를 지키려고)
  while (start < end && /\s/.test(message[start]!)) start++;
  while (end > start && /\s/.test(message[end - 1]!)) end--;
  if (start === end) return null;
  return { start, end, text: message.slice(start, end) };
}

// 같은 내용을 다시 보낼 때(응답을 못 받음)는 같은 멱등 키를 씀 → 서버가 한 번만 저장하고 같은 결과를 줌(D16-B6)
export function saveInquiry(
  accessToken: Token,
  inquiryId: string,
  patch: InquiryPatch,
  idempotencyKey: string,
): Promise<OpsResult<{ inquiryId: string; version: number }>> {
  return opsFetch(
    `/ops/inquiries/${encodeURIComponent(inquiryId)}`,
    accessToken,
    { method: "PATCH", body: patch, idempotencyKey },
  );
}

// 화면 시각은 KST(저장은 UTC ISO, 구현 제안 I09)
const KST = "Asia/Seoul";

export function kstDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

// 보관 기한 날짜(KST 월/일). 서버 TTL은 받은 시각 + 90일(services/src/inquiry/policy.ts ttlAfterDays)
export function retentionDate(receivedAt: string): string {
  const received = new Date(receivedAt);
  const end = new Date(received.getTime() + RETENTION_DAYS * 86_400_000);
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST,
    month: "numeric",
    day: "numeric",
  }).formatToParts(end);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}/${get("day")}`;
}

// 접수 ID 줄임(시안 '3f2a…9c'). 전체 ID는 화면 읽기·복사용으로 따로 둠
export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-2)}` : id;
}

// 목록 행 내용 미리보기 줄: 줄바꿈·연속 공백을 한 칸으로 줄이고 코드 포인트 단위로 자름
export function previewText(
  message: string | undefined | null,
  maxChars = 42,
): string | null {
  if (!message) return null;
  const normalized = message.replace(/\s+/g, " ").trim();
  if (normalized === "") return null;
  const chars = [...normalized];
  if (chars.length <= maxChars) return normalized;
  return `${chars.slice(0, maxChars).join("").trimEnd()}…`;
}

export const BEACH_NONE = "__none__" as const;

export type ReceivedPreset = "today" | "7d" | "30d" | "custom";

export interface ReceivedFilter {
  readonly preset: ReceivedPreset;
  // KST 입력값(YYYY-MM-DDTHH:mm)
  readonly from?: string;
  readonly to?: string;
}

export interface InquiryFilter {
  readonly query: string;
  readonly type: string | null;
  readonly beach: string | null;
  readonly received: ReceivedFilter | null;
}

export const EMPTY_INQUIRY_FILTER: InquiryFilter = {
  query: "",
  type: null,
  beach: null,
  received: null,
};

export function isReceivedFilterActive(
  received: ReceivedFilter | null,
): boolean {
  if (received === null) return false;
  if (received.preset !== "custom") return true;
  // 형식이 틀린 입력도 켜진 조건으로 봄(틀렸다는 안내가 보이게, 조용히 조건 없음이 되지 않게)
  return (
    parseKstInput(received.from).kind !== "empty" ||
    parseKstInput(received.to).kind !== "empty"
  );
}

// 형식이 틀렸거나 시작이 끝보다 늦으면 true
export function isReceivedRangeInvalid(
  received: Pick<ReceivedFilter, "preset" | "from" | "to"> | null,
): boolean {
  if (received === null || received.preset !== "custom") return false;
  // 실제로 거르는 경계(날짜만 입력한 끝은 그날 끝까지)와 같은 값으로 비교함
  const range = receivedRangeMs(received, new Date());
  if (range === null) return true;
  const { fromMs, toMs } = range;
  return fromMs !== null && toMs !== null && fromMs > toMs;
}

export function hasActiveInquiryFilter(filter: InquiryFilter): boolean {
  return (
    filter.query.trim() !== "" ||
    filter.type !== null ||
    filter.beach !== null ||
    isReceivedFilterActive(filter.received)
  );
}

// KST(UTC+9) 날짜(YYYY-MM-DD) 문자열
export function kstDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isKstToday(iso: string, now: Date = new Date()): boolean {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  return kstDateKey(new Date(ms)) === kstDateKey(now);
}

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

type KstInput =
  | { readonly kind: "empty" }
  | { readonly kind: "invalid" }
  // ms: 입력한 시각(UTC ms) · span: 입력 단위 길이(날짜 하루·분 1분·초 1초). 끝 경계는 ms + span - 1
  | { readonly kind: "ok"; readonly ms: number; readonly span: number };

// KST 입력값(YYYY-MM-DD · YYYY-MM-DDTHH:mm · YYYY-MM-DDTHH:mm:ss)만 받음
// 다른 형식은 실행 환경 시간대로 해석될 수 있어 받지 않고, 달력에 없는 날짜(2월 31일 등)도 넘기지 않음
function parseKstInput(value: string | undefined): KstInput {
  const text = value?.trim() ?? "";
  if (text === "") return { kind: "empty" };
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(
    text,
  );
  if (!m) return { kind: "invalid" };
  const [y, mo, d, h = 0, mi = 0, s = 0] = m
    .slice(1)
    .map((part) => (part === undefined ? undefined : Number(part)));
  const local = Date.UTC(y!, mo! - 1, d!, h, mi, s);
  const back = new Date(local);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo! - 1 ||
    back.getUTCDate() !== d ||
    back.getUTCHours() !== h ||
    back.getUTCMinutes() !== mi ||
    back.getUTCSeconds() !== s
  ) {
    return { kind: "invalid" };
  }
  const span =
    m[4] === undefined ? DAY_MS : m[6] === undefined ? 60_000 : 1_000;
  return { kind: "ok", ms: local - KST_OFFSET_MS, span };
}

// 그 시각이 속한 KST 날의 자정(UTC ms)
function kstDayStartMs(ms: number): number {
  return Math.floor((ms + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
}

// 받은 시각 조건의 포함 경계(UTC ms). fromMs·toMs의 null은 그쪽 경계 없음
// 함수 결과 null은 직접 입력한 값이 형식에 맞지 않음(경계를 조용히 버리지 않고 틀린 조건으로 봄)
// 오늘은 KST 자정부터 다음 날 자정 직전까지. 끝은 입력한 단위의 끝까지 포함:
// 날짜만이면 그날 자정 직전, 분까지(datetime-local)면 그 분의 59.999초(09:00까지 → 09:00:30 포함)
export function receivedRangeMs(
  filter: ReceivedFilter,
  now: Date,
): { readonly fromMs: number | null; readonly toMs: number | null } | null {
  const nowMs = now.getTime();
  if (filter.preset === "today") {
    const start = kstDayStartMs(nowMs);
    return { fromMs: start, toMs: start + DAY_MS - 1 };
  }
  if (filter.preset === "7d")
    return { fromMs: nowMs - 7 * DAY_MS, toMs: nowMs };
  if (filter.preset === "30d") {
    return { fromMs: nowMs - 30 * DAY_MS, toMs: nowMs };
  }
  const from = parseKstInput(filter.from);
  const to = parseKstInput(filter.to);
  if (from.kind === "invalid" || to.kind === "invalid") return null;
  return {
    fromMs: from.kind === "ok" ? from.ms : null,
    toMs: to.kind === "ok" ? to.ms + to.span - 1 : null,
  };
}

function matchesReceived(
  receivedAt: string,
  filter: ReceivedFilter,
  now: Date,
): boolean {
  const ms = Date.parse(receivedAt);
  if (!Number.isFinite(ms)) return false;
  const range = receivedRangeMs(filter, now);
  // 형식이 틀린 조건은 아무것도 맞지 않음(조건 없이 전체를 보여 주지 않음)
  if (range === null) return false;
  const { fromMs, toMs } = range;
  if (fromMs !== null && ms < fromMs) return false;
  if (toMs !== null && ms > toMs) return false;
  return true;
}

// 서버 검색어 상한(services/src/admin/inquiry-list.ts MAX_SEARCH_LENGTH, 코드 포인트 기준)
export const INQUIRY_SEARCH_MAX = 100;
const SERVER_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// 화면 조건 → 서버 요청 조건. 넘기면 서버가 400을 주는 값은 보내지 않고 이유를 돌려줌(잘라서 보내지 않음)
// now는 조건을 바꾼 시각으로 고정해 다음 쪽에도 같은 값을 보냄(7일·30일은 now 기준)
export function inquiryServerQuery(
  filter: InquiryFilter,
  now: Date,
):
  | { readonly ok: true; readonly query: InquiryServerQuery }
  | {
      readonly ok: false;
      readonly invalid: "query" | "type" | "beach" | "received";
    } {
  const q = filter.query.trim();
  if ([...q].length > INQUIRY_SEARCH_MAX)
    return { ok: false, invalid: "query" };
  // 서버 형식(services/src/admin/inquiry-list.ts parseInquiryFilters)과 같은 값만 보냄
  if (filter.type !== null && !/^[a-z][a-z0-9_]{0,63}$/.test(filter.type)) {
    return { ok: false, invalid: "type" };
  }
  if (
    filter.beach !== null &&
    filter.beach !== BEACH_NONE &&
    !/^b\d{4}$/.test(filter.beach)
  ) {
    return { ok: false, invalid: "beach" };
  }
  if (isReceivedRangeInvalid(filter.received)) {
    return { ok: false, invalid: "received" };
  }
  const range =
    filter.received === null
      ? { fromMs: null, toMs: null }
      : receivedRangeMs(filter.received, now);
  if (range === null) return { ok: false, invalid: "received" };
  // 서버는 4자리 연도 UTC 시각만 받음(utcInstant). 연도를 5자리로 잘못 넣은 값 등은 보내지 않음
  const iso = (ms: number | null | undefined): string | undefined | null => {
    if (ms === null || ms === undefined) return undefined;
    const date = new Date(ms);
    if (!Number.isFinite(date.getTime())) return null;
    const text = date.toISOString();
    return SERVER_UTC_INSTANT.test(text) ? text : null;
  };
  const from = iso(range?.fromMs);
  const to = iso(range?.toMs);
  if (from === null || to === null) return { ok: false, invalid: "received" };
  return {
    ok: true,
    query: {
      ...(q !== "" ? { q } : {}),
      ...(filter.type !== null ? { type: filter.type } : {}),
      ...(filter.beach !== null ? { beachId: filter.beach } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    },
  };
}

// 받은 목록을 화면 조건(내용·해변 검색, 유형, 해변, 받은 시각)으로 거름
// 서버 요약(GET /ops/inquiries)에 없는 본문은 이미 열어 본 상세 캐시(messages)가 있을 때만 함께 찾음
export function filterInquiries<T extends InquirySummary>(
  items: readonly T[],
  filter: InquiryFilter,
  options: {
    readonly beachName: (beachId: string) => string;
    readonly typeLabel: (type: string) => string;
    readonly activityLabel?: (activity: string) => string;
    readonly messages?: Readonly<Record<string, string>>;
    readonly now?: Date;
  },
): T[] {
  const q = filter.query.trim().toLowerCase();
  const now = options.now ?? new Date();
  return items.filter((item) => {
    if (filter.type !== null && item.type !== filter.type) return false;
    if (filter.beach !== null) {
      if (filter.beach === BEACH_NONE) {
        if (item.beachId) return false;
      } else if (item.beachId !== filter.beach) {
        return false;
      }
    }
    if (
      filter.received !== null &&
      !matchesReceived(item.receivedAt, filter.received, now)
    ) {
      return false;
    }
    if (q !== "") {
      const candidates = [
        options.typeLabel(item.type),
        item.beachId ?? "",
        item.beachId ? options.beachName(item.beachId) : "",
        item.activity && options.activityLabel
          ? options.activityLabel(item.activity)
          : (item.activity ?? ""),
        item.inquiryId,
        shortId(item.inquiryId),
        options.messages?.[item.inquiryId] ?? "",
      ];
      if (!candidates.some((c) => c.toLowerCase().includes(q))) return false;
    }
    return true;
  });
}
