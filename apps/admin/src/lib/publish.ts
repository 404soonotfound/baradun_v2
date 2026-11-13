import { opsFetch, type OpsResult } from "./auth/ops-fetch";
import { REPO_URL, type Category } from "./beaches";

// 데이터 게시 화면(ADM-PUB, #331)이 쓰는 운영 API 모양. services/src/admin/publish-reads.ts·publish-routes.ts 응답과 같음
// - 게시 상태는 publisher가 남긴 기록 그대로. 화면은 분류를 다시 계산하지 않음(G1)
// - 읽지 못한 칸은 ok: false('확인 못 함'). 빈 목록·0으로 바꾸지 않음
// - 지금 게시·되돌리기는 작업 ID를 받고 상태를 조회함. 응답 시간 초과는 실패가 아님(D16-C4)
// - 쓰기는 자동으로 다시 보내지 않음(D16-E1). 사람이 다시 누르면 같은 멱등 키로 보내 결과만 확인함

type Token = () => Promise<string | null>;

export type Section<T> = ({ readonly ok: true } & T) | { readonly ok: false };

export interface CategoryCounts {
  readonly clear: number;
  readonly unavailable: number;
  readonly undetermined: number;
}

export interface PublishChanges {
  readonly notices: boolean | null;
  readonly categoryCounts: CategoryCounts | null;
  readonly categoryDelta: CategoryCounts | null;
  readonly delayedBeaches: number;
  readonly delayedDelta: number | null;
}

// 서버가 새 값을 더해도 숨기지 않게 원인·결과는 넓게 받음
export interface HistoryItem {
  readonly result: "published" | "failed" | string;
  readonly version: string;
  readonly at: string;
  readonly source: string;
  readonly target?: string;
  readonly reason?: string;
  readonly jobId?: string;
  readonly beachCount?: number;
  readonly changes?: PublishChanges | null;
  readonly gapBefore?: boolean;
}

export interface RunView {
  readonly at: string;
  readonly source: string;
  readonly result: string;
  readonly version: string;
  readonly reason?: string;
  readonly target?: string;
}

export interface PendingNotice {
  readonly id: string;
  readonly change: "add" | "update" | "remove" | string;
  readonly kind: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
}

export interface HeldNoticeView {
  readonly id: string;
  readonly title: string | null;
  readonly target: string;
  readonly at: string;
  readonly restoresLive: boolean;
}

export type JobState = "pending" | "running" | "done" | "failed";

export interface JobView {
  readonly jobId: string;
  readonly action: "publish" | "rollback" | string;
  readonly target?: string;
  readonly state: JobState | string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly result?: "published" | "unchanged" | string;
  readonly snapshotVersion?: string;
  readonly reason?: string;
  readonly overdue: boolean;
  // 작업 기록 대신 게시 기록으로 찾은 결과(E10#5)
  readonly fromRunRecord?: boolean;
}

export interface AppSettingsView {
  readonly maintenance: {
    readonly active: boolean;
    readonly until: string | null;
  };
  readonly minWebBuild: number;
}

export interface PublishOverview {
  readonly current: Section<{
    readonly version: string | null;
    readonly generatedAt: string | null;
  }>;
  readonly history: Section<{ readonly items: readonly HistoryItem[] }>;
  readonly lastRun: Section<{ readonly run: RunView | null }>;
  readonly nextAuto: {
    readonly warnings: string;
    readonly observations: string;
  };
  readonly pendingNotices: Section<{
    readonly items: readonly PendingNotice[];
    readonly maintenancePending: boolean | null;
  }>;
  readonly heldNotices: Section<{
    readonly version: number;
    readonly items: readonly HeldNoticeView[];
  }>;
  readonly latestJob: Section<{ readonly job: JobView | null }>;
  // 서버 응답에 앱 설정이 아직 없을 수 있어 선택 필드로 둠(없으면 '확인 못 함' 표시)
  readonly settings?: AppSettingsView | null;
}

export interface RollbackPreviewItem {
  readonly id: string;
  readonly change: "restore" | "remove" | "revive" | string;
  readonly title: string | null;
}

export type RollbackPreview =
  | { readonly available: false; readonly version: string }
  | {
      readonly available: true;
      readonly version: string;
      readonly items: readonly RollbackPreviewItem[];
    };

export interface PreviewReason {
  readonly code: string;
  readonly type?: string;
  readonly level?: string;
}

export interface PreviewBeachState {
  readonly category: Category | string;
  readonly reasons: readonly PreviewReason[];
}

export interface PreviewChecks {
  readonly beachIds: {
    readonly where: string;
    readonly missing: number;
    readonly extra: number;
    readonly duplicate: number;
  } | null;
  readonly expected: number;
  readonly contractErrors: number;
}

export type PublishPreview =
  | {
      readonly status: "ready";
      readonly at: string;
      readonly current: {
        readonly version: string | null;
        readonly counts: CategoryCounts | null;
        readonly readable: boolean;
        // 아직 게시본이 없음(첫 게시 전). readable false지만 장애가 아님
        readonly missing: boolean;
      };
      readonly next: { readonly counts: CategoryCounts | null };
      readonly changed: readonly {
        readonly id: string;
        readonly before: PreviewBeachState | null;
        readonly after: PreviewBeachState;
      }[];
      readonly changedCount: number;
      readonly checks: PreviewChecks;
    }
  | {
      readonly status: "blocked";
      readonly at: string;
      readonly reason: string;
      readonly checks: PreviewChecks;
    };

export type PreviewAnswer =
  | { readonly ok: true; readonly preview: PublishPreview }
  | { readonly ok: false; readonly reason: string };

export interface JobAnswer {
  readonly jobId: string;
  readonly job: JobView;
}

export type JobRequest =
  | { readonly action: "publish" }
  | { readonly action: "rollback"; readonly version: string };

export function fetchPublishOverview(
  accessToken: Token,
): Promise<OpsResult<PublishOverview>> {
  return opsFetch("/ops/publish", accessToken);
}

export function fetchPublishPreview(
  accessToken: Token,
): Promise<OpsResult<PreviewAnswer>> {
  return opsFetch("/ops/publish/preview", accessToken);
}

export function fetchRollbackPreview(
  accessToken: Token,
  version: string,
): Promise<OpsResult<RollbackPreview>> {
  return opsFetch(
    `/ops/publish/rollback-preview?version=${encodeURIComponent(version)}`,
    accessToken,
  );
}

export function fetchJob(
  accessToken: Token,
  jobId: string,
): Promise<OpsResult<JobAnswer>> {
  return opsFetch(
    `/ops/publish/jobs/${encodeURIComponent(jobId)}`,
    accessToken,
  );
}

// 같은 요청을 다시 보낼 때(응답을 못 받음)는 같은 멱등 키 → 서버가 앞 작업을 돌려줌(새 게시 없음)
export function createJob(
  accessToken: Token,
  request: JobRequest,
  idempotencyKey: string,
): Promise<OpsResult<JobAnswer>> {
  return opsFetch("/ops/publish/jobs", accessToken, {
    method: "POST",
    body: request,
    idempotencyKey,
  });
}

export function reapplyNotice(
  accessToken: Token,
  noticeId: string,
  holdVersion: number,
  idempotencyKey: string,
): Promise<OpsResult<{ noticeId: string; holdVersion: number }>> {
  return opsFetch(
    `/ops/publish/holds/${encodeURIComponent(noticeId)}/reapply`,
    accessToken,
    { method: "POST", body: { version: holdVersion }, idempotencyKey },
  );
}

// ---- 화면 판단(문구 고르기만. 게시 판단은 하지 않음) ----

// 작업이 아직 끝나지 않았고 늦어지지도 않음 → 지금 게시·되돌리기를 잠금(E2·E4#1)
export function jobInFlight(job: JobView | null | undefined): boolean {
  return (
    !!job &&
    (job.state === "pending" || job.state === "running") &&
    !job.overdue
  );
}

// 작업 상태 → 화면 단계(F4 표). 모르는 상태는 '결과 확인 못 함'(실패로 단정하지 않음)
export type JobPhase =
  | "requested"
  | "running"
  | "published"
  | "unchanged"
  | "recovered"
  | "failed"
  | "overdue"
  | "unknown";

export function jobPhase(job: JobView): JobPhase {
  if (job.state === "done") {
    if (job.fromRunRecord && job.result === "published") return "recovered";
    if (job.result === "published") return "published";
    if (job.result === "unchanged") return "unchanged";
    return "unknown";
  }
  if (job.state === "failed") return "failed";
  if (job.overdue) return "overdue";
  if (job.state === "pending") return "requested";
  if (job.state === "running") return "running";
  return "unknown";
}

// 되돌릴 수 있는 기록: 게시된 줄 중 지금 게시본이 아닌 것. 공지 기록이 없는 버전은 서버가 거절함(미리보기가 알려 줌)
export function canRollBackTo(
  item: HistoryItem,
  currentVersion: string | null,
): boolean {
  return item.result === "published" && item.version !== currentVersion;
}

// 실패 사유 code → 문구 키. 모르는 사유는 null(화면이 code를 함께 보여 줌)
const REASON_KEYS: Readonly<Record<string, string>> = {
  beach_ids: "beach_ids",
  contract: "contract",
  classify: "classify",
  version_not_newer: "overlap",
  manifest_conflict: "overlap",
  hold_conflict: "hold_conflict",
  rollback_target_missing: "rollback_target",
  rollback_target_invalid: "rollback_target",
  busy: "busy",
  expired: "expired",
  invoke_failed: "invoke_failed",
};

export function reasonKey(reason: string | undefined): string | null {
  if (!reason) return null;
  if (reason.startsWith("exception:")) return "exception";
  return REASON_KEYS[reason] ?? null;
}

// 숫자 증감 글자(+3·−2·0). 빼기는 읽기 쉬운 '−'
export function signed(n: number): string {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${Math.abs(n)}`;
  return "0";
}

// 게시 버전(20261112T054500Z) → UTC ISO. 모양이 다르면 null
export function versionIso(version: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(version);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

export const PUBLISH_POLICY_URL = `${REPO_URL}/blob/main/services/src/publisher/policy.ts`;

// 상태 개수 차이 항목(0이 아닌 분류만 순서대로 돌려줌)
export function nonZeroCategoryDeltas(
  delta: CategoryCounts | null | undefined,
): { category: Category; delta: number; signed: string }[] {
  if (!delta) return [];
  const out: { category: Category; delta: number; signed: string }[] = [];
  for (const category of ["clear", "unavailable", "undetermined"] as const) {
    const value = delta[category];
    if (value !== 0) {
      out.push({ category, delta: value, signed: signed(value) });
    }
  }
  return out;
}

// 마지막 실행이 '바뀐 게 없어 건너뜀'인지 판정(D16-C2)
export function isRunSkipped(run: RunView | null | undefined): boolean {
  return run?.result === "unchanged";
}

// 되돌림 상태 공지가 있는지 판정(D16-C3)
export function hasHeldNotices(
  held: PublishOverview["heldNotices"] | null | undefined,
): boolean {
  return !!held && held.ok && held.items.length > 0;
}

export interface DiffLine {
  readonly beforeLine: number | null;
  readonly afterLine: number | null;
  readonly kind: "add" | "del";
  readonly text: string;
}

// 대기 중인 공지의 줄 단위 비교(실제 응답 필드만 사용, 없는 이전 값은 만들지 않음)
export function pendingNoticeDiff(
  notice: PendingNotice,
  kindLabel: string,
  formatTime: (iso: string) => string,
  openEndLabel: string,
): { lines: DiffLine[]; added: number; removed: number } {
  const raw = [
    `kind: ${kindLabel}`,
    `title.ko: ${notice.title.trim()}`,
    `startsAt: ${formatTime(notice.startsAt)}`,
    `endsAt: ${notice.endsAt ? formatTime(notice.endsAt) : openEndLabel}`,
  ];
  const isRemove = notice.change === "remove";
  const lines: DiffLine[] = raw.map((text, idx) => ({
    beforeLine: isRemove ? idx + 1 : null,
    afterLine: isRemove ? null : idx + 1,
    kind: isRemove ? "del" : "add",
    text,
  }));
  return {
    lines,
    added: isRemove ? 0 : lines.length,
    removed: isRemove ? lines.length : 0,
  };
}
