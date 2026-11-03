import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { idempotencyKey, isAdminKey, type OpsKey } from "./keys";
import { IDEMPOTENCY_KEY, IDEMPOTENCY_TTL_SECONDS } from "./policy";

// 운영 API 쓰기: version 조건부 쓰기 + idempotency key + payload hash (D16-B6)
// 한 트랜잭션에 두 가지를 같이 씀 → 둘 다 되거나 둘 다 안 됨
//   ① 멱등 기록 admin#idem#{key}: 아직 없을 때만 만듦. 이 쓰기의 내용 해시와 결과(새 version)를 남김
//   ② 업무 항목: 읽을 때 받은 version과 지금 version이 같을 때만 바꾸고 version + 1
// 실패 사유는 트랜잭션 취소 사유(품목 순서대로)로 가름
//   ① 실패 → 같은 키가 이미 쓰임: 해시가 같으면 앞 결과를 그대로 돌려줌(재전송), 다르면 409
//   ② 실패 → 다른 사람이 먼저 바꿈: 409(덮어쓰지 않음)
// 동시에 같은 키로 두 번 보내도 ①의 조건 때문에 한 번만 적용됨

export type Sender = Pick<DynamoDBDocumentClient, "send">;

export interface VersionedWrite {
  readonly key: OpsKey;
  // 읽을 때 받은 version. 0이면 새 항목(아직 없어야 함)
  readonly expectedVersion: number;
  // 바꿀 속성. pk·sk·version·ttl은 넣을 수 없음
  readonly set: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  // 요청 본문 해시(payloadHash). 같은 키에 다른 내용이 오면 거부하는 기준
  readonly payloadHash: string;
  readonly actorSub: string;
}

export type WriteResult =
  | { readonly status: "applied"; readonly version: number }
  | { readonly status: "replayed"; readonly version: number }
  | {
      readonly status: "conflict";
      readonly reason: "version" | "idempotency_mismatch";
    };

// 이 함수가 직접 쓰는 속성. 호출자가 set에 넣으면 같은 경로를 두 번 SET하거나 수정자 기록을 덮어씀
const RESERVED = new Set([
  "pk",
  "sk",
  "version",
  "ttl",
  "updatedAt",
  "updatedBy",
]);

export function payloadHashOf(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function cancellationCodes(error: unknown): string[] | undefined {
  if (
    !(error instanceof Error) ||
    error.name !== "TransactionCanceledException"
  )
    return undefined;
  const reasons = (error as { CancellationReasons?: { Code?: string }[] })
    .CancellationReasons;
  return reasons?.map((r) => r.Code ?? "None");
}

export async function versionedWrite(
  client: Sender,
  tableName: string,
  write: VersionedWrite,
  now: Date,
): Promise<WriteResult> {
  if (!isAdminKey(write.key)) {
    throw new Error(`운영 API 범위 밖 키: ${write.key.pk}`);
  }
  // 화면이 쓰기마다 새로 만드는 UUID v4만 받음(빈 값·짧은 값이 서로 다른 쓰기를 섞지 않게)
  if (!IDEMPOTENCY_KEY.test(write.idempotencyKey)) {
    throw new Error("멱등 키는 UUID v4");
  }
  if (
    !Number.isSafeInteger(write.expectedVersion) ||
    write.expectedVersion < 0
  ) {
    throw new Error("expectedVersion은 0 이상의 정수");
  }
  const fields = Object.keys(write.set);
  if (fields.length === 0 || fields.some((f) => RESERVED.has(f))) {
    throw new Error("바꿀 속성이 없거나 예약된 속성이 있음");
  }

  const nextVersion = write.expectedVersion + 1;
  const names: Record<string, string> = { "#version": "version" };
  const values: Record<string, unknown> = {
    ":next": nextVersion,
    ":updatedAt": now.toISOString(),
    ":updatedBy": write.actorSub,
  };
  const assignments = [
    "#version = :next",
    "#updatedAt = :updatedAt",
    "#updatedBy = :updatedBy",
  ];
  names["#updatedAt"] = "updatedAt";
  names["#updatedBy"] = "updatedBy";
  fields.forEach((field, i) => {
    names[`#f${i}`] = field;
    values[`:v${i}`] = write.set[field];
    assignments.push(`#f${i} = :v${i}`);
  });

  let condition: string;
  if (write.expectedVersion === 0) {
    condition = "attribute_not_exists(pk)";
  } else {
    condition = "#version = :expected";
    values[":expected"] = write.expectedVersion;
  }

  const idem = idempotencyKey(write.idempotencyKey);
  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: {
                ...idem,
                payloadHash: write.payloadHash,
                resultVersion: nextVersion,
                target: `${write.key.pk}|${write.key.sk}`,
                createdAt: now.toISOString(),
                ttl: Math.floor(now.getTime() / 1000) + IDEMPOTENCY_TTL_SECONDS,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Update: {
              TableName: tableName,
              Key: write.key,
              UpdateExpression: `SET ${assignments.join(", ")}`,
              ConditionExpression: condition,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          },
        ],
      }),
    );
    return { status: "applied", version: nextVersion };
  } catch (error) {
    const codes = cancellationCodes(error);
    if (!codes) throw error;
    if (codes[0] === "ConditionalCheckFailed") {
      return replay(client, tableName, write);
    }
    if (codes[1] === "ConditionalCheckFailed") {
      return { status: "conflict", reason: "version" };
    }
    // TransactionConflict 등(동시 트랜잭션과 겹침)은 결과를 모르므로 그대로 던짐 → 화면이 같은 키로 다시 확인
    throw error;
  }
}

async function replay(
  client: Sender,
  tableName: string,
  write: VersionedWrite,
): Promise<WriteResult> {
  const result = await client.send(
    new GetCommand({
      TableName: tableName,
      Key: idempotencyKey(write.idempotencyKey),
      ConsistentRead: true,
    }),
  );
  const item = result.Item as
    | { payloadHash?: unknown; resultVersion?: unknown; target?: unknown }
    | undefined;
  if (
    item &&
    item.payloadHash === write.payloadHash &&
    item.target === `${write.key.pk}|${write.key.sk}` &&
    typeof item.resultVersion === "number"
  ) {
    return { status: "replayed", version: item.resultVersion };
  }
  return { status: "conflict", reason: "idempotency_mismatch" };
}
