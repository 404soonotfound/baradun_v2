import type { Notice } from "@baradun/contracts";
import { opsFetch, type OpsResult } from "./auth/ops-fetch";
import { kstDateTime } from "./inquiries";

// 운영자 공지 화면이 쓰는 운영 API 모양 (BRD-151). services/src/admin/notices.ts 응답과 같음
// - draft: 저장한 문구(대기본). live: '게시 대상으로 확정'한 사본(다음 게시 때 앱에 나감)
// - 저장·확정 성공은 공개 반영이 아님(D16-D4). 앱 반영은 다음 게시 때
// - 공지는 판단 상태·실제 서비스 점검(maintenance.active)을 바꾸지 않음(D15-6·D16-B3·C6)

export type NoticeKind = Notice["kind"];
export type NoticeContent = Omit<Notice, "id">;
export const NOTICE_KINDS: readonly NoticeKind[] = [
  "general",
  "maintenance_notice",
];

// 노출 전 글자 수 상한(D16-D2 초기값, grapheme 기준). 서버 NOTICE_TEXT_MAX와 같음
// 넘으면 잘라 내지 않고 확정을 막음
export const NOTICE_TEXT_MAX = {
  title: { ko: 40, en: 60 },
  body: { ko: 120, en: 200 },
} as const;
// 초안 저장 상한(서버 NOTICE_DRAFT_TEXT_MAX). 요청 크기만 막음
export const NOTICE_DRAFT_TEXT_MAX = 1000;

export const NOTICE_STATES = ["live", "scheduled", "draft", "ended"] as const;
export type NoticeState = (typeof NOTICE_STATES)[number];

export interface NoticeView {
  readonly id: string;
  readonly version: number;
  readonly draft: NoticeContent;
  readonly live: NoticeContent | null;
  readonly exposedAt: string | null;
  readonly updatedAt: string;
  // 서버가 새 상태를 더해도 숨기지 않게 넓게 받음
  readonly state: NoticeState | string;
  // 저장한 문구가 노출본과 다름(D16-D4 '수정 대기')
  readonly pendingEdit: boolean;
  // 노출 구간 안이지만 한 자리 규칙에서 밀림(D16-D4 '가려짐')
  readonly hidden: boolean;
}

export function isNoticeState(value: unknown): value is NoticeState {
  return (NOTICE_STATES as readonly unknown[]).includes(value);
}

type Token = () => Promise<string | null>;
type Written = { noticeId: string; version: number };

export function fetchNotices(
  accessToken: Token,
): Promise<OpsResult<{ items: NoticeView[] }>> {
  return opsFetch("/ops/notices", accessToken);
}

// 같은 내용을 다시 보낼 때(응답을 못 받음)는 같은 멱등 키를 씀 → 서버가 한 번만 저장(D16-B6)
export function createNotice(
  accessToken: Token,
  content: NoticeContent,
  idempotencyKey: string,
): Promise<OpsResult<Written>> {
  return opsFetch("/ops/notices", accessToken, {
    method: "POST",
    body: content,
    idempotencyKey,
  });
}

export function updateNotice(
  accessToken: Token,
  id: string,
  version: number,
  content: NoticeContent,
  idempotencyKey: string,
): Promise<OpsResult<Written>> {
  return opsFetch(`/ops/notices/${encodeURIComponent(id)}`, accessToken, {
    method: "PUT",
    body: { version, ...content },
    idempotencyKey,
  });
}

// 확정(expose)·노출 종료(end)·삭제는 본문 { version }만
export function noticeAction(
  accessToken: Token,
  id: string,
  action: "expose" | "end" | "delete",
  version: number,
  idempotencyKey: string,
): Promise<OpsResult<Written>> {
  const path = `/ops/notices/${encodeURIComponent(id)}` as const;
  return opsFetch(
    action === "delete" ? path : `${path}/${action}`,
    accessToken,
    {
      method: action === "delete" ? "DELETE" : "POST",
      body: { version },
      idempotencyKey,
    },
  );
}

// ---- 시각: 화면은 KST, 저장은 UTC(Z) (구현 제안 I09) ----

const KST_OFFSET_MS = 9 * 3_600_000;

// <input type="datetime-local"> 값(KST 벽시계)
export function toKstInput(iso: string): string {
  return new Date(Date.parse(iso) + KST_OFFSET_MS).toISOString().slice(0, 16);
}

// KST 벽시계 값 → UTC ISO. 틀린 값이면 null
export function fromKstInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}:00+09:00`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// 노출 기간(KST). 끝이 없으면 openEnd 문구
export function kstRange(
  startsAt: string,
  endsAt: string | null,
  openEnd: string,
): string {
  return `${kstDateTime(startsAt)} ~ ${endsAt ? kstDateTime(endsAt) : openEnd}`;
}

// ---- 확정 전 확인 (서버 exposeProblem과 같은 규칙, D16-D2·B3) ----

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function graphemeLength(text: string): number {
  return [...segmenter.segment(text)].length;
}

export type TextField = `${"title" | "body"}.${"ko" | "en"}`;

export interface NoticeProblem {
  readonly field: TextField | "startsAt" | "endsAt";
  readonly reason: "required" | "too_long" | "order" | "invalid";
}

// 저장을 막는 것: 시각이 틀렸거나 기간이 거꾸로(시안 E5 2). 빈칸·글자 수는 초안이라 저장은 됨(D16-D1)
export function saveProblems(
  startsAt: string | null,
  endsAt: string | null | undefined,
): NoticeProblem[] {
  const problems: NoticeProblem[] = [];
  if (startsAt === null)
    problems.push({ field: "startsAt", reason: "invalid" });
  if (endsAt === undefined)
    problems.push({ field: "endsAt", reason: "invalid" });
  if (
    startsAt !== null &&
    typeof endsAt === "string" &&
    Date.parse(endsAt) <= Date.parse(startsAt)
  ) {
    problems.push({ field: "endsAt", reason: "order" });
  }
  return problems;
}

// 확정을 막는 것: 한·영 빈칸, 글자 수 넘침, 끝이 시작 앞이거나 이미 지남
export function exposeProblems(
  content: NoticeContent,
  now: number,
): NoticeProblem[] {
  const problems: NoticeProblem[] = [];
  for (const name of ["title", "body"] as const) {
    for (const lang of ["ko", "en"] as const) {
      const text = content[name][lang];
      if (text.trim() === "") {
        problems.push({ field: `${name}.${lang}`, reason: "required" });
      } else if (graphemeLength(text) > NOTICE_TEXT_MAX[name][lang]) {
        problems.push({ field: `${name}.${lang}`, reason: "too_long" });
      }
    }
  }
  if (
    content.endsAt !== null &&
    (Date.parse(content.endsAt) <= Date.parse(content.startsAt) ||
      Date.parse(content.endsAt) <= now)
  ) {
    problems.push({ field: "endsAt", reason: "order" });
  }
  return problems;
}

export function sameContent(a: NoticeContent, b: NoticeContent): boolean {
  return (
    a.kind === b.kind &&
    a.title.ko === b.title.ko &&
    a.title.en === b.title.en &&
    a.body.ko === b.body.ko &&
    a.body.en === b.body.en &&
    Date.parse(a.startsAt) === Date.parse(b.startsAt) &&
    (a.endsAt === null
      ? b.endsAt === null
      : b.endsAt !== null && Date.parse(a.endsAt) === Date.parse(b.endsAt))
  );
}
