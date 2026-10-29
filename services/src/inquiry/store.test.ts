import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { InquiryStore, type StoredInquiry } from "./store";

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
    expect(items).toHaveLength(3);
    items.shift(); // 첫 품목은 멱등 기록(아래 시험)
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

  it("해변·활동은 문의 품목에 구조화 칸으로 넣고, 없으면 칸을 만들지 않는다", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const documents = {
      send: async (command: { input: Record<string, unknown> }) => {
        commands.push(command);
        return {};
      },
    } as unknown as DynamoDBDocumentClient;
    const store = new InquiryStore(documents, "InquiryTable");
    const receivedAt = new Date("2026-10-26T00:00:00.000Z");
    const base: StoredInquiry = {
      inquiryId: "123e4567-e89b-42d3-a456-426614174000",
      type: "beach_request",
      message: "문의 본문",
      photoKeys: [],
      receivedAt,
      idempotencyKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      fingerprint: "f".repeat(64),
      response: {
        inquiryId: "123e4567-e89b-42d3-a456-426614174000",
        receivedAt: receivedAt.toISOString(),
        photos: [],
      },
    };
    await store.save({ ...base, beachId: "b0001", activity: "scuba" });
    await store.save(base);

    const itemOf = (index: number) =>
      (
        commands[index]?.input.TransactItems as Array<{
          Put: { Item: Record<string, unknown> };
        }>
      )[1]?.Put.Item;
    expect(itemOf(0)).toMatchObject({
      inquiryType: "beach_request",
      beachId: "b0001",
      activity: "scuba",
    });
    expect(itemOf(1)).not.toHaveProperty("beachId");
    expect(itemOf(1)).not.toHaveProperty("activity");
  });
});

describe("문의 멱등 기록 (BRD-103)", () => {
  const receivedAt = new Date("2026-10-26T00:00:00.000Z");
  const inquiry = {
    inquiryId: "123e4567-e89b-42d3-a456-426614174000",
    type: "data_error" as const,
    message: "문의 본문",
    email: "reader@example.com",
    photoKeys: [],
    receivedAt,
    idempotencyKey: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    fingerprint: "f".repeat(64),
    response: {
      inquiryId: "123e4567-e89b-42d3-a456-426614174000",
      receivedAt: receivedAt.toISOString(),
      photos: [{ photoId: "0123456789abcdef", status: "accepted" }],
    },
  } satisfies StoredInquiry;

  function client(answer: (command: { input: Record<string, unknown> }) => unknown) {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const documents = {
      send: async (command: { input: Record<string, unknown> }) => {
        commands.push(command);
        return answer(command);
      },
    } as unknown as DynamoDBDocumentClient;
    return { store: new InquiryStore(documents, "InquiryTable"), commands };
  }

  function canceled(codes: string[]) {
    return Object.assign(new Error("canceled"), {
      name: "TransactionCanceledException",
      CancellationReasons: codes.map((Code) => ({ Code })),
    });
  }

  it("멱등 기록을 문의와 같은 트랜잭션 첫 품목으로 조건부 쓰기하고 이메일·본문은 넣지 않음", async () => {
    const { store, commands } = client(() => ({}));
    await expect(store.save(inquiry)).resolves.toBe("saved");
    const first = (
      commands[0]?.input.TransactItems as Array<{
        Put: { Item: Record<string, unknown>; ConditionExpression: string };
      }>
    )[0]!;
    expect(first.Put.ConditionExpression).toBe("attribute_not_exists(pk)");
    expect(first.Put.Item).toEqual({
      pk: "IDEMPOTENCY#3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      kind: "inquiry_idempotency",
      fingerprint: "f".repeat(64),
      inquiryId: inquiry.inquiryId,
      receivedAt: "2026-10-26T00:00:00.000Z",
      photos: inquiry.response.photos,
      ttl: Math.floor(receivedAt.getTime() / 1000) + 86_400,
    });
  });

  it("멱등 기록 조건 실패·같은 키 트랜잭션 충돌은 duplicate, 그 밖의 취소·오류는 던짐", async () => {
    for (const code of ["ConditionalCheckFailed", "TransactionConflict"]) {
      const { store } = client(() => {
        throw canceled([code, "None", "None"]);
      });
      await expect(store.save(inquiry), code).resolves.toBe("duplicate");
    }
    const otherItem = client(() => {
      throw canceled(["None", "ConditionalCheckFailed", "None"]);
    });
    await expect(otherItem.store.save(inquiry)).rejects.toThrow("canceled");
    const noReasons = client(() => {
      throw canceled([]);
    });
    await expect(noReasons.store.save(inquiry)).rejects.toThrow("canceled");
    const outage = client(() => {
      throw new Error("dynamodb 장애(시험)");
    });
    await expect(outage.store.save(inquiry)).rejects.toThrow("dynamodb 장애");
  });

  it("기록은 강한 일관성으로 읽고, 없으면 undefined, 모양이 틀리면 던짐", async () => {
    const found = client(() => ({
      Item: {
        pk: "IDEMPOTENCY#x",
        fingerprint: "f".repeat(64),
        inquiryId: inquiry.inquiryId,
        receivedAt: inquiry.response.receivedAt,
        photos: inquiry.response.photos,
      },
    }));
    await expect(found.store.findReceipt(inquiry.idempotencyKey)).resolves.toEqual({
      fingerprint: "f".repeat(64),
      response: inquiry.response,
    });
    expect(found.commands[0]?.input).toMatchObject({
      Key: { pk: "IDEMPOTENCY#3f2504e0-4f89-41d3-9a0c-0305e82c3301" },
      ConsistentRead: true,
    });

    const missing = client(() => ({}));
    await expect(missing.store.findReceipt(inquiry.idempotencyKey)).resolves.toBeUndefined();

    for (const Item of [
      { pk: "IDEMPOTENCY#x" },
      { pk: "IDEMPOTENCY#x", fingerprint: "f", inquiryId: "i", receivedAt: "r" },
      { pk: "IDEMPOTENCY#x", fingerprint: 1, inquiryId: "i", receivedAt: "r", photos: [] },
    ]) {
      const broken = client(() => ({ Item }));
      await expect(
        broken.store.findReceipt(inquiry.idempotencyKey),
        JSON.stringify(Item),
      ).rejects.toThrow("멱등 기록");
    }
  });
});
