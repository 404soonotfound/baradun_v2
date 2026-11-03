import {
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  INQUIRY_STATUSES,
  INQUIRY_STATUS_INDEX_NAME,
  type InquiryStatus,
} from "../inquiry/policy";
import type { Sender } from "./writes";

// 기존 문의를 '접수' 상태로 채우는 이전 도구 (BRD-153, D16-D5, 구현 제안 I07)
// - 상태 기록 전에 들어온 문의(inquiryStatus 없음)만 received·version 1·legacy true로 채움
// - 조건부 쓰기: 아직 상태가 없고, 문의 항목이고, 보관 기한(ttl) 안일 때만. 접수 시각·ttl은 건드리지 않음(늘리지 않음)
// - 이미 처리 중인 문의는 건너뜀(운영 API가 먼저 바꾼 경우 포함). 다시 돌려도 결과가 같음
// - Inquiry 테이블은 읽기·쓰기 1/1이라 페이지마다 쉬어 가며 천천히 씀
// 순서: dry-run → (신규 문의가 상태를 갖는 배포) → apply → GSI ACTIVE 뒤 verify → 목록 공개

export interface BackfillReport {
  readonly scanned: number;
  readonly alreadyHasStatus: number;
  readonly expired: number;
  readonly candidates: number;
  readonly updated: number;
  readonly skipped: number;
}

export interface BackfillOptions {
  readonly apply: boolean;
  readonly now: Date;
  readonly pageSize?: number;
  readonly pauseMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function isConditionFailed(error: unknown): boolean {
  return (
    error instanceof Error && error.name === "ConditionalCheckFailedException"
  );
}

export async function backfillInquiryStatus(
  client: Sender,
  tableName: string,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const nowSec = Math.floor(options.now.getTime() / 1000);
  const sleep = options.sleep ?? defaultSleep;
  const pauseMs = options.pauseMs ?? 1000;
  const report = {
    scanned: 0,
    alreadyHasStatus: 0,
    expired: 0,
    candidates: 0,
    updated: 0,
    skipped: 0,
  };
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "#kind = :inquiry",
        ProjectionExpression: "pk, #kind, inquiryStatus, #ttl",
        ExpressionAttributeNames: { "#kind": "kind", "#ttl": "ttl" },
        ExpressionAttributeValues: { ":inquiry": "inquiry" },
        Limit: options.pageSize ?? 25,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of (page.Items ?? []) as Record<string, unknown>[]) {
      report.scanned++;
      if (item.inquiryStatus !== undefined) {
        report.alreadyHasStatus++;
        continue;
      }
      if (typeof item.ttl !== "number" || item.ttl <= nowSec) {
        report.expired++;
        continue;
      }
      report.candidates++;
      if (!options.apply) continue;
      try {
        await client.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { pk: item.pk },
            UpdateExpression:
              "SET inquiryStatus = :received, #version = :one, legacy = :true",
            ConditionExpression:
              "attribute_exists(pk) AND #kind = :inquiry AND attribute_not_exists(inquiryStatus) AND #ttl > :nowSec",
            ExpressionAttributeNames: {
              "#kind": "kind",
              "#ttl": "ttl",
              "#version": "version",
            },
            ExpressionAttributeValues: {
              ":received": "received" satisfies InquiryStatus,
              ":one": 1,
              ":true": true,
              ":inquiry": "inquiry",
              ":nowSec": nowSec,
            },
          }),
        );
        report.updated++;
      } catch (error) {
        if (!isConditionFailed(error)) throw error;
        report.skipped++;
      }
    }
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (startKey) await sleep(pauseMs);
  } while (startKey);
  return report;
}

export interface VerifyReport {
  // 원본 테이블에서 센 보관 기한 안 문의
  readonly alive: number;
  readonly withoutStatus: number;
  // GSI에서 상태별로 센 보관 기한 안 문의
  readonly indexed: Readonly<Record<InquiryStatus, number>>;
  readonly matches: boolean;
}

// 원본 대조: 보관 기한 안 문의 수 = GSI 상태별 합계, 상태 없는 문의 0
// GSI는 최종적 일관성이라 이전 직후에는 잠시 맞지 않을 수 있음 → 몇 분 뒤 다시 확인
export async function verifyInquiryIndex(
  client: Sender,
  tableName: string,
  now: Date,
  options: Pick<BackfillOptions, "pageSize" | "pauseMs" | "sleep"> = {},
): Promise<VerifyReport> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const sleep = options.sleep ?? defaultSleep;
  let alive = 0;
  let withoutStatus = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "#kind = :inquiry AND #ttl > :nowSec",
        ProjectionExpression: "pk, inquiryStatus",
        ExpressionAttributeNames: { "#kind": "kind", "#ttl": "ttl" },
        ExpressionAttributeValues: { ":inquiry": "inquiry", ":nowSec": nowSec },
        Limit: options.pageSize ?? 25,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    for (const item of (page.Items ?? []) as Record<string, unknown>[]) {
      alive++;
      if (item.inquiryStatus === undefined) withoutStatus++;
    }
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (startKey) await sleep(options.pauseMs ?? 1000);
  } while (startKey);

  const indexed = {} as Record<InquiryStatus, number>;
  for (const status of INQUIRY_STATUSES) {
    let count = 0;
    let lastKey: Record<string, unknown> | undefined;
    do {
      const page = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: INQUIRY_STATUS_INDEX_NAME,
          KeyConditionExpression: "#s = :s",
          FilterExpression: "#ttl > :nowSec",
          ExpressionAttributeNames: { "#s": "inquiryStatus", "#ttl": "ttl" },
          ExpressionAttributeValues: { ":s": status, ":nowSec": nowSec },
          Select: "COUNT",
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      count += page.Count ?? 0;
      lastKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    indexed[status] = count;
  }
  const indexedTotal = Object.values(indexed).reduce((a, b) => a + b, 0);
  return {
    alive,
    withoutStatus,
    indexed,
    matches: withoutStatus === 0 && indexedTotal === alive,
  };
}
