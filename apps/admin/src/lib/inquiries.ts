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
export const PAGE_SIZE = 20;

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

export type InquiryCounts = Readonly<Record<InquiryStatus, number>>;

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
