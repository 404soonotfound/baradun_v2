import type {
  NoticeSnapshot,
  PublishRun,
  PublishSummary,
  StationTable,
} from "../collect/publish-summary";
import {
  assertSnapshotVersion,
  decideStateWrite,
  slotRecordTtl,
} from "./rules";
import type {
  ClaimSlotResult,
  NoticeHold,
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
    expectedVersion?: number | null,
  ): Promise<PutStateResult> {
    const current = await this.getState(pk, sk);
    const decision = decideStateWrite(
      current,
      pk,
      sk,
      value,
      orderAt,
      expectedVersion,
    );
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
  // 게시 요약(버전 → 요약). 테스트에서 확인할 때 씀
  readonly summaries = new Map<string, PublishSummary>();
  stationTable: { table: StationTable; updatedAt: string } | null = null;
  stationTableWrites = 0;
  // 게시 때의 공지 상태(버전 → 공지), 되돌림 포인터, 게시 실행 결과(마지막 실행·실패한 실행). 테스트에서 확인할 때 씀
  readonly publishNotices = new Map<string, readonly NoticeSnapshot[]>();
  noticeHold: NoticeHold | null = null;
  noticeHoldUpdatedAt: string | null = null;
  lastRun: PublishRun | null = null;
  readonly failedRuns: PublishRun[] = [];

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

  async putPublishSummary(summary: PublishSummary): Promise<void> {
    if (!this.summaries.has(summary.version)) {
      this.summaries.set(summary.version, summary);
    }
  }

  async putPublishNotices(
    version: string,
    notices: readonly NoticeSnapshot[],
  ): Promise<void> {
    this.publishNotices.set(version, structuredClone(notices));
  }

  async getPublishNotices(
    version: string,
  ): Promise<readonly NoticeSnapshot[] | null> {
    return structuredClone(this.publishNotices.get(version) ?? null);
  }

  async putStationTable(table: StationTable, updatedAt: string): Promise<void> {
    this.stationTable = { table, updatedAt };
    this.stationTableWrites += 1;
  }

  async getNoticeHold(): Promise<NoticeHold | null> {
    return structuredClone(this.noticeHold);
  }

  async putNoticeHold(
    notices: NoticeHold["notices"],
    expectedVersion: number,
    updatedAt: string,
  ): Promise<boolean> {
    if ((this.noticeHold?.version ?? 0) !== expectedVersion) return false;
    this.noticeHoldUpdatedAt = updatedAt;
    this.noticeHold = structuredClone({
      version: expectedVersion + 1,
      notices,
    });
    return true;
  }

  async putPublishRun(run: PublishRun, _nowMs?: number): Promise<void> {
    if (run.result === "failed") this.failedRuns.push(run);
    // 시작 시각이 더 늦은 실행만 마지막 실행으로 남김
    if (this.lastRun === null || this.lastRun.at <= run.at) this.lastRun = run;
  }
}
