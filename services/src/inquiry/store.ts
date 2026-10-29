import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type {
  Activity,
  BeachId,
  CreateInquiryResponse,
  InquiryPhotoResult,
  InquiryType,
} from "@baradun/contracts";
import {
  INQUIRY_BODY_RETENTION_DAYS,
  INQUIRY_EMAIL_RETENTION_DAYS,
  INQUIRY_IDEMPOTENCY_RETENTION_DAYS,
  INQUIRY_NOTIFICATION_LIMIT_PER_DAY,
  INQUIRY_RATE_LIMIT_PER_MINUTE,
  kstDate,
  ttlAfterDays,
} from "./policy";

export interface StoredInquiry {
  readonly inquiryId: string;
  readonly type: InquiryType;
  readonly message: string;
  readonly beachId?: BeachId;
  readonly activity?: Activity;
  readonly email?: string;
  readonly photoKeys: string[];
  readonly receivedAt: Date;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly response: CreateInquiryResponse;
}

// 같은 멱등 키로 다시 오면 돌려줄 첫 결과. 본문·이메일 원문은 넣지 않고 내용 지문(SHA-256)만 둠
export interface InquiryReceipt {
  readonly fingerprint: string;
  readonly response: CreateInquiryResponse;
}

export type SaveResult = "saved" | "duplicate";

function isConditionalFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "ConditionalCheckFailedException"
  );
}

// 트랜잭션 첫 품목(멱등 기록)이 이미 있거나 같은 키의 다른 트랜잭션과 겹쳐 취소됐는지
function isDuplicateKey(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException")
    return false;
  const reasons = (error as { CancellationReasons?: { Code?: string }[] })
    .CancellationReasons;
  const code = reasons?.[0]?.Code;
  return code === "ConditionalCheckFailed" || code === "TransactionConflict";
}

const idempotencyPk = (key: string) => `IDEMPOTENCY#${key}`;

function isReceiptItem(
  item: Record<string, unknown>,
): item is Record<string, unknown> & {
  fingerprint: string;
  inquiryId: string;
  receivedAt: string;
  photos: InquiryPhotoResult[];
} {
  return (
    typeof item.fingerprint === "string" &&
    typeof item.inquiryId === "string" &&
    typeof item.receivedAt === "string" &&
    Array.isArray(item.photos)
  );
}

export class InquiryStore {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async allowRequest(now: Date): Promise<boolean> {
    const minute = Math.floor(now.getTime() / 60_000);
    try {
      await this.documents.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: `RATE#${minute}` },
          UpdateExpression: "SET #ttl = :ttl ADD #count :one",
          ConditionExpression:
            "attribute_not_exists(#count) OR #count < :limit",
          ExpressionAttributeNames: { "#ttl": "ttl", "#count": "count" },
          ExpressionAttributeValues: {
            ":ttl": ttlAfterDays(now, 1),
            ":one": 1,
            ":limit": INQUIRY_RATE_LIMIT_PER_MINUTE,
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  async allowNotification(now: Date): Promise<boolean> {
    try {
      await this.documents.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: `NOTIFY#${kstDate(now)}` },
          UpdateExpression: "SET #ttl = :ttl ADD #count :one",
          ConditionExpression:
            "attribute_not_exists(#count) OR #count < :limit",
          ExpressionAttributeNames: { "#ttl": "ttl", "#count": "count" },
          ExpressionAttributeValues: {
            ":ttl": ttlAfterDays(now, 8),
            ":one": 1,
            ":limit": INQUIRY_NOTIFICATION_LIMIT_PER_DAY,
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  // 강한 일관성 읽기. 기록 모양이 틀리면 없는 것으로 보지 않고 던짐(새 문의를 또 만들지 않게)
  async findReceipt(idempotencyKey: string): Promise<InquiryReceipt | undefined> {
    const { Item } = await this.documents.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: idempotencyPk(idempotencyKey) },
        ConsistentRead: true,
      }),
    );
    if (!Item) return undefined;
    if (!isReceiptItem(Item)) throw new Error("멱등 기록 모양이 틀림");
    return {
      fingerprint: Item.fingerprint,
      response: {
        inquiryId: Item.inquiryId,
        receivedAt: Item.receivedAt,
        photos: Item.photos as CreateInquiryResponse["photos"],
      },
    };
  }

  // 멱등 기록·문의·이메일을 한 트랜잭션으로 씀. 멱등 기록은 attribute_not_exists 조건부 쓰기라
  // 같은 키의 요청이 동시에 와도 문의는 하나만 생김(진 쪽은 "duplicate")
  async save(inquiry: StoredInquiry): Promise<SaveResult> {
    const receivedAt = inquiry.receivedAt.toISOString();
    const items: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
      {
        Put: {
          TableName: this.tableName,
          Item: {
            pk: idempotencyPk(inquiry.idempotencyKey),
            kind: "inquiry_idempotency",
            fingerprint: inquiry.fingerprint,
            inquiryId: inquiry.response.inquiryId,
            receivedAt: inquiry.response.receivedAt,
            photos: inquiry.response.photos,
            ttl: ttlAfterDays(
              inquiry.receivedAt,
              INQUIRY_IDEMPOTENCY_RETENTION_DAYS,
            ),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            pk: `INQUIRY#${inquiry.inquiryId}`,
            kind: "inquiry",
            inquiryId: inquiry.inquiryId,
            inquiryType: inquiry.type,
            message: inquiry.message,
            ...(inquiry.beachId ? { beachId: inquiry.beachId } : {}),
            ...(inquiry.activity ? { activity: inquiry.activity } : {}),
            photoKeys: inquiry.photoKeys,
            receivedAt,
            ttl: ttlAfterDays(
              inquiry.receivedAt,
              INQUIRY_BODY_RETENTION_DAYS,
            ),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
    ];

    if (inquiry.email) {
      items.push({
        Put: {
          TableName: this.tableName,
          Item: {
            pk: `INQUIRY_EMAIL#${inquiry.inquiryId}`,
            kind: "inquiry_email",
            inquiryId: inquiry.inquiryId,
            email: inquiry.email,
            receivedAt,
            ttl: ttlAfterDays(
              inquiry.receivedAt,
              INQUIRY_EMAIL_RETENTION_DAYS,
            ),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      });
    }

    try {
      await this.documents.send(
        new TransactWriteCommand({ TransactItems: items }),
      );
      return "saved";
    } catch (error) {
      if (isDuplicateKey(error)) return "duplicate";
      throw error;
    }
  }

  async deleteEmail(inquiryId: string): Promise<void> {
    await this.documents.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: `INQUIRY_EMAIL#${inquiryId}` },
      }),
    );
  }
}
