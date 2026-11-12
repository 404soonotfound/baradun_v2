import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  PUBLISH_JOB_START_LIMIT_MS,
  publishJobKey,
  type ClaimPublishJobResult,
  type PublishJobOutcome,
} from "../collect/publish-job";
import {
  PUBLISH_NOTICES_PK,
  PUBLISH_RUN_LAST_SK,
  PUBLISH_RUN_PK,
  PUBLISH_SUMMARY_PK,
  publishSummaryTtl,
  STATION_TABLE_KEY,
  type NoticeSnapshot,
  type PublishRun,
  type PublishSummary,
  type StationTable,
} from "../collect/publish-summary";
import {
  runLogPk,
  runLogSk,
  runRecordTtl,
  type RunLog,
  type RunRecord,
} from "../collect/run-log";
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

// DynamoDB 저장소 (BRD-55). AWS SDK 호출은 이 파일에만 둠(17.2 이식성)
// 테이블 이름은 부르는 쪽이 넘김(Lambda 환경 변수 ← CDK 출력값). 클라이언트도 밖에서 받음 → 테스트에서 가짜로 바꿈
//
// 조건부 쓰기(ConditionExpression) 요약
// - Put·Update·Delete에 조건식을 붙이면 DynamoDB가 항목 하나 안에서 "조건 확인 + 쓰기"를 한 번에 함
//   → 두 실행이 동시에 보내도 조건을 통과하는 쪽은 하나뿐
// - 조건이 거짓이면 아무것도 쓰지 않고 ConditionalCheckFailedException을 던짐 → 인터페이스의 실패 결과로 바꿈
// - attribute_not_exists(pk): 이 키의 항목이 아직 없음 (pk는 모든 항목에 있는 키 속성)
// - 속성 이름은 #이름 자리표시로 씀(ExpressionAttributeNames). status·owner·ttl 등은 예약어라 그대로 쓰면 오류
// - 비교할 값은 :이름 자리표시로 넘김(ExpressionAttributeValues)
// - 없는 속성과의 비교(#owner = :owner 등)는 거짓 → 항목이 없을 때도 조건 실패
//
// Ops 키 모양 (pk / sk)
// - 슬롯 기록: slot#{job} / {slotId}
// - 잠금:      lock#{name} / lock
// - 게시 버전: publish / version
// - 수집 실행 기록: collect#run#{job} / {시작 시각}#{실행 id} (BRD-149, DynamoRunLog)
// - 게시 실행 결과: publish#run / last · publish#run / {시도한 버전} (D16-C2, 실패한 실행만 버전별로)
// - 게시 때의 공지 상태: publish#notices / {게시 버전} (D20-2, 되돌리기 기준)
// - 되돌림 포인터: admin#publish / notice-hold (D20-2). 운영 API가 '다시 적용'으로 고칠 항목이라 admin# 키에 둠
// - 운영자 게시 작업: admin#publish#job / {작업 ID} (#331). 운영 API가 만들고 publisher가 상태를 바꿈

// 가짜 클라이언트로 바꿀 수 있게 send만 요구함
export type DocumentSender = Pick<DynamoDBDocumentClient, "send">;

// infra TTL_ATTRIBUTE와 같은 이름 (테이블의 TimeToLiveSpecification)
const TTL = "ttl";

// 운영 API(수집 현황)도 이 키를 읽음(services/src/admin/collection.ts)
export const PUBLISHED_VERSION_KEY = { pk: "publish", sk: "version" } as const;

// 되돌림 포인터 한 곳. 운영 API의 version 조건부 쓰기(admin/writes.ts)와 같은 칸(version·updatedAt·updatedBy)을 씀
export const NOTICE_HOLD_KEY = {
  pk: "admin#publish",
  sk: "notice-hold",
} as const;

const slotKey = (job: string, slotId: string) => ({
  pk: `slot#${job}`,
  sk: slotId,
});
const lockKey = (name: string) => ({ pk: `lock#${name}`, sk: "lock" });

// 조건 실패만 골라냄. 이름으로 비교 → 패키지가 둘로 깔려도 instanceof가 틀리지 않음
function isConditionFailed(
  error: unknown,
): error is { name: string; Item?: Record<string, { S?: string }> } {
  return (
    error instanceof Error && error.name === "ConditionalCheckFailedException"
  );
}

// 조건 실패 → false, 성공 → true, 그 밖의 오류(권한·용량 초과·네트워크)는 그대로 던짐
async function sendConditional(
  client: DocumentSender,
  command: PutCommand | UpdateCommand | DeleteCommand,
): Promise<boolean> {
  try {
    // send는 명령 종류마다 오버로드가 따로 있음 → 합집합 타입은 어느 것에도 안 맞아 하나로 좁혀서 넘김(동작 차이 없음)
    await client.send(command as PutCommand);
    return true;
  } catch (error) {
    if (isConditionFailed(error)) return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 저장된 모양이 틀리면 던짐(없는 것·빈 것으로 바꾸지 않음). 공지 내용의 계약 검사는 읽는 쪽(publisher)이 함
// 운영 API('다시 적용'·게시 현황)도 같은 해석을 씀
export function toNoticeHold(item: Record<string, unknown>): NoticeHold {
  const { version, notices } = item;
  if (
    typeof version !== "number" ||
    !isRecord(notices) ||
    Object.values(notices).some(
      (held) =>
        !isRecord(held) ||
        typeof held.target !== "string" ||
        typeof held.at !== "string" ||
        (held.live !== null && !isRecord(held.live)),
    )
  ) {
    throw new Error("invalid notice hold item");
  }
  return { version, notices: notices as NoticeHold["notices"] };
}

function toStateRecord(item: Record<string, unknown>): StateRecord {
  const { pk, sk, value, orderAt, recordVersion } = item;
  if (
    typeof pk !== "string" ||
    typeof sk !== "string" ||
    typeof orderAt !== "number" ||
    typeof recordVersion !== "number" ||
    !("value" in item)
  ) {
    throw new Error(`invalid state item: ${JSON.stringify([pk, sk])}`);
  }
  return { pk, sk, value: value as StateValue, orderAt, recordVersion };
}

export class DynamoStateStore implements StateStore {
  constructor(
    private readonly client: DocumentSender,
    private readonly tableName: string,
  ) {}

  async getState(pk: string, sk: string): Promise<StateRecord | null> {
    // ConsistentRead: 방금 끝난 쓰기까지 반영된 값을 읽음(기본은 최종 일관성 → 몇 초 늦을 수 있음)
    // 읽은 recordVersion으로 조건부 쓰기를 하므로 늦은 값을 읽으면 conflict가 늘어남
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        ConsistentRead: true,
      }),
    );
    return result.Item ? toStateRecord(result.Item) : null;
  }

  async putState(
    pk: string,
    sk: string,
    value: StateValue,
    orderAt: number,
    expectedVersion?: number | null,
  ): Promise<PutStateResult> {
    const decision = decideStateWrite(
      await this.getState(pk, sk),
      pk,
      sk,
      value,
      orderAt,
      expectedVersion,
    );
    if (decision.kind !== "write") return decision.kind;

    // 낙관적 동시성: 읽은 뒤 아무도 안 썼을 때만 씀
    // 처음 쓰기 → 항목이 아직 없어야 함, 그 밖 → 저장된 recordVersion이 읽은 값과 같아야 함
    const condition =
      decision.expectedVersion === null
        ? {
            ConditionExpression: "attribute_not_exists(pk)",
          }
        : {
            ConditionExpression: "#recordVersion = :expectedVersion",
            ExpressionAttributeNames: { "#recordVersion": "recordVersion" },
            ExpressionAttributeValues: {
              ":expectedVersion": decision.expectedVersion,
            },
          };
    const written = await sendConditional(
      this.client,
      new PutCommand({
        TableName: this.tableName,
        Item: { ...decision.record },
        ...condition,
      }),
    );
    return written ? "written" : "conflict";
  }
}

export class DynamoOpsStore implements OpsStore {
  constructor(
    private readonly client: DocumentSender,
    private readonly tableName: string,
  ) {}

  async claimSlot(
    job: string,
    slotId: string,
    owner: string,
    now: number,
    leaseMs: number,
  ): Promise<ClaimSlotResult> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...slotKey(job, slotId),
            status: "in_progress",
            owner,
            leaseUntil: now + leaseMs,
            [TTL]: slotRecordTtl(now),
          },
          // 기록 없음, 또는 끝나지 않았고 lease가 지남 → 이 실행이 맡음(덮어씀)
          ConditionExpression:
            "attribute_not_exists(pk) OR (#status = :inProgress AND #leaseUntil < :now)",
          ExpressionAttributeNames: {
            "#status": "status",
            "#leaseUntil": "leaseUntil",
          },
          ExpressionAttributeValues: {
            ":inProgress": "in_progress",
            ":now": now,
          },
          // 조건 실패 때 저장돼 있던 항목을 오류에 담아 줌 → 다시 읽지 않고 done·busy를 가름
          // 오류의 Item은 lib-dynamodb가 변환하지 않음 → { status: { S: "done" } } 모양
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      return "claimed";
    } catch (error) {
      if (!isConditionFailed(error)) throw error;
      return error.Item?.status?.S === "done" ? "done" : "busy";
    }
  }

  async completeSlot(
    job: string,
    slotId: string,
    owner: string,
  ): Promise<boolean> {
    // 맡은 owner일 때만 done. 항목이 없으면 owner 비교가 거짓 → 새 항목을 만들지 않음
    // lease가 지났어도 아무도 다시 맡지 않았으면 끝낼 수 있음(fencing 없음, 10/16 간소화)
    return sendConditional(
      this.client,
      new UpdateCommand({
        TableName: this.tableName,
        Key: slotKey(job, slotId),
        UpdateExpression: "SET #status = :done",
        ConditionExpression: "#owner = :owner",
        ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
        ExpressionAttributeValues: { ":done": "done", ":owner": owner },
      }),
    );
  }

  async acquireLock(
    name: string,
    owner: string,
    now: number,
    ttlMs: number,
  ): Promise<boolean> {
    // 기록 없음, 또는 만료(expiresAt < now) → 덮어써서 가져감
    // expiresAt은 잠금 판단용 ms 시각. TTL 속성(ttl)과 따로 둠 → TTL 삭제 지연에 기대지 않음
    return sendConditional(
      this.client,
      new PutCommand({
        TableName: this.tableName,
        Item: { ...lockKey(name), owner, expiresAt: now + ttlMs },
        ConditionExpression: "attribute_not_exists(pk) OR #expiresAt < :now",
        ExpressionAttributeNames: { "#expiresAt": "expiresAt" },
        ExpressionAttributeValues: { ":now": now },
      }),
    );
  }

  async releaseLock(name: string, owner: string): Promise<boolean> {
    // 내 잠금일 때만 지움. 만료 뒤 다른 실행이 가져갔으면 owner가 달라 실패
    return sendConditional(
      this.client,
      new DeleteCommand({
        TableName: this.tableName,
        Key: lockKey(name),
        ConditionExpression: "#owner = :owner",
        ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: { ":owner": owner },
      }),
    );
  }

  async getPublishedVersion(): Promise<string | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: PUBLISHED_VERSION_KEY,
        ConsistentRead: true,
      }),
    );
    const version = result.Item?.version;
    if (version === undefined) return null;
    if (typeof version !== "string") {
      throw new Error("invalid published version item");
    }
    return version;
  }

  async setPublishedVersion(version: string): Promise<boolean> {
    assertSnapshotVersion(version);
    // 문자열 < 비교는 UTF-8 바이트 순서. 형식이 고정 길이 숫자라 시각 순서와 같음
    // 같은 값도 조건이 거짓 → false
    return sendConditional(
      this.client,
      new UpdateCommand({
        TableName: this.tableName,
        Key: PUBLISHED_VERSION_KEY,
        UpdateExpression: "SET #version = :version",
        ConditionExpression:
          "attribute_not_exists(#version) OR #version < :version",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":version": version },
      }),
    );
  }
  async putPublishSummary(summary: PublishSummary, nowMs: number) {
    await sendConditional(
      this.client,
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: PUBLISH_SUMMARY_PK,
          sk: summary.version,
          ...summary,
          [TTL]: publishSummaryTtl(nowMs),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }

  async putPublishNotices(
    version: string,
    notices: readonly NoticeSnapshot[],
    nowMs: number,
  ) {
    assertSnapshotVersion(version);
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: PUBLISH_NOTICES_PK,
          sk: version,
          notices,
          [TTL]: publishSummaryTtl(nowMs),
        },
      }),
    );
  }

  async getPublishNotices(
    version: string,
  ): Promise<readonly NoticeSnapshot[] | null> {
    assertSnapshotVersion(version);
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: PUBLISH_NOTICES_PK, sk: version },
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return null;
    const notices: unknown = result.Item.notices;
    if (!Array.isArray(notices) || !notices.every(isRecord)) {
      throw new Error("invalid publish notices item");
    }
    return notices as unknown as NoticeSnapshot[];
  }

  async putStationTable(table: StationTable, updatedAt: string) {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...STATION_TABLE_KEY, stations: table, updatedAt },
      }),
    );
  }

  async getNoticeHold(): Promise<NoticeHold | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: NOTICE_HOLD_KEY,
        ConsistentRead: true,
      }),
    );
    return result.Item ? toNoticeHold(result.Item) : null;
  }

  async putNoticeHold(
    notices: NoticeHold["notices"],
    expectedVersion: number,
    updatedAt: string,
  ): Promise<boolean> {
    // 읽은 version 그대로일 때만 씀. 그 사이 '다시 적용'(운영 API)이나 다른 되돌리기가 끼어들었으면 false
    return sendConditional(
      this.client,
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...NOTICE_HOLD_KEY,
          version: expectedVersion + 1,
          notices,
          updatedAt,
          updatedBy: "publisher",
        },
        ...(expectedVersion === 0
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : {
              ConditionExpression: "#version = :expected",
              ExpressionAttributeNames: { "#version": "version" },
              ExpressionAttributeValues: { ":expected": expectedVersion },
            }),
      }),
    );
  }

  async putPublishRun(run: PublishRun, nowMs: number) {
    if (run.result === "failed") {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: PUBLISH_RUN_PK,
            sk: run.version,
            ...run,
            [TTL]: publishSummaryTtl(nowMs),
          },
        }),
      );
    }
    // 마지막 실행은 시작 시각이 더 늦은 쪽만 남김. 잠금 시간을 넘겨 늦게 끝난 옛 실행이 새 실행의 결과를 덮지 않게 함
    // (조건이 맞지 않으면 쓰지 않을 뿐 오류가 아님)
    await sendConditional(
      this.client,
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: PUBLISH_RUN_PK, sk: PUBLISH_RUN_LAST_SK, ...run },
        ConditionExpression: "attribute_not_exists(#at) OR #at <= :at",
        ExpressionAttributeNames: { "#at": "at" },
        ExpressionAttributeValues: { ":at": run.at },
      }),
    );
  }

  claimPublishJob(jobId: string, nowMs: number) {
    return claimPublishJobItem(this.client, this.tableName, jobId, nowMs);
  }

  finishPublishJob(jobId: string, outcome: PublishJobOutcome, nowMs: number) {
    return finishPublishJobItem(
      this.client,
      this.tableName,
      jobId,
      outcome,
      nowMs,
    );
  }
}

// 운영자 게시 작업 맡기·끝내기(#331). 조건부 Update라 같은 작업을 두 실행이 맡지 못함
// 운영 API가 작업을 만든 뒤 publisher 호출이 두 번 오거나(비동기 호출 재전달) 늦게 와도 한 번만 실행됨
export async function claimPublishJobItem(
  client: DocumentSender,
  tableName: string,
  jobId: string,
  nowMs: number,
): Promise<ClaimPublishJobResult> {
  const key = publishJobKey(jobId);
  const claimed = await sendConditional(
    client,
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: "SET #state = :running, #startedAt = :now",
      ConditionExpression:
        "attribute_exists(pk) AND #state = :pending AND #createdAtMs > :oldest",
      ExpressionAttributeNames: {
        "#state": "state",
        "#startedAt": "startedAt",
        "#createdAtMs": "createdAtMs",
      },
      ExpressionAttributeValues: {
        ":running": "running",
        ":pending": "pending",
        ":now": new Date(nowMs).toISOString(),
        ":oldest": nowMs - PUBLISH_JOB_START_LIMIT_MS,
      },
    }),
  );
  if (claimed) return "claimed";
  // 왜 못 맡았는지: 기록이 없음 · 이미 맡음·끝남 · 시작 제한이 지남(실패로 바꿈)
  const current = await client.send(
    new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }),
  );
  if (!current.Item) return "missing";
  if (current.Item.state !== "pending") return "taken";
  const expired = await failPendingPublishJobItem(
    client,
    tableName,
    jobId,
    "expired",
    nowMs,
  );
  return expired ? "expired" : "taken";
}

// 아직 '대기'인 작업을 실패로 바꿈(시작 제한 지남·운영 API의 publisher 호출 실패). 이미 맡았으면 false
export function failPendingPublishJobItem(
  client: DocumentSender,
  tableName: string,
  jobId: string,
  reason: string,
  nowMs: number,
): Promise<boolean> {
  return sendConditional(
    client,
    new UpdateCommand({
      TableName: tableName,
      Key: publishJobKey(jobId),
      UpdateExpression:
        "SET #state = :failed, #reason = :reason, #finishedAt = :now",
      ConditionExpression: "attribute_exists(pk) AND #state = :pending",
      ExpressionAttributeNames: {
        "#state": "state",
        "#reason": "reason",
        "#finishedAt": "finishedAt",
      },
      ExpressionAttributeValues: {
        ":failed": "failed",
        ":pending": "pending",
        ":reason": reason,
        ":now": new Date(nowMs).toISOString(),
      },
    }),
  );
}

export async function finishPublishJobItem(
  client: DocumentSender,
  tableName: string,
  jobId: string,
  outcome: PublishJobOutcome,
  nowMs: number,
): Promise<boolean> {
  const names: Record<string, string> = {
    "#state": "state",
    "#finishedAt": "finishedAt",
  };
  const values: Record<string, unknown> = {
    ":state": outcome.state,
    ":running": "running",
    ":now": new Date(nowMs).toISOString(),
  };
  const sets = ["#state = :state", "#finishedAt = :now"];
  const fields: Record<string, unknown> =
    outcome.state === "done"
      ? { result: outcome.result, snapshotVersion: outcome.snapshotVersion }
      : {
          reason: outcome.reason,
          ...(outcome.snapshotVersion !== undefined
            ? { snapshotVersion: outcome.snapshotVersion }
            : {}),
        };
  for (const [name, value] of Object.entries(fields)) {
    names[`#${name}`] = name;
    values[`:${name}`] = value;
    sets.push(`#${name} = :${name}`);
  }
  return sendConditional(
    client,
    new UpdateCommand({
      TableName: tableName,
      Key: publishJobKey(jobId),
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: "attribute_exists(pk) AND #state = :running",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

// 수집 실행 기록 (BRD-149, core/collect/run-log.ts). 키: collect#run#{job} / {시작 시각}#{실행 id}
// 수집 역할의 Ops PutItem 권한 안. 같은 키가 있으면 덮지 않음(조건 실패는 그대로 둠)
export class DynamoRunLog implements RunLog {
  constructor(
    private readonly client: DocumentSender,
    private readonly tableName: string,
  ) {}

  async record(record: RunRecord, owner: string, nowMs: number) {
    await sendConditional(
      this.client,
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: runLogPk(record.job),
          sk: runLogSk(record.startedAt, owner),
          ...record,
          [TTL]: runRecordTtl(nowMs),
        },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
  }
}
