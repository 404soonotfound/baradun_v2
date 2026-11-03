import { describe, expect, it } from "vitest";
import { backfillInquiryStatus, verifyInquiryIndex } from "./inquiry-backfill";

// 기존 문의 상태 이전 (BRD-153, 구현 제안 I07)
// 가짜 테이블: Scan(페이지), 조건부 Update, 상태 GSI COUNT Query만 흉내 냄

const NOW = new Date("2026-11-03T06:00:00Z");
const NOW_SEC = NOW.getTime() / 1000;

type Item = Record<string, unknown>;

class FakeInquiryTable {
  updates = 0;
  constructor(readonly items: Item[]) {}

  async send(command: { constructor: { name: string }; input: any }) {
    const input = command.input;
    const name = command.constructor.name;
    if (name === "ScanCommand") {
      const start = input.ExclusiveStartKey
        ? this.items.findIndex((i) => i.pk === input.ExclusiveStartKey.pk) + 1
        : 0;
      const page = this.items.slice(start, start + input.Limit);
      const filtered = page.filter(
        (i) =>
          i.kind === "inquiry" &&
          (input.ExpressionAttributeValues[":nowSec"] === undefined ||
            (i.ttl as number) > input.ExpressionAttributeValues[":nowSec"]),
      );
      const more = start + input.Limit < this.items.length;
      return {
        Items: filtered,
        ...(more ? { LastEvaluatedKey: { pk: page.at(-1)!.pk } } : {}),
      };
    }
    if (name === "UpdateCommand") {
      const item = this.items.find((i) => i.pk === input.Key.pk);
      const v = input.ExpressionAttributeValues;
      if (
        !item ||
        item.kind !== "inquiry" ||
        item.inquiryStatus !== undefined ||
        !((item.ttl as number) > v[":nowSec"])
      ) {
        const error = new Error("condition");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      this.updates++;
      Object.assign(item, {
        inquiryStatus: v[":received"],
        version: v[":one"],
        legacy: v[":true"],
      });
      return {};
    }
    if (name === "QueryCommand") {
      const status = input.ExpressionAttributeValues[":s"];
      const count = this.items.filter(
        (i) =>
          i.inquiryStatus === status &&
          (i.ttl as number) > input.ExpressionAttributeValues[":nowSec"],
      ).length;
      return { Count: count };
    }
    throw new Error(name);
  }
}

function seed(): Item[] {
  return [
    { pk: "INQUIRY#1", kind: "inquiry", ttl: NOW_SEC + 100, receivedAt: "a" },
    {
      pk: "INQUIRY#2",
      kind: "inquiry",
      ttl: NOW_SEC + 100,
      inquiryStatus: "in_progress",
      version: 4,
    },
    { pk: "INQUIRY#3", kind: "inquiry", ttl: NOW_SEC },
    { pk: "INQUIRY_EMAIL#1", kind: "inquiry_email", ttl: NOW_SEC + 100 },
    { pk: "RATE#1", ttl: NOW_SEC + 100 },
    { pk: "INQUIRY#4", kind: "inquiry", ttl: NOW_SEC + 100 },
  ];
}

const fast = { pageSize: 2, pauseMs: 0, sleep: async () => {} };

describe("기존 문의 상태 이전", () => {
  it("dry-run은 세기만 하고 쓰지 않는다", async () => {
    const table = new FakeInquiryTable(seed());
    const report = await backfillInquiryStatus(table as never, "T", {
      apply: false,
      now: NOW,
      ...fast,
    });
    expect(report).toMatchObject({
      scanned: 4,
      alreadyHasStatus: 1,
      expired: 1,
      candidates: 2,
      updated: 0,
    });
    expect(table.updates).toBe(0);
  });

  it("apply는 상태 없는 문의만 접수·version 1·이전 문의로 채우고 접수 시각·ttl은 그대로 둔다", async () => {
    const items = seed();
    const table = new FakeInquiryTable(items);
    const report = await backfillInquiryStatus(table as never, "T", {
      apply: true,
      now: NOW,
      ...fast,
    });
    expect(report).toMatchObject({ candidates: 2, updated: 2, skipped: 0 });
    expect(items[0]).toMatchObject({
      inquiryStatus: "received",
      version: 1,
      legacy: true,
      receivedAt: "a",
      ttl: NOW_SEC + 100,
    });
    // 이미 처리 중인 문의·기한 지난 문의는 그대로
    expect(items[1]).toMatchObject({
      inquiryStatus: "in_progress",
      version: 4,
    });
    expect(items[2]).not.toHaveProperty("inquiryStatus");
  });

  it("다시 돌려도 결과가 같다", async () => {
    const table = new FakeInquiryTable(seed());
    await backfillInquiryStatus(table as never, "T", {
      apply: true,
      now: NOW,
      ...fast,
    });
    const again = await backfillInquiryStatus(table as never, "T", {
      apply: true,
      now: NOW,
      ...fast,
    });
    expect(again).toMatchObject({ candidates: 0, updated: 0 });
  });

  it("원본과 GSI 개수를 대조한다", async () => {
    const table = new FakeInquiryTable(seed());
    const before = await verifyInquiryIndex(table as never, "T", NOW, fast);
    expect(before).toMatchObject({
      alive: 3,
      withoutStatus: 2,
      matches: false,
    });
    await backfillInquiryStatus(table as never, "T", {
      apply: true,
      now: NOW,
      ...fast,
    });
    const after = await verifyInquiryIndex(table as never, "T", NOW, fast);
    expect(after).toMatchObject({
      alive: 3,
      withoutStatus: 0,
      indexed: { received: 2, in_progress: 1, resolved: 0, rejected: 0 },
      matches: true,
    });
  });
});
