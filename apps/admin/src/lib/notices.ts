import type { Notice } from "@baradun/contracts";
import {
  checkNoticePhrases,
  graphemeLength,
  NOTICE_TEXT_MAX,
  type NoticePhraseCategory,
} from "@baradun/contracts/notice-rules";
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

// 글자 수 상한(D16-D2·D20-20, 넘으면 잘라 내지 않고 확정을 막음)·표현 검사 목록(D17-8)은
// 운영 API와 같은 값을 쓰도록 계약 패키지(@baradun/contracts/notice-rules) 한 곳에 둠

export const NOTICE_STATES = ["live", "scheduled", "draft", "ended"] as const;
export type NoticeState = (typeof NOTICE_STATES)[number];

export interface NoticeView {
  readonly id: string;
  readonly version: number;
  readonly draft: NoticeContent;
  readonly live: NoticeContent | null;
  readonly exposedAt: string | null;
  readonly updatedAt: string;
  // 서버 응답에 수정자 이메일·표시 이름이 오면 '누가 · 언제'로 보여 줌
  readonly updatedBy?: string | null;
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

// ---- 확정 전 확인 (서버 exposeProblem과 같은 규칙, D16-D1·D2·B3) ----

export type TextField = `${"title" | "body"}.${"ko" | "en"}`;

export type NoticeProblem =
  | {
      readonly field: TextField | "startsAt" | "endsAt";
      readonly reason: "required" | "too_long" | "order" | "invalid";
    }
  | {
      readonly field: TextField;
      readonly reason: "blocked_phrase";
      // 문구에서 맞은 부분과 묶음(안전 보장·이용 판단·추천·점수)
      readonly text: string;
      readonly category: NoticePhraseCategory;
    };

// 문맥 확인 표현(D16-D1 경고). 확정은 막지 않음
export interface NoticeWarning {
  readonly field: TextField;
  readonly text: string;
}

export type NoticeTexts = Pick<NoticeContent, "title" | "body">;

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

// 문구만으로 하는 확인(시각이 틀려 내용을 못 만들 때도 씀). 칸마다 표현 검사는 한 번만 함
// - problems: 확정을 막는 것(한·영 빈칸, 글자 수 넘침, 차단 표현)
// - warnings: 문맥 확인 표현(D16-D1 경고). 확정은 막지 않음
export function textChecks(texts: NoticeTexts): {
  problems: NoticeProblem[];
  warnings: NoticeWarning[];
} {
  const problems: NoticeProblem[] = [];
  const warnings: NoticeWarning[] = [];
  for (const name of ["title", "body"] as const) {
    for (const lang of ["ko", "en"] as const) {
      const field = `${name}.${lang}` as const;
      const text = texts[name][lang];
      if (text.trim() === "") {
        problems.push({ field, reason: "required" });
        continue;
      }
      if (graphemeLength(text) > NOTICE_TEXT_MAX[name][lang]) {
        problems.push({ field, reason: "too_long" });
      }
      const { blocked, warned } = checkNoticePhrases(text);
      for (const hit of blocked) {
        problems.push({
          field,
          reason: "blocked_phrase",
          text: hit.text,
          category: hit.category,
        });
      }
      for (const hit of warned) warnings.push({ field, text: hit.text });
    }
  }
  return { problems, warnings };
}

// 기간 확인: 끝이 시작 앞이거나 이미 지나면 확정을 막음
export function periodProblems(
  content: NoticeContent,
  now: number,
): NoticeProblem[] {
  return content.endsAt !== null &&
    (Date.parse(content.endsAt) <= Date.parse(content.startsAt) ||
      Date.parse(content.endsAt) <= now)
    ? [{ field: "endsAt", reason: "order" }]
    : [];
}

// 확정을 막는 것: 문구 문제(textChecks)와 기간 문제(periodProblems)
export function exposeProblems(
  content: NoticeContent,
  now: number,
): NoticeProblem[] {
  return [...textChecks(content).problems, ...periodProblems(content, now)];
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

// 목록 거르기(상태 탭 · 종류 · 제목/문구 찾기)
export function filterNotices(
  items: readonly NoticeView[],
  options: {
    state: NoticeState | null;
    kind: NoticeKind | null;
    query: string;
  },
): NoticeView[] {
  const q = options.query.trim().toLowerCase();
  return items.filter((n) => {
    if (options.state !== null && n.state !== options.state) return false;
    const shown = n.live ?? n.draft;
    if (options.kind !== null && shown.kind !== options.kind) return false;
    if (q !== "") {
      const hay = [
        n.draft.title.ko,
        n.draft.title.en,
        n.draft.body.ko,
        n.draft.body.en,
        n.live?.title.ko ?? "",
        n.live?.title.en ?? "",
        n.live?.body.ko ?? "",
        n.live?.body.en ?? "",
      ];
      if (!hay.some((s) => s.toLowerCase().includes(q))) return false;
    }
    return true;
  });
}
