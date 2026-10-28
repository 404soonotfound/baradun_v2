import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { InquiryStore } from "./store";

describe("문의 저장", () => {
  it("본문은 90일, 이메일은 88일 TTL로 분리한다", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const documents = {
      send: async (command: { input: Record<string, unknown> }) => {
        commands.push(command);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new InquiryStore(documents, "InquiryTable");
    const receivedAt = new Date("2026-10-26T00:00:00.000Z");

    await store.save({
      inquiryId: "123e4567-e89b-42d3-a456-426614174000",
      type: "data_error",
      message: "문의 본문",
      email: "reader@example.com",
      photoKeys: [],
      receivedAt,
      idempotencyKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      fingerprint: "f".repeat(64),
      response: {
        inquiryId: "123e4567-e89b-42d3-a456-426614174000",
        receivedAt: receivedAt.toISOString(),
        photos: [],
      },
    });

    const items = commands[0]?.input.TransactItems as Array<{
      Put: { Item: Record<string, unknown> };
    }>;
    expect(items).toHaveLength(2);
    expect(items[0]?.Put.Item).toMatchObject({
      pk: "INQUIRY#123e4567-e89b-42d3-a456-426614174000",
      message: "문의 본문",
      ttl: Math.floor(receivedAt.getTime() / 1000) + 90 * 86_400,
    });
    expect(items[0]?.Put.Item).not.toHaveProperty("email");
    expect(items[1]?.Put.Item).toMatchObject({
      pk: "INQUIRY_EMAIL#123e4567-e89b-42d3-a456-426614174000",
      email: "reader@example.com",
      ttl: Math.floor(receivedAt.getTime() / 1000) + 88 * 86_400,
    });
    expect(items[1]?.Put.Item).not.toHaveProperty("message");
  });
});
