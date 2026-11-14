import type {
  ClaimPublishJobResult,
  PublishJobOutcome,
} from "../collect/publish-job";
import type {
  NoticeSnapshot,
  PublishRun,
  PublishSummary,
  StationTable,
} from "../collect/publish-summary";
// 저장소 인터페이스 (BRD-55, 아키텍처 7장)
// 판단·정규화 코드는 이 인터페이스만 씀. AWS SDK 호출은 dynamodb.ts 한 곳에만 둠(17.2 이식성)
// 시각은 모두 인자로 받음(now, epoch ms). 저장소가 직접 시계를 읽지 않음 → 테스트가 시각을 정함

// State에 넣는 값. JSON으로 표현되는 값만 (DynamoDB map·list로 그대로 저장됨)
export type StateValue =
  | null
  | boolean
  | number
  | string
  | readonly StateValue[]
  | { readonly [key: string]: StateValue };

export interface StateRecord {
  readonly pk: string;
  readonly sk: string;
  readonly value: StateValue;
  // 값의 순서 기준 시각(epoch ms, 예: 관측 시각·발표 시각). 이보다 오래된 값은 거부(역행 방지)
  readonly orderAt: number;
  // 바뀔 때마다 1씩 늘어남. 처음 쓰면 1. 낙관적 동시성 비교에 씀
  readonly recordVersion: number;
}

// written: 새 값으로 씀(recordVersion +1)
// unchanged: 같은 orderAt·같은 값 → 쓰지 않음(recordVersion 그대로)
// stale: 저장된 orderAt보다 오래된 값 → 거부, 저장된 값 그대로
// conflict: 읽은 뒤 다른 실행이 먼저 씀 → 쓰지 않음. 다시 읽고 판단할지는 부르는 쪽이 정함
export type PutStateResult = "written" | "unchanged" | "stale" | "conflict";

export interface StateStore {
  getState(pk: string, sk: string): Promise<StateRecord | null>;
  // expectedVersion: 먼저 읽은 recordVersion(기록 없음 → null). 주면 그 뒤 다른 쓰기가 있었을 때 conflict
  putState(
    pk: string,
    sk: string,
    value: StateValue,
    orderAt: number,
    expectedVersion?: number | null,
  ): Promise<PutStateResult>;
}

// claimed: 이 실행이 슬롯을 맡음
// done: 이미 끝난 슬롯 → 다시 하지 않음(멱등)
// busy: 다른 실행이 맡았고 lease가 아직 안 끝남
export type ClaimSlotResult = "claimed" | "done" | "busy";

// 되돌림 포인터(결정 기록 D20-2·D16-C3, A안): 되돌리기 뒤 '되돌림'으로 표시한 공지와 그때 노출본
// 공지 항목(초안·노출본)은 건드리지 않음. publisher는 여기 있는 공지를 운영 DB의 노출본 대신 이 값으로 실음
// 운영자가 '다시 적용'으로 그 공지를 지우기 전까지 자동 게시에 그대로 적용됨
export interface HeldNotice {
  // 이 표시를 만든 되돌리기에서 고른 게시본과 되돌린 시각(UTC ISO)
  readonly target: string;
  readonly at: string;
  // 고른 게시본 때의 노출본. 그때 없었거나 끝난 공지는 null(싣지 않음)
  readonly live: NoticeSnapshot | null;
}

export interface NoticeHold {
  // 바뀔 때마다 1씩 늘어남. 읽은 뒤 다른 쓰기가 있었는지 확인하는 데 씀(운영 API의 version 조건부 쓰기와 같은 칸)
  readonly version: number;
  // 공지 ID → 되돌림 표시. 비어 있으면 되돌린 공지 없음
  readonly notices: Readonly<Record<string, HeldNotice>>;
}

export interface OpsStore {
  // 슬롯 맡기. 기록 없음 또는 in_progress인데 lease가 지남(leaseUntil < now) → claimed
  claimSlot(
    job: string,
    slotId: string,
    owner: string,
    now: number,
    leaseMs: number,
  ): Promise<ClaimSlotResult>;
  // 슬롯 끝냄. 맡은 owner가 같을 때만 done으로 바꾸고 true
  completeSlot(job: string, slotId: string, owner: string): Promise<boolean>;

  // 잠금. 기록 없음 또는 만료(expiresAt < now)일 때만 true. 같은 owner라도 만료 전이면 false
  acquireLock(
    name: string,
    owner: string,
    now: number,
    ttlMs: number,
    trackSequence?: boolean,
  ): Promise<boolean | number>;
  // 잠금 해제. owner가 같을 때만 지우고 true
  releaseLock(
    name: string,
    owner: string,
    preserveSequence?: boolean,
  ): Promise<boolean>;

  getPublishedVersion(): Promise<string | null>;
  // 지금보다 큰 버전일 때만 바꾸고 true. 같거나 작으면 false(버전 역행 없음)
  setPublishedVersion(version: string): Promise<boolean>;

  // 게시 요약 남기기(BRD-187, core/collect/publish-summary.ts). 같은 버전이 있으면 덮지 않음
  putPublishSummary(summary: PublishSummary, nowMs: number): Promise<void>;
  // 게시 때의 공지 상태 남기기·읽기(되돌리기 기준, publish-summary.ts PUBLISH_NOTICES_PK)
  // 읽기: 없으면 null(그 버전으로는 되돌릴 수 없음), 모양이 틀리면 던짐(빈 목록으로 바꾸지 않음)
  putPublishNotices(
    version: string,
    notices: readonly NoticeSnapshot[],
    nowMs: number,
  ): Promise<void>;
  getPublishNotices(version: string): Promise<readonly NoticeSnapshot[] | null>;
  // 관측소 표 바꾸기(한 곳, 덮어씀). 내용이 바뀔 때만 부름(publish.ts)
  putStationTable(table: StationTable, updatedAt: string): Promise<void>;

  // 되돌림 포인터. 없으면 null(되돌린 적 없음), 모양이 틀리면 던짐(없는 것으로 보지 않음)
  getNoticeHold(): Promise<NoticeHold | null>;
  // 읽은 version이 그대로일 때만 바꾸고 true(없던 항목은 expectedVersion 0). 새 version = expectedVersion + 1
  putNoticeHold(
    notices: NoticeHold["notices"],
    expectedVersion: number,
    updatedAt: string, // UTC ISO
  ): Promise<boolean>;

  // 게시 실행 결과 남기기(D16-C2). 마지막 실행은 시작 시각이 더 늦을 때만 덮어쓰고, 실패한 실행은 따로도 남김
  putPublishRun(run: PublishRun, nowMs: number): Promise<void>;

  // 운영자 게시 작업(core/collect/publish-job.ts) 맡기: '대기'이고 시작 제한 안일 때만 '실행'으로 바꿈
  // 시작 제한이 지난 '대기'는 실패(expired)로 바꾸고 expired
  claimPublishJob(jobId: string, nowMs: number): Promise<ClaimPublishJobResult>;
  // 운영자 게시 작업 끝내기: '실행'일 때만 바꾸고 true
  finishPublishJob(
    jobId: string,
    outcome: PublishJobOutcome,
    nowMs: number,
  ): Promise<boolean>;
}

// 슬롯 기록을 남기는 기간. 지나면 DynamoDB TTL이 지움(정리용, 판단에 쓰지 않음)
// 가장 긴 재시도(10분)보다 훨씬 길게 잡아서 같은 슬롯이 다시 실행되지 않게 함
export const SLOT_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
