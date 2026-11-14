import type { Reason } from "@baradun/contracts";
import type { OpsResult } from "./auth/ops-fetch";
import { reasonLabels, type BadgeLabel, type PublishedView } from "./beaches";
import {
  SOURCE_ROWS,
  sourceState,
  successRate,
  sumCounts,
  type CollectionJobId,
  type CollectionView,
  type SourceState,
} from "./collection";
import type { InquiryPage } from "./inquiries";
import { LOADING_TIMES, withTimeout } from "./loading-timing";
import type { NoticeView } from "./notices";

// 운영 홈 (BRD-149, 화면 설계서 6장 ADM-HOME). 이미 있는 운영 API 응답을 모아 요약만 계산함
// - 판단 출처 상태 한 줄: 판단에 쓰는 출처(특보·해양 관측)가 하나라도 정상이 아니면 문제 줄
// - 요약 카드: 새 문의 수 · 판단불가 해변 수 · 지금 게시본 시각과 대기 공지 · 최근 30분 사용자(이용 통계 연결 뒤)
// - 할 일: 처리할 게 있을 때만 줄. 하나라도 불러오지 못하면 '할 일 없음'으로 보이지 않게 함
// - 못 읽은 값은 0·정상으로 바꾸지 않고 null('확인 못 함')

// 판단에 쓰는 출처 줄(화면 순서 그대로)
export const JUDGMENT_JOBS: readonly CollectionJobId[] = SOURCE_ROWS.filter(
  (row) => row.judgment,
).map((row) => row.job);

export interface JudgmentSource {
  readonly job: CollectionJobId;
  readonly state: SourceState;
}

// null: 수집 현황을 불러오지 못함('정상'이 아님)
export interface JudgmentLine {
  readonly sources: readonly JudgmentSource[];
  // 정상(ok)이 아닌 출처. 지연·지연 확인 못 함·기록 없음도 문제로 봄(앱 표시가 바뀔 수 있음)
  readonly problems: readonly JudgmentSource[];
}

export function judgmentLine(view: CollectionView | null): JudgmentLine | null {
  if (!view) return null;
  const sources = JUDGMENT_JOBS.map((job) => ({
    job,
    // 응답에 출처가 빠지면 sourceState가 '기록 없음'(정상 아님)
    state: sourceState(view.jobs.find((j) => j.job === job)),
  }));
  return { sources, problems: sources.filter((s) => s.state !== "ok") };
}

// 앱에 보이는 해변 칸(보드 V1 '앱에 보이는 해변'): 게시본의 분류별 해변 수. 게시본을 읽지 못하면 null
// 분류는 게시본 값 그대로 셈(화면에서 다시 분류하지 않음, G1)
export interface BeachCounts {
  readonly total: number;
  readonly clear: number;
  readonly unavailable: number;
  readonly undetermined: number;
}

export function beachCounts(view: PublishedView | null): BeachCounts | null {
  if (!view || !view.available) return null;
  const counts = { total: 0, clear: 0, unavailable: 0, undetermined: 0 };
  for (const entry of Object.values(view.beaches)) {
    counts.total += 1;
    counts[entry.category] += 1;
  }
  return counts;
}

// 판단불가 해변 표 한 줄(보드 V1 '판단불가 해변'). 배지는 게시본 사유 전부(숨기지 않음), 범위·시각은 첫 사유
export interface UndeterminedRow {
  readonly id: string;
  // 공개 해변 데이터 이름표에 없으면 null → 화면은 '이름 확인 못 함'(ID를 이름처럼 보이지 않음)
  readonly name: string | null;
  readonly region: string | null;
  // 배지(사유 먼저): 게시본 사유 순서 그대로 전부. 사유가 없거나 모르는 code면 '특보 확인 못 함'
  readonly labels: readonly BadgeLabel[];
  // 첫 사유 원본(범위·기관·시각). 사유가 없으면 null
  readonly reason: Partial<Reason> | null;
}

export function undeterminedRows(
  view: PublishedView | null,
  names: Readonly<Record<string, { readonly name: string; readonly region: string }>>,
): UndeterminedRow[] | null {
  if (!view || !view.available) return null;
  return Object.entries(view.beaches)
    .filter(([, entry]) => entry.category === "undetermined")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, entry]) => {
      // 'constructor' 같은 ID가 객체 기본 속성을 집지 않게 자기 키만 봄
      const info = Object.hasOwn(names, id) ? names[id] : undefined;
      return {
        id,
        name: info?.name ?? null,
        region: info?.region ?? null,
        labels: reasonLabels(entry),
        reason: entry.reasons[0] ?? null,
      };
    });
}

// 사유 칸의 시각 종류: 특보 확인 못 함은 마지막 확인 시각, 관측 지연은 마지막 측정 시각
// 시각이 없거나 읽을 수 없으면 null(지금 시각 등으로 채우지 않음)
export function reasonTime(
  reason: Partial<Reason> | null,
): { kind: "confirmed" | "observed"; at: string } | null {
  if (!reason || typeof reason.at !== "string") return null;
  if (Number.isNaN(Date.parse(reason.at))) return null;
  if (reason.code === "warning_unknown") {
    return { kind: "confirmed", at: reason.at };
  }
  if (reason.code === "observation_delayed") {
    return { kind: "observed", at: reason.at };
  }
  return null;
}

// 수집 칸(보드 V1 '수집'): 보여 줄 출처 줄(보드 순서: 해상 특보 · 해양 관측 · 이안류)
export const HOME_COLLECTION_JOBS: readonly CollectionJobId[] = [
  "collect-warnings",
  "collect-ocean",
  "collect-rip",
];

export interface CollectionRow {
  readonly job: CollectionJobId;
  // 응답에 이 출처가 있음. 없으면 성공률을 '실행 없음'이 아니라 '확인 못 함'으로 보임
  readonly found: boolean;
  readonly state: SourceState;
  // 최근 24시간 성공률(%). 실행이 없거나 출처가 응답에 없으면 null
  readonly rate: number | null;
  readonly lastSuccessAt: string | null;
}

export interface CollectionSummary {
  // 수집 현황의 모든 출처(SOURCE_ROWS) 중 정상이 아닌 출처 수. 보이지 않는 줄의 문제도 셈
  readonly problems: number;
  // 응답에 모든 출처가 있음. false면 합친 성공률은 '확인 못 함'(실행 없음이 아님)
  readonly complete: boolean;
  // 모든 출처를 더한 최근 24시간 성공률. 실행이 없거나 응답에 빠진 출처가 있으면 null(남은 출처만으로 셈하지 않음)
  readonly rate: number | null;
  readonly rows: readonly CollectionRow[];
}

export function collectionSummary(
  view: CollectionView | null,
): CollectionSummary | null {
  if (!view) return null;
  const find = (job: CollectionJobId) => view.jobs.find((j) => j.job === job);
  const all = SOURCE_ROWS.map((row) => find(row.job));
  const complete = all.every((j) => j !== undefined);
  return {
    problems: all.filter((job) => sourceState(job) !== "ok").length,
    complete,
    rate: complete ? successRate(sumCounts(all.map((j) => j!.day))) : null,
    rows: HOME_COLLECTION_JOBS.map((job) => {
      const found = find(job);
      return {
        job,
        found: found !== undefined,
        state: sourceState(found),
        rate: found ? successRate(found.day) : null,
        lastSuccessAt: found?.lastSuccessAt ?? null,
      };
    }),
  };
}

// 문의 칸(보드 V1 '문의'): 처리 상태별 수(보관 중인 문의 전체, 서버 counts). 하나라도 숫자가 아니면 null
export interface InquirySummary {
  readonly total: number;
  readonly received: number;
  readonly inProgress: number;
  readonly resolved: number;
  readonly rejected: number;
}

export function inquirySummary(page: InquiryPage | null): InquirySummary | null {
  const c = page?.counts;
  if (!c) return null;
  const values = [c.received, c.in_progress, c.resolved, c.rejected];
  if (!values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)) {
    return null;
  }
  return {
    total: values.reduce((a, b) => a + b, 0),
    received: c.received,
    inProgress: c.in_progress,
    resolved: c.resolved,
    rejected: c.rejected,
  };
}

// 문의 칸 최근 7일 값(서버 GH-478 counts.receivedLast7d·resolvedLast7d·oldestUnprocessedAt)
// - 칸이 없으면(undefined: 이전 서버·데모·첫 쪽 아님) 화면은 지금 표시(보관 중 합계)를 유지
// - null이면 조회 실패 → '확인 못 함'(0으로 바꾸지 않음)
// - oldestUnprocessedAt null은 '미처리 없음'과 '조회 실패'가 섞임. 상태별 수로 미처리가 0건이면 없음(줄 생략),
//   1건 이상이면 '확인 못 함'
export interface InquiryWindow {
  readonly receivedLast7d: number | null | undefined;
  readonly resolvedLast7d: number | null | undefined;
  readonly oldest:
    | { readonly state: "absent" }
    | { readonly state: "none" }
    | { readonly state: "unknown" }
    | { readonly state: "at"; readonly at: string };
}

const windowCount = (v: unknown): number | null | undefined =>
  v === undefined
    ? undefined
    : typeof v === "number" && Number.isFinite(v) && v >= 0
      ? v
      : null;

export function inquiryWindow(page: InquiryPage | null): InquiryWindow | null {
  const summary = inquirySummary(page);
  const c = page?.counts;
  if (!summary || !c) return null;
  const raw = c.oldestUnprocessedAt;
  const unprocessed = summary.received + summary.inProgress;
  return {
    receivedLast7d: windowCount(c.receivedLast7d),
    resolvedLast7d: windowCount(c.resolvedLast7d),
    oldest:
      raw === undefined
        ? { state: "absent" }
        : typeof raw === "string" && !Number.isNaN(Date.parse(raw))
          ? { state: "at", at: raw }
          : raw === null && unprocessed === 0
            ? { state: "none" }
            : { state: "unknown" },
  };
}

// 수집 칸 아래 줄 '다음 수집 HH:MM'(서버 GH-478 jobs[].nextScheduledAt): 판단 출처 중 가장 이른 예정 시각
// - absent: 판단 출처 모두 칸이 없음(이전 서버) → 고정 안내 유지
// - unknown: 칸은 있는데 null·읽을 수 없는 값이거나 판단 출처가 응답에 빠짐 → '확인 못 함'(남은 출처만으로 고르지 않음)
export type NextCollection =
  | { readonly state: "absent" }
  | { readonly state: "unknown" }
  | { readonly state: "at"; readonly at: string };

export function nextCollection(view: CollectionView | null): NextCollection | null {
  if (!view) return null;
  const jobs = JUDGMENT_JOBS.map((id) => view.jobs.find((j) => j.job === id));
  // 칸이 아예 없는 응답(이전 서버). 출처가 빠진 응답도 남은 출처에 칸이 없으면 이전 서버로 봄
  if (jobs.every((j) => j === undefined || !("nextScheduledAt" in j))) {
    return { state: "absent" };
  }
  let earliest: string | null = null;
  for (const job of jobs) {
    const at: unknown = job?.nextScheduledAt;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) {
      return { state: "unknown" };
    }
    if (earliest === null || Date.parse(at) < Date.parse(earliest)) earliest = at;
  }
  return earliest === null ? { state: "unknown" } : { state: "at", at: earliest };
}

// 막대 길이(%). 전체가 0이면 0(빈 막대). 소수 첫째 자리까지
export function ratioPercent(count: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.round((Math.min(count, total) / total) * 1000) / 10;
}

// 유효 시각(validUntil)이 지난 해변 수. 분류는 그대로 두고 따로 알림(해변 관리 displayOf와 같은 기준)
// 시각을 읽을 수 없으면 지난 것으로 봄
export function expiredCount(
  view: PublishedView | null,
  nowMs: number,
): number | null {
  if (!view || !view.available) return null;
  return Object.values(view.beaches).filter(
    (b) => !(nowMs <= Date.parse(b.validUntil)),
  ).length;
}

export interface NoticeCounts {
  // 예약(아직 앱에 안 나감)
  readonly scheduled: number;
  // 저장한 문구가 앱에 나간 문구와 다름(D16-D4 '수정 대기')
  readonly pendingEdit: number;
}

export function noticeCounts(
  items: readonly NoticeView[] | null,
): NoticeCounts | null {
  if (!items) return null;
  return {
    scheduled: items.filter((n) => n.state === "scheduled").length,
    pendingEdit: items.filter((n) => n.pendingEdit).length,
  };
}

export type TodoKey = "sources" | "inquiries" | "notices";

export interface Todo {
  readonly key: TodoKey;
  readonly count: number;
  readonly href: string;
}

export interface Todos {
  readonly items: readonly Todo[];
  // 하나라도 불러오지 못해 할 일을 다 확인하지 못함 → '지금 할 일이 없어요'를 보이지 않음
  readonly incomplete: boolean;
}

export function todos(input: {
  readonly judgment: JudgmentLine | null;
  readonly received: number | null;
  readonly notices: NoticeCounts | null;
}): Todos {
  const items: Todo[] = [];
  if (input.judgment && input.judgment.problems.length > 0) {
    items.push({
      key: "sources",
      count: input.judgment.problems.length,
      href: "/collection/",
    });
  }
  if (input.received !== null && input.received > 0) {
    items.push({
      key: "inquiries",
      count: input.received,
      href: "/inquiries/",
    });
  }
  if (input.notices && input.notices.pendingEdit > 0) {
    items.push({
      key: "notices",
      count: input.notices.pendingEdit,
      // 보드 V1 '게시' 버튼: 게시 화면으로
      href: "/publish/",
    });
  }
  return {
    items,
    incomplete:
      input.judgment === null ||
      input.received === null ||
      input.notices === null,
  };
}

// 응답 하나의 화면용 결과: 성공 값 / 권한 없음(데모 계정 등) / 불러오지 못함(오류 번호)
export type Part<T> =
  | { readonly state: "ok"; readonly value: T }
  | { readonly state: "forbidden" }
  | { readonly state: "failed"; readonly requestId: string | null };

export function partOf<T, U>(
  result: OpsResult<T>,
  pick: (body: T) => U | null,
): Part<U> {
  if (!result.ok) {
    // 역할표가 막은 경로(forbidden)만 권한 없음. 데모 기간 끝남(sample_not_allowed)·역할 불명은 불러오지 못함
    if (result.status === 403 && result.code === "forbidden") {
      return { state: "forbidden" };
    }
    return {
      state: "failed",
      requestId: "requestId" in result ? (result.requestId ?? null) : null,
    };
  }
  const value = pick(result.body);
  // 본문 모양이 틀리면 불러오지 못함(빈 값·0으로 채우지 않음)
  return value === null
    ? { state: "failed", requestId: null }
    : { state: "ok", value };
}

// 칸 하나의 시간 제한(D26-4 15초, 옛 D16-E1 30초를 바꿈). 넘거나 예외가 나면 불러오지 못함
// (opsFetch에 취소가 없어 요청 자체는 남지만, 칸이 '불러오는 중'에 머물지 않게 함)
export const PART_TIMEOUT_MS = LOADING_TIMES.timeout;

export function settle<T>(
  load: () => Promise<Part<T>>,
  timeoutMs: number = PART_TIMEOUT_MS,
): Promise<Part<T>> {
  return withTimeout(load, { state: "failed", requestId: null }, timeoutMs);
}

// 칸 하나: 응답을 기다리는 중이거나 결과(Part). 다시 읽는 동안은 앞 결과를 그대로 둠
export type Slot<T> = Part<T> | { readonly state: "loading" };

export const valueOf = <T>(part: Slot<T> | undefined): T | null =>
  part?.state === "ok" ? part.value : null;

// 다시 읽은 칸 결과를 앞 값과 합침(GH-462, 보드 L0 '다시 읽기')
// 다시 읽기가 실패해도 앞에서 받은 값은 지우지 않음(stale: 앞 값을 두고 그 칸에 '마지막으로 받은 값' 표시)
// 앞 값이 없거나 권한 없음이면 실패를 그대로 보임(결측을 정상·0으로 채우지 않음)
// keep=false: 판단 출처 상태처럼 앞의 '정상'을 실패 뒤에도 보이면 안 되는 칸은 실패를 그대로 보임
export function mergePart<T>(
  prev: Slot<T>,
  next: Part<T>,
  keep = true,
): { part: Slot<T>; stale: boolean } {
  if (keep && next.state === "failed" && prev.state === "ok") {
    return { part: prev, stale: true };
  }
  return { part: next, stale: false };
}

// 앞 값을 둔 칸 중 가장 오래 받은 시각. 기준 시각과 같은 날(서울)이면 시:분만, 아니면 날짜까지
export function staleSince(
  received: readonly (string | undefined)[],
  asOf: string,
): { iso: string; sameDay: boolean } | null {
  const times = received.filter((t): t is string => typeof t === "string");
  if (times.length === 0) return null;
  const iso = times.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
  const day = (v: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(
      new Date(v),
    );
  return { iso, sameDay: day(iso) === day(asOf) };
}
