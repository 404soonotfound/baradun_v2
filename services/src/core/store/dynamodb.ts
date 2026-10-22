import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
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

// 가짜 클라이언트로 바꿀 수 있게 send만 요구함
export type DocumentSender = Pick<DynamoDBDocumentClient, "send">;

// infra TTL_ATTRIBUTE와 같은 이름 (테이블의 TimeToLiveSpecification)
const TTL = "ttl";

const PUBLISHED_VERSION_KEY = { pk: "publish", sk: "version" } as const;

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
}
