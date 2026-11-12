import type { AuditView } from "./audit";
import type { OpsResult } from "./auth/ops-fetch";
import type { PublishedView } from "./beaches";
import {
  SOURCE_ROWS,
  sourceState,
  type CollectionJobId,
  type CollectionView,
  type SourceState,
} from "./collection";
import type { InquiryPage } from "./inquiries";
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

// 판단불가 해변 수. 게시본을 읽지 못하면 null
export function undeterminedCount(view: PublishedView | null): number | null {
  if (!view || !view.available) return null;
  return Object.values(view.beaches).filter(
    (b) => b.category === "undetermined",
  ).length;
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

// 새 문의(접수) 수. 첫 쪽의 상태별 수가 없으면 null
export function receivedCount(page: InquiryPage | null): number | null {
  const count = page?.counts?.received;
  return typeof count === "number" && Number.isFinite(count) ? count : null;
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
      href: "/notices/",
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

// 칸 하나의 시간 제한(D16-E1 일반 조회 30초). 넘거나 예외가 나면 불러오지 못함
// (opsFetch에 취소가 없어 요청 자체는 남지만, 칸이 '불러오는 중'에 머물지 않게 함)
export const PART_TIMEOUT_MS = 30_000;

export function settle<T>(
  load: () => Promise<Part<T>>,
  timeoutMs: number = PART_TIMEOUT_MS,
): Promise<Part<T>> {
  const failed: Part<T> = { state: "failed", requestId: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    load().catch(() => failed),
    new Promise<Part<T>>((resolve) => {
      timer = setTimeout(() => resolve(failed), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

// 최근 변경: 운영자가 바꾼 기록만. 데모 계정의 조회·거절 기록(sample.*)은 변경이 아니라 뺌
export interface RecentView {
  readonly items: readonly AuditView[];
  // 받은 기록이 있었지만 모두 조회 기록이라 보여 줄 변경이 없음('바뀐 것이 없어요'와 구분)
  readonly onlyReads: boolean;
}

export function recentChanges(
  items: readonly AuditView[],
  count: number,
): RecentView {
  const changes = items.filter((item) => !item.action.startsWith("sample."));
  return {
    items: changes.slice(0, count),
    onlyReads: changes.length === 0 && items.length > 0,
  };
}

// 칸 하나: 응답을 기다리는 중이거나 결과(Part). 다시 읽는 동안은 앞 결과를 그대로 둠
export type Slot<T> = Part<T> | { readonly state: "loading" };

export const valueOf = <T>(part: Slot<T> | undefined): T | null =>
  part?.state === "ok" ? part.value : null;
