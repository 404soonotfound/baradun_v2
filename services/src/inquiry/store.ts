import {
  DeleteCommand,
  DynamoDBDocumentClient,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { InquiryType } from "@baradun/contracts";
import {
  INQUIRY_BODY_RETENTION_DAYS,
  INQUIRY_EMAIL_RETENTION_DAYS,
  INQUIRY_NOTIFICATION_LIMIT_PER_DAY,
  INQUIRY_RATE_LIMIT_PER_MINUTE,
  kstDate,
  ttlAfterDays,
} from "./policy";

export interface StoredInquiry {
  readonly inquiryId: string;
  readonly type: InquiryType;
  readonly message: string;
  readonly email?: string;
  readonly photoKeys: string[];
  readonly receivedAt: Date;
}

function isConditionalFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "ConditionalCheckFailedException"
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

  async save(inquiry: StoredInquiry): Promise<void> {
    const receivedAt = inquiry.receivedAt.toISOString();
    const items: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
      {
        Put: {
          TableName: this.tableName,
          Item: {
            pk: `INQUIRY#${inquiry.inquiryId}`,
            kind: "inquiry",
            inquiryId: inquiry.inquiryId,
            inquiryType: inquiry.type,
            message: inquiry.message,
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

    await this.documents.send(
      new TransactWriteCommand({ TransactItems: items }),
    );
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
