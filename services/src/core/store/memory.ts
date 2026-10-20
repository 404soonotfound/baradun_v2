import {
  assertSnapshotVersion,
  decideStateWrite,
  slotRecordTtl,
} from "./rules";
import type {
  ClaimSlotResult,
  OpsStore,
  PutStateResult,
  StateRecord,
  StateStore,
  StateValue,
} from "./types";

// 메모리 저장소. 테스트와 로컬 실행용
// 조건 확인과 쓰기 사이에 await가 없음 → DynamoDB 조건부 쓰기처럼 한 번에 일어남
// putState만 읽기와 쓰기 사이에 await를 둠 → DynamoDB 구현처럼 동시 실행이 끼어들 수 있음(conflict)

export interface SlotRecord {
  readonly status: "in_progress" | "done";
  readonly owner: string;
  readonly leaseUntil: number;
  // 정리 시각(epoch 초). 판단에 쓰지 않음
  readonly ttl: number;
}

interface LockRecord {
  readonly owner: string;
  readonly expiresAt: number;
}

const stateKey = (pk: string, sk: string) => JSON.stringify([pk, sk]);

export class MemoryStateStore implements StateStore {
  private readonly records = new Map<string, StateRecord>();

  async getState(pk: string, sk: string): Promise<StateRecord | null> {
    return structuredClone(this.records.get(stateKey(pk, sk)) ?? null);
  }

  async putState(
    pk: string,
    sk: string,
    value: StateValue,
    orderAt: number,
  ): Promise<PutStateResult> {
    const current = await this.getState(pk, sk);
    const decision = decideStateWrite(current, pk, sk, value, orderAt);
    if (decision.kind !== "write") return decision.kind;

    // 읽은 뒤 다른 실행이 끼어들 수 있는 자리 (DynamoDB의 GetItem → PutItem 사이)
    await Promise.resolve();

    const latest = this.records.get(stateKey(pk, sk));
    if ((latest?.recordVersion ?? null) !== decision.expectedVersion) {
      return "conflict";
    }
    this.records.set(stateKey(pk, sk), structuredClone(decision.record));
    return "written";
  }
}

// 슬롯·잠금 필드와 게시 버전은 숫자·문자열 원시값만 사용하므로 깊은 복사 불필요
export class MemoryOpsStore implements OpsStore {
  private readonly slots = new Map<string, SlotRecord>();
  private readonly locks = new Map<string, LockRecord>();
  private publishedVersion: string | null = null;

  // 테스트에서 저장된 슬롯 기록(ttl 등)을 확인할 때 씀
  slotRecord(job: string, slotId: string): SlotRecord | undefined {
    return this.slots.get(JSON.stringify([job, slotId]));
  }

  async claimSlot(
    job: string,
    slotId: string,
    owner: string,
    now: number,
    leaseMs: number,
  ): Promise<ClaimSlotResult> {
    const key = JSON.stringify([job, slotId]);
    const current = this.slots.get(key);
    if (current?.status === "done") return "done";
    if (current && current.leaseUntil >= now) return "busy";

    this.slots.set(key, {
      status: "in_progress",
      owner,
      leaseUntil: now + leaseMs,
      ttl: slotRecordTtl(now),
    });
    return "claimed";
  }

  async completeSlot(
    job: string,
    slotId: string,
    owner: string,
  ): Promise<boolean> {
    const key = JSON.stringify([job, slotId]);
    const current = this.slots.get(key);
    if (current?.owner !== owner) return false;
    this.slots.set(key, { ...current, status: "done" });
    return true;
  }

  async acquireLock(
    name: string,
    owner: string,
    now: number,
    ttlMs: number,
  ): Promise<boolean> {
    const current = this.locks.get(name);
    if (current && current.expiresAt >= now) return false;
    this.locks.set(name, { owner, expiresAt: now + ttlMs });
    return true;
  }

  async releaseLock(name: string, owner: string): Promise<boolean> {
    if (this.locks.get(name)?.owner !== owner) return false;
    this.locks.delete(name);
    return true;
  }

  async getPublishedVersion(): Promise<string | null> {
    return this.publishedVersion;
  }

  async setPublishedVersion(version: string): Promise<boolean> {
    assertSnapshotVersion(version);
    if (this.publishedVersion !== null && version <= this.publishedVersion) {
      return false;
    }
    this.publishedVersion = version;
    return true;
  }
}
