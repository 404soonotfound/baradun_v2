import { opsFetch, type OpsResult } from "./auth/ops-fetch";

// 운영자 변경 이력 화면이 쓰는 운영 API 모양 (BRD-155). services/src/admin/audit.ts 응답과 같음
// - 바뀐 항목 이름과 처리 상태 앞·뒤만 있음. 문의 본문·메모·반려 이유·공지 문구 값은 없음(D16-B5)
// - 시각은 UTC(Z)로 주고받고 화면에서 KST로 보여 줌(구현 제안 I09)

export const AUDIT_ACTIONS = [
  "inquiry.update",
  "notice.create",
  "notice.update",
  "notice.expose",
  "notice.end",
  "notice.delete",
  "sample.read",
  "sample.denied",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: unknown): value is AuditAction {
  return (AUDIT_ACTIONS as readonly unknown[]).includes(value);
}

export interface AuditView {
  readonly at: string;
  readonly actorSub: string;
  readonly actorKind: "operator" | "sample";
  // 서버가 새 값을 더해도 숨기지 않게 넓게 받음
  readonly role: string;
  readonly action: AuditAction | string;
  readonly target: { readonly kind: string; readonly id: string };
  readonly changes: readonly string[];
  readonly statusFrom?: string;
  readonly statusTo?: string;
  readonly requestId: string;
}

export interface AuditFilter {
  readonly from: string;
  readonly to: string;
  readonly action?: AuditAction;
  readonly actor?: string;
}

export interface AuditPage {
  readonly filter: AuditFilter;
  readonly items: readonly AuditView[];
  readonly nextCursor: string | null;
}

// 기간 고르기(서버 최대 366일)
export const AUDIT_PERIODS = [7, 30, 90, 365] as const;
export type AuditPeriod = (typeof AUDIT_PERIODS)[number];

const DAY_MS = 86_400_000;

export function periodFilter(
  days: AuditPeriod,
  now: number,
  action: AuditAction | null,
  actor: string | null,
): AuditFilter {
  return {
    from: new Date(now - days * DAY_MS).toISOString(),
    to: new Date(now).toISOString(),
    ...(action ? { action } : {}),
    ...(actor ? { actor } : {}),
  };
}

// 다음 쪽은 cursor만 보냄(서버가 cursor에 담긴 필터를 씀)
export function fetchAudit(
  accessToken: () => Promise<string | null>,
  filter: AuditFilter,
  cursor: string | null,
): Promise<OpsResult<AuditPage>> {
  const params = new URLSearchParams(
    cursor
      ? { cursor }
      : {
          from: filter.from,
          to: filter.to,
          ...(filter.action ? { action: filter.action } : {}),
          ...(filter.actor ? { actor: filter.actor } : {}),
        },
  );
  return opsFetch(`/ops/audit?${params.toString()}`, accessToken);
}

// 운영자 sub 줄임(이름은 기록에 없음). 전체 값은 title로 둠
export function shortSub(sub: string): string {
  return sub.length > 8 ? `${sub.slice(0, 8)}…` : sub;
}

// KST 날짜(월/일) 묶음 키
export function kstDay(iso: string): string {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}/${get("day")}`;
}
