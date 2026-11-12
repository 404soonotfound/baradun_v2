import { PUBLISH_SUMMARY_RETENTION_MS } from "./publish-summary";

// 운영자 게시 작업 (#331, 결정 기록 D16-C4·D20-1, 아키텍처 18.4)
// 운영 API가 '지금 게시'·'되돌리기' 요청을 받으면 작업을 '대기'로 남기고 publisher를 비동기로 부름
// publisher가 작업을 '실행'으로 맡고, 게시가 끝나면 '게시 완료'·'실패'로 바꿈. S3 쓰기는 계속 publisher 하나(6.2)
// - 작업 ID는 운영 API가 멱등 키에서 정함 → 같은 키 재시도가 같은 작업을 가리킴(D16-B6)
// - 같은 작업을 두 번 실행하지 않음: '대기'일 때만 '실행'으로 바꿈(비동기 호출이 두 번 와도 한 번만)
// - 응답 시간 초과는 실패가 아님(D16-C4): 화면은 작업 ID로 상태를 다시 읽음
// - 작업 기록을 남기지 못해도 게시 실행 기록·게시 요약에 작업 ID가 남아 운영 API가 결과를 찾음
// 키: admin#publish#job / {작업 ID}. 운영 API가 만들고(versionedWrite 트랜잭션) publisher가 바꿈

export const PUBLISH_JOB_PK = "admin#publish#job";

export function publishJobKey(jobId: string): { pk: string; sk: string } {
  return { pk: PUBLISH_JOB_PK, sk: jobId };
}

// 운영 API가 멱등 키(UUID v4)에서 만드는 작업 ID 모양
export const PUBLISH_JOB_ID = /^j-[0-9a-f]{12}$/;

export const PUBLISH_JOB_ACTIONS = ["publish", "rollback"] as const;
export type PublishJobAction = (typeof PUBLISH_JOB_ACTIONS)[number];

// 대기 · 실행 · 게시 완료(done) · 실패 (16장 구현 제안 '대기·실행·게시 완료·실패')
// done의 결과: published(새 버전 게시) · unchanged(바뀐 것이 없어 지금 게시본 그대로)
export type PublishJobState = "pending" | "running" | "done" | "failed";

// 시간 제한. 둘 다 게시 잠금 TTL(publisher policy lockTtlMs 2분, D16-C4 '기존 게시 잠금 2분 TTL')과 같게 둠
// - 시작 제한: 이 시간 안에 publisher가 맡지 못한 작업은 publisher가 맡지 않고 실패(expired)로 바꿈
//   비동기 호출은 늦게(최대 10분) 올 수 있음 → 운영자가 잊은 뒤에 게시가 일어나지 않게 함
// - 실행 제한: '실행'으로 이 시간이 지나면 잠금도 풀린 때라 다른 게시가 돌 수 있음
//   → 운영 API가 새 작업을 받음. 이 작업은 '실패'로 단정하지 않고 늦어짐(overdue)으로만 표시함
//   publisher 함수 제한 시간(infra PUBLISHER_TIMEOUT_SECONDS)은 이보다 짧아야 함(infra 시험)
export const PUBLISH_JOB_START_LIMIT_MS = 2 * 60 * 1000;
export const PUBLISH_JOB_RUN_LIMIT_MS = 2 * 60 * 1000;

// 게시 요약과 같은 보존(7일 + 하루)
export const PUBLISH_JOB_RETENTION_MS = PUBLISH_SUMMARY_RETENTION_MS;

export interface PublishJob {
  readonly jobId: string;
  readonly action: PublishJobAction;
  // 되돌리기에서 고른 게시본
  readonly target?: string;
  readonly state: PublishJobState;
  readonly createdAt: string; // UTC ISO(운영 API가 받은 시각)
  readonly createdAtMs: number; // 시작 제한 조건식에 씀
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly result?: "published" | "unchanged";
  // published: 새 버전 · unchanged: 그대로인 지금 버전 · failed: 시도한 버전(없을 수 있음)
  readonly snapshotVersion?: string;
  readonly reason?: string;
}

// publisher가 작업을 맡은 결과
// claimed: 맡음 · expired: 시작 제한이 지나 실패로 바꿈 · taken: 이미 실행 중이거나 끝남 · missing: 기록 없음
export type ClaimPublishJobResult = "claimed" | "expired" | "taken" | "missing";

export type PublishJobOutcome =
  | {
      readonly state: "done";
      readonly result: "published" | "unchanged";
      readonly snapshotVersion: string;
    }
  | {
      readonly state: "failed";
      readonly reason: string;
      readonly snapshotVersion?: string;
    };

// 저장된 작업 기록 해석. 모양이 틀리면 null(운영 API는 '확인 못 함'으로 보여 줌)
export function toPublishJob(item: Record<string, unknown>): PublishJob | null {
  const {
    jobId,
    action,
    target,
    state,
    createdAt,
    createdAtMs,
    startedAt,
    finishedAt,
    result,
    snapshotVersion,
    reason,
  } = item;
  const optionalText = (v: unknown) => v === undefined || typeof v === "string";
  if (
    typeof jobId !== "string" ||
    !(PUBLISH_JOB_ACTIONS as readonly unknown[]).includes(action) ||
    !["pending", "running", "done", "failed"].includes(state as string) ||
    typeof createdAt !== "string" ||
    typeof createdAtMs !== "number" ||
    ![target, startedAt, finishedAt, snapshotVersion, reason].every(
      optionalText,
    ) ||
    !(result === undefined || result === "published" || result === "unchanged")
  ) {
    return null;
  }
  return {
    jobId,
    action: action as PublishJobAction,
    state: state as PublishJobState,
    createdAt,
    createdAtMs,
    ...(target !== undefined ? { target: target as string } : {}),
    ...(startedAt !== undefined ? { startedAt: startedAt as string } : {}),
    ...(finishedAt !== undefined ? { finishedAt: finishedAt as string } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(snapshotVersion !== undefined
      ? { snapshotVersion: snapshotVersion as string }
      : {}),
    ...(reason !== undefined ? { reason: reason as string } : {}),
  };
}
