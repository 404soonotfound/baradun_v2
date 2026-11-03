import {
  GetCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { auditItem, type AuditEntry } from "./audit";
import { idempotencyKey, isAdminKey, type OpsKey } from "./keys";
import { INQUIRY_ID } from "../inquiry/policy";
import { IDEMPOTENCY_KEY, IDEMPOTENCY_TTL_SECONDS } from "./policy";

// 운영 API 쓰기: version 조건부 쓰기 + idempotency key + payload hash (D16-B6)
// 한 트랜잭션에 세 가지를 같이 씀 → 모두 되거나 모두 안 됨(두 테이블에 걸쳐도 같음)
//   ① 멱등 기록 Ops admin#idem#{key}: 아직 없을 때만 만듦. 이 쓰기의 내용 해시·대상·운영자·결과(새 version)를 남김
//   ② 업무 항목: 읽을 때 받은 version과 지금 version이 같을 때만 바꾸고 version + 1
//   ③ 감사 기록 Ops admin#audit#…: 새 키에만 씀(D16-B5 추가 전용). 감사 없는 쓰기는 받지 않음
//      재전송(①에서 멈춤)·충돌(②에서 멈춤)은 바뀐 것이 없으므로 기록도 남지 않음
// 실패 사유는 트랜잭션 취소 사유(품목 순서대로)로 가름
//   ① 실패 → 같은 키가 이미 쓰임: 해시·대상·운영자가 같으면 앞 결과를 그대로 돌려줌(재전송), 다르면 409
//   ② 실패 → 다른 사람이 먼저 바꿈(또는 항목이 없거나 보관 기한 지남): 409(덮어쓰지 않음)
// 동시에 같은 키로 두 번 보내도 ①의 조건 때문에 한 번만 적용됨
//
// 쓸 수 있는 대상은 두 가지뿐
// - ops: Ops 테이블의 운영 API 키(admin#…). 게시 잠금·슬롯·게시 버전·샘플 설정·멱등 기록은 안 됨
// - inquiry: Inquiry 테이블의 문의 항목(INQUIRY#{id}). 이미 있고 보관 기한(ttl) 안일 때만 바꿈

export type Sender = Pick<DynamoDBDocumentClient, "send">;

export interface WriteTables {
  readonly ops: string;
  readonly inquiry?: string;
}

export type WriteTarget =
  | {
      readonly kind: "ops";
      readonly key: OpsKey;
      // create: 아직 없어야 함(expectedVersion 0), update: 있어야 함
      readonly mode: "create" | "update";
    }
  | { readonly kind: "inquiry"; readonly inquiryId: string };

export interface VersionedWrite {
  readonly target: WriteTarget;
  // 읽을 때 받은 version. 0이면 version이 아직 없는 항목(ops create, 이전 전 문의)
  readonly expectedVersion: number;
  // 바꿀 속성. pk·sk·version·ttl·updatedAt·updatedBy는 넣을 수 없음
  readonly set: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  // 요청 본문 해시(payloadHash). 같은 키에 다른 내용이 오면 거부하는 기준
  readonly payloadHash: string;
  readonly actorSub: string;
  // 변경 이력. 운영자는 actorSub와 같아야 함
  readonly audit: AuditEntry;
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

interface ResolvedTarget {
  readonly tableName: string;
  readonly key: Record<string, string>;
  // 멱등 기록에 남기는 대상 이름(같은 키를 다른 항목에 쓰면 충돌)
  readonly label: string;
  readonly condition: string;
  readonly values: Record<string, unknown>;
}

// 멱등 기록에 남기는 대상 이름(같은 키를 다른 항목에 쓰면 충돌)
function targetLabel(target: WriteTarget): string {
  return target.kind === "ops"
    ? `ops|${target.key.pk}|${target.key.sk}`
    : `inquiry|${target.inquiryId}`;
}

function resolveTarget(
  target: WriteTarget,
  tables: WriteTables,
  expectedVersion: number,
  now: Date,
): ResolvedTarget {
  const versionCondition =
    expectedVersion === 0
      ? "attribute_not_exists(#version)"
      : "#version = :expected";
  const versionValues: Record<string, unknown> =
    expectedVersion === 0 ? {} : { ":expected": expectedVersion };

  if (target.kind === "ops") {
    if (!isAdminKey(target.key)) {
      throw new Error(`운영 API 범위 밖 키: ${target.key.pk}`);
    }
    if (target.mode === "create" && expectedVersion !== 0) {
      throw new Error("새 항목은 expectedVersion 0");
    }
    return {
      tableName: tables.ops,
      key: { pk: target.key.pk, sk: target.key.sk },
      label: targetLabel(target),
      condition:
        target.mode === "create"
          ? "attribute_not_exists(pk)"
          : `attribute_exists(pk) AND ${versionCondition}`,
      values: target.mode === "create" ? {} : versionValues,
    };
  }

  if (!tables.inquiry) throw new Error("Inquiry 테이블 이름 없음");
  if (!INQUIRY_ID.test(target.inquiryId)) {
    throw new Error("문의 ID는 UUID v4");
  }
  // TTL 삭제는 늦을 수 있으므로 기한이 지난 문의는 지워지기 전이라도 바꾸지 않음(구현 제안 I07)
  return {
    tableName: tables.inquiry,
    key: { pk: `INQUIRY#${target.inquiryId}` },
    label: targetLabel(target),
    condition: `attribute_exists(pk) AND #kind = :inquiryKind AND #ttl > :nowSec AND ${versionCondition}`,
    values: {
      ...versionValues,
      ":inquiryKind": "inquiry",
      ":nowSec": Math.floor(now.getTime() / 1000),
    },
  };
}

export async function versionedWrite(
  client: Sender,
  tables: WriteTables,
  write: VersionedWrite,
  now: Date,
): Promise<WriteResult> {
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
  // undefined는 DocumentClient가 마샬링에서 던짐 → 장애(500)로 보이지 않게 여기서 이유를 밝혀 막음
  // 값을 지우려면 업무 경로가 null 등 명시적인 값을 정함
  const missing = fields.filter((f) => write.set[f] === undefined);
  if (missing.length > 0) {
    throw new Error(`값이 없는 속성: ${missing.join(", ")}`);
  }
  if (
    write.audit.actor.kind !== "operator" ||
    write.audit.actor.sub !== write.actorSub
  ) {
    throw new Error("감사 기록의 운영자가 쓰기 운영자와 다름");
  }
  const target = resolveTarget(
    write.target,
    tables,
    write.expectedVersion,
    now,
  );

  const nextVersion = write.expectedVersion + 1;
  const names: Record<string, string> = {
    "#version": "version",
    "#updatedAt": "updatedAt",
    "#updatedBy": "updatedBy",
  };
  if (write.target.kind === "inquiry") {
    names["#kind"] = "kind";
    names["#ttl"] = "ttl";
  }
  const values: Record<string, unknown> = {
    ":next": nextVersion,
    ":updatedAt": now.toISOString(),
    ":updatedBy": write.actorSub,
    ...target.values,
  };
  const assignments = [
    "#version = :next",
    "#updatedAt = :updatedAt",
    "#updatedBy = :updatedBy",
  ];
  fields.forEach((field, i) => {
    names[`#f${i}`] = field;
    values[`:v${i}`] = write.set[field];
    assignments.push(`#f${i} = :v${i}`);
  });

  try {
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tables.ops,
              Item: {
                ...idempotencyKey(write.idempotencyKey),
                payloadHash: write.payloadHash,
                resultVersion: nextVersion,
                target: target.label,
                actorSub: write.actorSub,
                createdAt: now.toISOString(),
                ttl: Math.floor(now.getTime() / 1000) + IDEMPOTENCY_TTL_SECONDS,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Update: {
              TableName: target.tableName,
              Key: target.key,
              UpdateExpression: `SET ${assignments.join(", ")}`,
              ConditionExpression: target.condition,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          },
          {
            Put: {
              TableName: tables.ops,
              Item: auditItem(write.audit, now),
              ConditionExpression: "attribute_not_exists(pk)",
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
      return replay(client, tables.ops, write, target.label);
    }
    if (codes[1] === "ConditionalCheckFailed") {
      return { status: "conflict", reason: "version" };
    }
    // ③ 실패(같은 감사 키가 이미 있음)는 일어나면 안 되는 일이라 그대로 던짐(500)
    // TransactionConflict 등(동시 트랜잭션과 겹침)은 결과를 모르므로 그대로 던짐 → 화면이 같은 키로 다시 확인
    throw error;
  }
}

type ReplayKey = Pick<
  VersionedWrite,
  "idempotencyKey" | "payloadHash" | "actorSub"
>;

// 같은 멱등 키의 앞 결과. 기록이 없으면 null
// 업무 검사(version·상태·삭제 여부)가 앞 쓰기로 이미 바뀐 값을 보고 재전송을 409·404로 돌려주지 않게
// 검사보다 먼저 부름(D16-B6 '같은 키·같은 내용은 앞 결과')
export async function previousWrite(
  client: Sender,
  tables: WriteTables,
  write: ReplayKey & { readonly target: WriteTarget },
): Promise<WriteResult | null> {
  const result = await client.send(
    new GetCommand({
      TableName: tables.ops,
      Key: idempotencyKey(write.idempotencyKey),
      ConsistentRead: true,
    }),
  );
  if (!result.Item) return null;
  return replayOf(result.Item, write, targetLabel(write.target));
}

async function replay(
  client: Sender,
  opsTable: string,
  write: ReplayKey,
  label: string,
): Promise<WriteResult> {
  const result = await client.send(
    new GetCommand({
      TableName: opsTable,
      Key: idempotencyKey(write.idempotencyKey),
      ConsistentRead: true,
    }),
  );
  return replayOf(result.Item, write, label);
}

function replayOf(
  stored: Record<string, unknown> | undefined,
  write: ReplayKey,
  label: string,
): WriteResult {
  const item = stored as
    | {
        payloadHash?: unknown;
        resultVersion?: unknown;
        target?: unknown;
        actorSub?: unknown;
      }
    | undefined;
  // 같은 키·같은 내용·같은 대상·같은 운영자일 때만 앞 결과를 돌려줌
  // (다른 운영자가 같은 키를 쓰면 저장하지 않았는데 자기 쓰기처럼 보이므로 충돌로 봄)
  if (
    item &&
    item.payloadHash === write.payloadHash &&
    item.target === label &&
    item.actorSub === write.actorSub &&
    typeof item.resultVersion === "number"
  ) {
    return { status: "replayed", version: item.resultVersion };
  }
  return { status: "conflict", reason: "idempotency_mismatch" };
}
