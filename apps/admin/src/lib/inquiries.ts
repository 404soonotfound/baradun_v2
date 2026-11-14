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

export function fetchInquiries(
  accessToken: Token,
  query: { status?: InquiryStatus; cursor?: string; limit?: number },
): Promise<OpsResult<InquiryPage>> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
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

export function isReceivedFilterActive(received: ReceivedFilter | null): boolean {
  if (received === null) return false;
  if (received.preset !== "custom") return true;
  return (
    parseKstInputMs(received.from) !== null ||
    parseKstInputMs(received.to) !== null
  );
}

export function isReceivedRangeInvalid(
  received: Pick<ReceivedFilter, "preset" | "from" | "to"> | null,
): boolean {
  if (received === null || received.preset !== "custom") return false;
  const fromMs = parseKstInputMs(received.from);
  const toMs = parseKstInputMs(received.to);
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

function parseKstInputMs(value: string | undefined): number | null {
  if (!value || value.trim() === "") return null;
  const trimmed = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00+09:00`
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)
      ? `${trimmed}:00+09:00`
      : trimmed;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function matchesReceived(
  receivedAt: string,
  filter: ReceivedFilter,
  now: Date,
): boolean {
  const ms = Date.parse(receivedAt);
  if (!Number.isFinite(ms)) return false;
  if (filter.preset === "today") {
    return kstDateKey(new Date(ms)) === kstDateKey(now);
  }
  if (filter.preset === "7d") {
    return ms >= now.getTime() - 7 * 86_400_000 && ms <= now.getTime();
  }
  if (filter.preset === "30d") {
    return ms >= now.getTime() - 30 * 86_400_000 && ms <= now.getTime();
  }
  const fromMs = parseKstInputMs(filter.from);
  const toMs = parseKstInputMs(filter.to);
  if (fromMs === null && toMs === null) return true;
  if (fromMs !== null && ms < fromMs) return false;
  if (toMs !== null && ms > toMs) return false;
  return true;
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
    if (filter.received !== null && !matchesReceived(item.receivedAt, filter.received, now)) {
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
