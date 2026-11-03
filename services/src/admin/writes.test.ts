import { describe, expect, it } from "vitest";
import { idempotencyKey, SAMPLE_CONFIG_KEY } from "./keys";
import { IDEMPOTENCY_TTL_SECONDS } from "./policy";
import { payloadHashOf, versionedWrite, type VersionedWrite } from "./writes";

// version 조건부 쓰기 + 멱등 키 (BRD-146, D16-B6)
// 가짜 DynamoDB: 항목을 메모리에 두고 트랜잭션 조건을 흉내 냄(품목 순서대로 취소 사유를 돌려줌)

type Item = Record<string, unknown>;

class FakeTable {
  readonly items = new Map<string, Item>();
  transactions = 0;

  private id(key: { pk: unknown; sk: unknown }) {
    return `${key.pk}|${key.sk}`;
  }

  async send(command: { constructor: { name: string }; input: any }) {
    const name = command.constructor.name;
    if (name === "GetCommand") {
      return { Item: this.items.get(this.id(command.input.Key)) };
    }
    if (name !== "TransactWriteCommand") throw new Error(name);
    this.transactions++;
    const [put, update] = command.input.TransactItems;
    const idem = put.Put.Item;
    const target = this.items.get(this.id(update.Update.Key));
    const values = update.Update.ExpressionAttributeValues;
    const codes = [
      this.items.has(this.id(idem)) ? "ConditionalCheckFailed" : "None",
      update.Update.ConditionExpression === "attribute_not_exists(pk)"
        ? target
          ? "ConditionalCheckFailed"
          : "None"
        : target?.version === values[":expected"]
          ? "None"
          : "ConditionalCheckFailed",
    ];
    if (codes.some((c) => c !== "None")) {
      const error = new Error("canceled") as Error & {
        CancellationReasons: { Code: string }[];
      };
      error.name = "TransactionCanceledException";
      error.CancellationReasons = codes.map((Code) => ({ Code }));
      throw error;
    }
    this.items.set(this.id(idem), idem);
    const names = update.Update.ExpressionAttributeNames;
    const next: Item = { ...(target ?? update.Update.Key) };
    for (const part of update.Update.UpdateExpression.replace("SET ", "").split(
      ", ",
    )) {
      const [n, v] = part.split(" = ");
      next[names[n]] = values[v];
    }
    this.items.set(this.id(update.Update.Key), next);
    return {};
  }
}

const NOW = new Date("2026-11-03T06:00:00Z");
const KEY = { pk: "admin#notice#1", sk: "draft" };

function write(overrides: Partial<VersionedWrite> = {}): VersionedWrite {
  return {
    key: KEY,
    expectedVersion: 0,
    set: { title: "점검 예고" },
    idempotencyKey: "0f8fad5b-d9cb-469f-a165-70867728950e",
    payloadHash: payloadHashOf('{"title":"점검 예고"}'),
    actorSub: "operator-sub",
    ...overrides,
  };
}

describe("versionedWrite", () => {
  it("새 항목을 version 1로 만들고 멱등 기록을 TTL과 함께 남긴다", async () => {
    const table = new FakeTable();
    expect(await versionedWrite(table as never, "Ops", write(), NOW)).toEqual({
      status: "applied",
      version: 1,
    });
    expect(table.items.get(`${KEY.pk}|${KEY.sk}`)).toMatchObject({
      title: "점검 예고",
      version: 1,
      updatedBy: "operator-sub",
      updatedAt: NOW.toISOString(),
    });
    const idem = table.items.get(
      `${idempotencyKey(write().idempotencyKey).pk}|idem`,
    );
    expect(idem).toMatchObject({
      resultVersion: 1,
      ttl: NOW.getTime() / 1000 + IDEMPOTENCY_TTL_SECONDS,
    });
  });

  it("읽은 version이 지금과 다르면 409(덮어쓰지 않음)", async () => {
    const table = new FakeTable();
    await versionedWrite(table as never, "Ops", write(), NOW);
    const stale = await versionedWrite(
      table as never,
      "Ops",
      write({
        expectedVersion: 0,
        idempotencyKey: "1f8fad5b-d9cb-469f-a165-70867728950e",
      }),
      NOW,
    );
    expect(stale).toEqual({ status: "conflict", reason: "version" });
    expect(table.items.get(`${KEY.pk}|${KEY.sk}`)?.version).toBe(1);
  });

  it("같은 키·같은 내용 재전송은 앞 결과를 돌려주고 다시 쓰지 않는다", async () => {
    const table = new FakeTable();
    await versionedWrite(table as never, "Ops", write(), NOW);
    expect(await versionedWrite(table as never, "Ops", write(), NOW)).toEqual({
      status: "replayed",
      version: 1,
    });
    expect(table.items.get(`${KEY.pk}|${KEY.sk}`)?.version).toBe(1);
  });

  it("같은 키·다른 내용은 409", async () => {
    const table = new FakeTable();
    await versionedWrite(table as never, "Ops", write(), NOW);
    const other = await versionedWrite(
      table as never,
      "Ops",
      write({ payloadHash: payloadHashOf('{"title":"다른 내용"}') }),
      NOW,
    );
    expect(other).toEqual({
      status: "conflict",
      reason: "idempotency_mismatch",
    });
  });

  it("같은 키를 다른 항목에 쓰면 409", async () => {
    const table = new FakeTable();
    await versionedWrite(table as never, "Ops", write(), NOW);
    const other = await versionedWrite(
      table as never,
      "Ops",
      write({ key: { pk: "admin#notice#2", sk: "draft" } }),
      NOW,
    );
    expect(other).toEqual({
      status: "conflict",
      reason: "idempotency_mismatch",
    });
  });

  it("같은 키·같은 내용이어도 다른 운영자면 409", async () => {
    const table = new FakeTable();
    await versionedWrite(table as never, "Ops", write(), NOW);
    const other = await versionedWrite(
      table as never,
      "Ops",
      write({ actorSub: "another-operator" }),
      NOW,
    );
    expect(other).toEqual({
      status: "conflict",
      reason: "idempotency_mismatch",
    });
  });

  it("값이 undefined인 속성은 이유를 밝혀 거부한다(500이 되지 않게)", async () => {
    const table = new FakeTable();
    await expect(
      versionedWrite(
        table as never,
        "Ops",
        write({ set: { title: "제목", memo: undefined } }),
        NOW,
      ),
    ).rejects.toThrow("값이 없는 속성: memo");
    expect(table.transactions).toBe(0);
  });

  it("동시에 같은 키로 두 번 보내도 한 번만 적용된다", async () => {
    const table = new FakeTable();
    const results = await Promise.all([
      versionedWrite(table as never, "Ops", write(), NOW),
      versionedWrite(table as never, "Ops", write(), NOW),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "applied",
      "replayed",
    ]);
    expect(table.items.get(`${KEY.pk}|${KEY.sk}`)?.version).toBe(1);
  });

  it("운영 API 범위 밖 키(게시 잠금·샘플 설정·멱등 기록)는 쓰지 않는다", async () => {
    const table = new FakeTable();
    for (const key of [
      { pk: "lock#publish", sk: "lock" },
      { pk: "publish", sk: "version" },
      SAMPLE_CONFIG_KEY,
      idempotencyKey("x"),
    ]) {
      await expect(
        versionedWrite(table as never, "Ops", write({ key }), NOW),
      ).rejects.toThrow("범위 밖");
    }
    expect(table.transactions).toBe(0);
  });

  it("멱등 키가 UUID v4가 아니면 쓰지 않는다", async () => {
    const table = new FakeTable();
    for (const idempotencyKey of [
      "",
      "x",
      "0F8FAD5B-D9CB-469F-A165-70867728950E",
    ]) {
      await expect(
        versionedWrite(table as never, "Ops", write({ idempotencyKey }), NOW),
      ).rejects.toThrow("UUID");
    }
    expect(table.transactions).toBe(0);
  });

  it("예약 속성(version·pk 등)을 바꾸려 하면 거부한다", async () => {
    const table = new FakeTable();
    await expect(
      versionedWrite(
        table as never,
        "Ops",
        write({ set: { version: 99 } }),
        NOW,
      ),
    ).rejects.toThrow("예약");
  });

  it("다른 트랜잭션 오류는 결과를 모르므로 그대로 던진다", async () => {
    const error = new Error("conflict");
    error.name = "TransactionConflictException";
    const client = {
      send: async () => {
        throw error;
      },
    };
    await expect(
      versionedWrite(client as never, "Ops", write(), NOW),
    ).rejects.toBe(error);
  });
});
