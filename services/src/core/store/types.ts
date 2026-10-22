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
  ): Promise<boolean>;
  // 잠금 해제. owner가 같을 때만 지우고 true
  releaseLock(name: string, owner: string): Promise<boolean>;

  getPublishedVersion(): Promise<string | null>;
  // 지금보다 큰 버전일 때만 바꾸고 true. 같거나 작으면 false(버전 역행 없음)
  setPublishedVersion(version: string): Promise<boolean>;
}

// 슬롯 기록을 남기는 기간. 지나면 DynamoDB TTL이 지움(정리용, 판단에 쓰지 않음)
// 가장 긴 재시도(10분)보다 훨씬 길게 잡아서 같은 슬롯이 다시 실행되지 않게 함
export const SLOT_RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
