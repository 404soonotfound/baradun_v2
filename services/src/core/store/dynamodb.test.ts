import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  DynamoOpsStore,
  DynamoStateStore,
  type DocumentSender,
} from "./dynamodb";
import { SLOT_RECORD_RETENTION_MS } from "./types";

// DynamoDB 구현이 보내는 명령 검사 (BRD-55). AWS에 연결하지 않음
// 가짜 클라이언트가 받은 명령을 모으고, 미리 정한 응답(값 또는 오류)을 순서대로 돌려줌

const NOW = Date.UTC(2026, 9, 20, 5, 30);
const LEASE = 5 * 60 * 1000;
const OPS = "BaradunV2-StorageOpsTable-TEST";
const STATE = "BaradunV2-StorageStateTable-TEST";

type Command = GetCommand | PutCommand | UpdateCommand | DeleteCommand;

function fakeClient(...responses: Array<object | Error>) {
  const sent: Command[] = [];
  const client = {
    async send(command: Command) {
      sent.push(command);
      const next = responses.shift() ?? {};
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as DocumentSender;
  return { client, sent };
}

function conditionFailed(item?: Record<string, unknown>) {
  return new ConditionalCheckFailedException({
    message: "The conditional request failed",
    $metadata: {},
    ...(item ? { Item: item as never } : {}),
  });
}

const throttled = Object.assign(new Error("Rate exceeded"), {
  name: "ProvisionedThroughputExceededException",
});

describe("DynamoOpsStore 슬롯", () => {
  it("claimSlot은 기록 없음 또는 lease 지난 in_progress일 때만 쓰는 조건부 Put을 보낸다", async () => {
    const { client, sent } = fakeClient({});
    const ops = new DynamoOpsStore(client, OPS);

    expect(await ops.claimSlot("warnings", "s1", "run-a", NOW, LEASE)).toBe(
      "claimed",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(PutCommand);
    expect(sent[0]!.input).toEqual({
      TableName: OPS,
      Item: {
        pk: "slot#warnings",
        sk: "s1",
        status: "in_progress",
        owner: "run-a",
        leaseUntil: NOW + LEASE,
        ttl: Math.floor((NOW + SLOT_RECORD_RETENTION_MS) / 1000),
      },
      ConditionExpression:
        "attribute_not_exists(pk) OR (#status = :inProgress AND #leaseUntil < :now)",
      ExpressionAttributeNames: {
        "#status": "status",
        "#leaseUntil": "leaseUntil",
      },
      ExpressionAttributeValues: { ":inProgress": "in_progress", ":now": NOW },
      ReturnValuesOnConditionCheckFailure: "ALL_OLD",
    });
  });

  it("조건 실패 때 돌려받은 항목으로 done·busy를 가른다", async () => {
    const { client } = fakeClient(
      conditionFailed({ status: { S: "done" } }),
      conditionFailed({ status: { S: "in_progress" } }),
      conditionFailed(),
    );
    const ops = new DynamoOpsStore(client, OPS);
    expect(await ops.claimSlot("warnings", "s1", "run-b", NOW, LEASE)).toBe(
      "done",
    );
    expect(await ops.claimSlot("warnings", "s1", "run-b", NOW, LEASE)).toBe(
      "busy",
    );
    // 항목이 안 왔으면 맡지 않는 쪽(busy)
    expect(await ops.claimSlot("warnings", "s1", "run-b", NOW, LEASE)).toBe(
      "busy",
    );
  });

  it("completeSlot은 owner가 같을 때만 done으로 바꾸는 조건부 Update를 보낸다", async () => {
    const { client, sent } = fakeClient({}, conditionFailed());
    const ops = new DynamoOpsStore(client, OPS);

    expect(await ops.completeSlot("warnings", "s1", "run-a")).toBe(true);
    expect(await ops.completeSlot("warnings", "s1", "run-b")).toBe(false);
    expect(sent[0]).toBeInstanceOf(UpdateCommand);
    expect(sent[0]!.input).toEqual({
      TableName: OPS,
      Key: { pk: "slot#warnings", sk: "s1" },
      UpdateExpression: "SET #status = :done",
      ConditionExpression: "#owner = :owner",
      ExpressionAttributeNames: { "#status": "status", "#owner": "owner" },
      ExpressionAttributeValues: { ":done": "done", ":owner": "run-a" },
    });
  });
});

describe("DynamoOpsStore 잠금", () => {
  it("acquireLock은 기록 없음 또는 만료(expiresAt < now)일 때만 쓰는 조건부 Put을 보낸다", async () => {
    const { client, sent } = fakeClient({}, conditionFailed());
    const ops = new DynamoOpsStore(client, OPS);

    expect(await ops.acquireLock("publish", "run-a", NOW, LEASE)).toBe(true);
    expect(await ops.acquireLock("publish", "run-b", NOW, LEASE)).toBe(false);
    expect(sent[0]).toBeInstanceOf(PutCommand);
    expect(sent[0]!.input).toEqual({
      TableName: OPS,
      Item: {
        pk: "lock#publish",
        sk: "lock",
        owner: "run-a",
        expiresAt: NOW + LEASE,
      },
      ConditionExpression: "attribute_not_exists(pk) OR #expiresAt < :now",
      ExpressionAttributeNames: { "#expiresAt": "expiresAt" },
      ExpressionAttributeValues: { ":now": NOW },
    });
  });

  it("releaseLock은 owner가 같을 때만 지우는 조건부 Delete를 보낸다", async () => {
    const { client, sent } = fakeClient({}, conditionFailed());
    const ops = new DynamoOpsStore(client, OPS);

    expect(await ops.releaseLock("publish", "run-a")).toBe(true);
    expect(await ops.releaseLock("publish", "run-b")).toBe(false);
    expect(sent[0]).toBeInstanceOf(DeleteCommand);
    expect(sent[0]!.input).toEqual({
      TableName: OPS,
      Key: { pk: "lock#publish", sk: "lock" },
      ConditionExpression: "#owner = :owner",
      ExpressionAttributeNames: { "#owner": "owner" },
      ExpressionAttributeValues: { ":owner": "run-a" },
    });
  });

  it("조건 실패가 아닌 오류는 그대로 던진다", async () => {
    const { client } = fakeClient(throttled, throttled);
    const ops = new DynamoOpsStore(client, OPS);
    await expect(ops.acquireLock("publish", "run-a", NOW, LEASE)).rejects.toBe(
      throttled,
    );
    await expect(
      ops.claimSlot("warnings", "s1", "run-a", NOW, LEASE),
    ).rejects.toBe(throttled);
  });
});

describe("DynamoOpsStore 게시 버전", () => {
  it("지금보다 클 때만 바꾸는 조건부 Update를 보낸다", async () => {
    const { client, sent } = fakeClient({}, conditionFailed());
    const ops = new DynamoOpsStore(client, OPS);

    expect(await ops.setPublishedVersion("20261017T053000Z")).toBe(true);
    expect(await ops.setPublishedVersion("20261017T051500Z")).toBe(false);
    expect(sent[0]).toBeInstanceOf(UpdateCommand);
    expect(sent[0]!.input).toEqual({
      TableName: OPS,
      Key: { pk: "publish", sk: "version" },
      UpdateExpression: "SET #version = :version",
      ConditionExpression:
        "attribute_not_exists(#version) OR #version < :version",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":version": "20261017T053000Z" },
    });
  });

  it("형식이 다른 버전은 보내지 않고 오류", async () => {
    const { client, sent } = fakeClient();
    const ops = new DynamoOpsStore(client, OPS);
    await expect(ops.setPublishedVersion("20261017")).rejects.toThrow(
      "invalid snapshotVersion",
    );
    expect(sent).toHaveLength(0);
  });

  it("게시 버전을 강한 일관성으로 읽는다", async () => {
    const { client, sent } = fakeClient(
      {},
      { Item: { pk: "publish", sk: "version", version: "20261017T053000Z" } },
    );
    const ops = new DynamoOpsStore(client, OPS);
    expect(await ops.getPublishedVersion()).toBeNull();
    expect(await ops.getPublishedVersion()).toBe("20261017T053000Z");
    expect(sent[0]!.input).toEqual({
      TableName: OPS,
      Key: { pk: "publish", sk: "version" },
      ConsistentRead: true,
    });
  });
});

describe("DynamoStateStore", () => {
  const stored = {
    pk: "wave#1",
    sk: "latest",
    value: { height: 1.2 },
    orderAt: NOW,
    recordVersion: 3,
  };

  it("처음 쓰기는 항목이 없을 때만 쓰는 조건부 Put (recordVersion 1)", async () => {
    const { client, sent } = fakeClient({}, {});
    const state = new DynamoStateStore(client, STATE);

    expect(await state.putState("wave#1", "latest", { height: 1.2 }, NOW)).toBe(
      "written",
    );
    expect(sent[0]).toBeInstanceOf(GetCommand);
    expect(sent[0]!.input).toEqual({
      TableName: STATE,
      Key: { pk: "wave#1", sk: "latest" },
      ConsistentRead: true,
    });
    expect(sent[1]).toBeInstanceOf(PutCommand);
    expect(sent[1]!.input).toEqual({
      TableName: STATE,
      Item: { ...stored, recordVersion: 1 },
      ConditionExpression: "attribute_not_exists(pk)",
    });
  });

  it("다음 쓰기는 읽은 recordVersion과 같을 때만 쓰고 +1", async () => {
    const { client, sent } = fakeClient({ Item: stored }, {});
    const state = new DynamoStateStore(client, STATE);

    expect(
      await state.putState("wave#1", "latest", { height: 1.5 }, NOW + 1),
    ).toBe("written");
    expect(sent[1]!.input).toEqual({
      TableName: STATE,
      Item: {
        ...stored,
        value: { height: 1.5 },
        orderAt: NOW + 1,
        recordVersion: 4,
      },
      ConditionExpression: "#recordVersion = :expectedVersion",
      ExpressionAttributeNames: { "#recordVersion": "recordVersion" },
      ExpressionAttributeValues: { ":expectedVersion": 3 },
    });
  });

  it("읽은 뒤 다른 실행이 먼저 쓰면(조건 실패) conflict", async () => {
    const { client } = fakeClient({ Item: stored }, conditionFailed());
    const state = new DynamoStateStore(client, STATE);
    expect(
      await state.putState("wave#1", "latest", { height: 1.5 }, NOW + 1),
    ).toBe("conflict");
  });

  it("stale·unchanged는 읽기만 하고 쓰지 않는다", async () => {
    const { client, sent } = fakeClient({ Item: stored }, { Item: stored });
    const state = new DynamoStateStore(client, STATE);
    expect(
      await state.putState("wave#1", "latest", { height: 0.1 }, NOW - 1),
    ).toBe("stale");
    expect(await state.putState("wave#1", "latest", { height: 1.2 }, NOW)).toBe(
      "unchanged",
    );
    expect(sent.every((c) => c instanceof GetCommand)).toBe(true);
  });

  it("저장된 항목 모양이 다르면 오류", async () => {
    const { client } = fakeClient({ Item: { ...stored, orderAt: "x" } });
    const state = new DynamoStateStore(client, STATE);
    await expect(state.getState("wave#1", "latest")).rejects.toThrow(
      "invalid state item",
    );
  });

  it("Put 중 조건 실패가 아닌 오류는 그대로 던진다", async () => {
    const { client } = fakeClient({ Item: stored }, throttled);
    const state = new DynamoStateStore(client, STATE);
    await expect(
      state.putState("wave#1", "latest", { height: 1.5 }, NOW + 1),
    ).rejects.toBe(throttled);
  });
});
