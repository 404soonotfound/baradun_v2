import { opsFetch, type OpsResult } from "./auth/ops-fetch";
import type { NoticeContent } from "./notices";

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
  "beach.memo",
  // 다른 운영자의 2단계 인증 초기화(#335). 대상은 계정 sub
  "permission.mfa_reset",
  "sample.read",
  "sample.denied",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: unknown): value is AuditAction {
  return (AUDIT_ACTIONS as readonly unknown[]).includes(value);
}

// 화면 탭 분류(시안 4차 V23). 종류 이름 앞부분으로 정함(services/src/admin/audit.ts categoryOf)
export const AUDIT_CATEGORIES = [
  "notice",
  "beach",
  "publish",
  "inquiry",
  "permission",
  "login",
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export type AuditCounts = Readonly<Record<AuditCategory | "all", number>>;

export function categoryOf(action: string): AuditCategory | null {
  const head = action.split(".")[0];
  return (AUDIT_CATEGORIES as readonly unknown[]).includes(head)
    ? (head as AuditCategory)
    : null;
}

export const AUDIT_PAGE_SIZE = 20;

export interface AuditView {
  readonly at: string;
  readonly actorSub: string;
  readonly actorKind: "operator" | "sample";
  // 서버가 새 값을 더해도 숨기지 않게 넓게 받음
  readonly role: string;
  readonly action: AuditAction | string;
  readonly target: { readonly kind: string; readonly id: string };
  // 공지 한국어 제목(문의는 없음)
  readonly targetLabel?: string;
  readonly changes: readonly string[];
  // 공지 문구 앞·뒤(null: 만들기 전·지운 뒤)
  readonly notice?: {
    readonly before: NoticeContent | null;
    readonly after: NoticeContent | null;
  };
  readonly statusFrom?: string;
  readonly statusTo?: string;
  readonly requestId: string;
}

export interface AuditFilter {
  readonly from: string;
  readonly to: string;
  readonly category?: AuditCategory;
  readonly actor?: string;
  readonly q?: string;
}

export interface AuditPage {
  readonly filter: AuditFilter;
  readonly items: readonly AuditView[];
  readonly nextCursor: string | null;
  // 첫 쪽에만(탭 수)
  readonly counts?: AuditCounts;
}

// 기간 고르기(서버 최대 366일)
export const AUDIT_PERIODS = [7, 30, 90, 365] as const;
export type AuditPeriod = (typeof AUDIT_PERIODS)[number];

const DAY_MS = 86_400_000;

export function periodFilter(
  days: AuditPeriod,
  now: number,
  options: {
    readonly category?: AuditCategory | null;
    readonly actor?: string | null;
    readonly q?: string | null;
  } = {},
): AuditFilter {
  const q = options.q?.trim();
  return {
    from: new Date(now - days * DAY_MS).toISOString(),
    to: new Date(now).toISOString(),
    ...(options.category ? { category: options.category } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
    ...(q ? { q } : {}),
  };
}

// 다음 쪽은 cursor만 보냄(서버가 cursor에 담긴 필터를 씀)
// withCounts=false: 탭 수를 다시 세지 않음(같은 거르기의 수를 이미 가짐, 분류 탭만 바꿀 때)
export function fetchAudit(
  accessToken: () => Promise<string | null>,
  filter: AuditFilter,
  cursor: string | null,
  withCounts = true,
): Promise<OpsResult<AuditPage>> {
  const params = new URLSearchParams(
    cursor
      ? { cursor, limit: String(AUDIT_PAGE_SIZE) }
      : {
          from: filter.from,
          to: filter.to,
          limit: String(AUDIT_PAGE_SIZE),
          ...(filter.category ? { category: filter.category } : {}),
          ...(filter.actor ? { actor: filter.actor } : {}),
          ...(filter.q ? { q: filter.q } : {}),
          ...(withCounts ? {} : { counts: "0" }),
        },
  );
  return opsFetch(`/ops/audit?${params.toString()}`, accessToken);
}

// 운영자 sub 줄임(이름은 기록에 없음). 전체 값은 title로 둠
export function shortSub(sub: string): string {
  return sub.length > 8 ? `${sub.slice(0, 8)}…` : sub;
}

// ---- 공지 문구 바뀐 내용(시안 V23 펼치기) ----

export interface DiffLine {
  readonly kind: "same" | "del" | "add";
  readonly oldNo: number | null;
  readonly newNo: number | null;
  readonly text: string;
}

// 공지를 줄로 펼침. 시안 V23의 줄 순서(종류·위치·제목·내용·기간)
export function noticeLines(
  content: NoticeContent | null,
  labels: {
    readonly kind: (kind: string) => string;
    readonly placement: string;
    readonly none: string;
    readonly period: (startsAt: string, endsAt: string | null) => string;
  },
): string[] {
  if (!content) return [];
  const text = (v: string) => (v.trim() === "" ? labels.none : v);
  return [
    `kind: ${labels.kind(content.kind)}`,
    `placement: ${labels.placement}`,
    `title.ko: ${text(content.title.ko)}`,
    `title.en: ${text(content.title.en)}`,
    `body.ko: ${text(content.body.ko)}`,
    `body.en: ${text(content.body.en)}`,
    `period: ${labels.period(content.startsAt, content.endsAt)}`,
  ];
}

// 같은 자리 줄끼리 비교(줄 수가 고정이라 위치로 맞춤). 없는 쪽(만들기·지우기)은 모두 더함·뺌
export function diffLines(before: string[], after: string[]): DiffLine[] {
  const out: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  const rows = Math.max(before.length, after.length);
  for (let i = 0; i < rows; i++) {
    const b = before[i];
    const a = after[i];
    if (b !== undefined && a !== undefined && b === a) {
      out.push({ kind: "same", oldNo: ++oldNo, newNo: ++newNo, text: a });
      continue;
    }
    if (b !== undefined) {
      out.push({ kind: "del", oldNo: ++oldNo, newNo: null, text: b });
    }
    if (a !== undefined) {
      out.push({ kind: "add", oldNo: null, newNo: ++newNo, text: a });
    }
  }
  return out;
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
