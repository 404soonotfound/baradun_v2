import { describe, expect, it } from "vitest";
import { FakeTable, type Item } from "./test-dynamo";
import type { AuditEntry } from "./audit";
import {
  AUDIT_PREFIX,
  idempotencyKey,
  SAMPLE_CONFIG_KEY,
  type OpsKey,
} from "./keys";
import { AUDIT_TTL_SECONDS, IDEMPOTENCY_TTL_SECONDS } from "./policy";
import {
  payloadHashOf,
  versionedWrite,
  type VersionedWrite,
  type WriteTarget,
} from "./writes";

// version 조건부 쓰기 + 멱등 키 (BRD-146, D16-B6)
// 가짜 DynamoDB: 항목을 메모리에 두고 트랜잭션 조건을 흉내 냄(품목 순서대로 취소 사유를 돌려줌)

const TABLES = { ops: "Ops", inquiry: "Inquiry" };
const NOW = new Date("2026-11-03T06:00:00Z");
const KEY = { pk: "admin#notice#1", sk: "draft" };

const opsCreate = (key: OpsKey = KEY): WriteTarget => ({
  kind: "ops",
  key,
  mode: "create",
});

function audit(actorSub: string): AuditEntry {
  return {
    actor: { sub: actorSub, kind: "operator", role: "editor" },
    action: "inquiry.update",
    target: { kind: "inquiry", id: "x" },
    changes: ["status"],
    ids: { traceId: "trace-1", requestId: "req-1" },
  };
}

// 감사 기록 항목만 모음
function audits(table: FakeTable): Item[] {
  return [...table.items.values()].filter((i) =>
    String(i.pk).startsWith(AUDIT_PREFIX),
  );
}

function write(overrides: Partial<VersionedWrite> = {}): VersionedWrite {
  const actorSub = overrides.actorSub ?? "operator-sub";
  return {
    target: opsCreate(),
    expectedVersion: 0,
    set: { title: "점검 예고" },
    idempotencyKey: "0f8fad5b-d9cb-469f-a165-70867728950e",
    payloadHash: payloadHashOf('{"title":"점검 예고"}'),
    actorSub,
    audit: audit(actorSub),
    ...overrides,
  };
}

describe("versionedWrite", () => {
  it("새 항목을 version 1로 만들고 멱등 기록을 TTL과 함께 남긴다", async () => {
    const table = new FakeTable();
    expect(await versionedWrite(table as never, TABLES, write(), NOW)).toEqual({
      status: "applied",
      version: 1,
    });
    expect(table.items.get(table.id("Ops", KEY))).toMatchObject({
      title: "점검 예고",
      version: 1,
      updatedBy: "operator-sub",
      updatedAt: NOW.toISOString(),
    });
    const idem = table.items.get(
      table.id("Ops", idempotencyKey(write().idempotencyKey)),
    );
    expect(idem).toMatchObject({
      resultVersion: 1,
      ttl: NOW.getTime() / 1000 + IDEMPOTENCY_TTL_SECONDS,
    });
  });

  it("읽은 version이 지금과 다르면 409(덮어쓰지 않음)", async () => {
    const table = new FakeTable();
    await versionedWrite(table as never, TABLES, write(), NOW);
    const stale = await versionedWrite(
      table as never,
      TABLES,
      write({
        target: { kind: "ops", key: KEY, mode: "update" },
        expectedVersion: 2,
        idempotencyKey: "1f8fad5b-d9cb-469f-a165-70867728950e",
      }),
      NOW,
    );
    expect(stale).toEqual({ status: "conflict", reason: "version" });
    expect(table.items.get(table.id("Ops", KEY))?.version).toBe(1);
  });

  it("같은 키·같은 내용 재전송은 앞 결과를 돌려주고 다시 쓰지 않는다", async () => {
    const table = new FakeTable();
    await versionedWrite(table as never, TABLES, write(), NOW);
    expect(await versionedWrite(table as never, TABLES, write(), NOW)).toEqual({
      status: "replayed",
      version: 1,
    });
    expect(table.items.get(table.id("Ops", KEY))?.version).toBe(1);
  });

  it("같은 키·다른 내용은 409", async () => {
    const table = new FakeTable();
    await versionedWrite(table as never, TABLES, write(), NOW);
    const other = await versionedWrite(
      table as never,
      TABLES,
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
    await versionedWrite(table as never, TABLES, write(), NOW);
    const other = await versionedWrite(
      table as never,
      TABLES,
      write({ target: opsCreate({ pk: "admin#notice#2", sk: "draft" }) }),
      NOW,
    );
    expect(other).toEqual({
      status: "conflict",
      reason: "idempotency_mismatch",
    });
  });

  it("같은 키·같은 내용이어도 다른 운영자면 409", async () => {
    const table = new FakeTable();
    await versionedWrite(table as never, TABLES, write(), NOW);
    const other = await versionedWrite(
      table as never,
      TABLES,
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
        TABLES,
        write({ set: { title: "제목", memo: undefined } }),
        NOW,
      ),
    ).rejects.toThrow("값이 없는 속성: memo");
    expect(table.transactions).toBe(0);
  });

  it("동시에 같은 키로 두 번 보내도 한 번만 적용된다", async () => {
    const table = new FakeTable();
    const results = await Promise.all([
      versionedWrite(table as never, TABLES, write(), NOW),
      versionedWrite(table as never, TABLES, write(), NOW),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "applied",
      "replayed",
    ]);
    expect(table.items.get(table.id("Ops", KEY))?.version).toBe(1);
  });

  it("운영 API 범위 밖 키(게시 잠금·샘플 설정·멱등 기록·감사 기록)는 쓰지 않는다", async () => {
    const table = new FakeTable();
    for (const key of [
      { pk: "lock#publish", sk: "lock" },
      { pk: "publish", sk: "version" },
      SAMPLE_CONFIG_KEY,
      idempotencyKey("x"),
      { pk: `${AUDIT_PREFIX}2026-11`, sk: "2026-11-03T06:00:00.000Z#t" },
    ]) {
      for (const mode of ["create", "update"] as const) {
        await expect(
          versionedWrite(
            table as never,
            TABLES,
            write({
              target: { kind: "ops", key, mode },
              expectedVersion: mode === "create" ? 0 : 1,
            }),
            NOW,
          ),
        ).rejects.toThrow("범위 밖");
      }
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
        versionedWrite(table as never, TABLES, write({ idempotencyKey }), NOW),
      ).rejects.toThrow("UUID");
    }
    expect(table.transactions).toBe(0);
  });

  it("예약 속성(version·pk 등)을 바꾸려 하면 거부한다", async () => {
    const table = new FakeTable();
    await expect(
      versionedWrite(
        table as never,
        TABLES,
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
      versionedWrite(client as never, TABLES, write(), NOW),
    ).rejects.toBe(error);
  });
  it("감사 기록을 같은 트랜잭션에 1년 TTL로 남긴다(D16-B5)", async () => {
    const table = new FakeTable();
    await versionedWrite(table as never, TABLES, write(), NOW);
    expect(audits(table)).toEqual([
      expect.objectContaining({
        pk: `${AUDIT_PREFIX}2026-11`,
        sk: `${NOW.toISOString()}#trace-1`,
        actorSub: "operator-sub",
        action: "inquiry.update",
        changes: ["status"],
        ttl: NOW.getTime() / 1000 + AUDIT_TTL_SECONDS,
      }),
    ]);
  });

  it("재전송·version 충돌은 바뀐 것이 없으므로 감사 기록도 더하지 않는다", async () => {
    const table = new FakeTable();
    await versionedWrite(table as never, TABLES, write(), NOW);
    const later = new Date(NOW.getTime() + 1000);
    const again = {
      ...audit("operator-sub"),
      ids: { traceId: "t2", requestId: "r2" },
    };
    await versionedWrite(
      table as never,
      TABLES,
      write({ audit: again }),
      later,
    );
    await versionedWrite(
      table as never,
      TABLES,
      write({
        idempotencyKey: "1f8fad5b-d9cb-469f-a165-70867728950e",
        audit: { ...again, ids: { traceId: "t3", requestId: "r3" } },
      }),
      later,
    );
    expect(audits(table)).toHaveLength(1);
  });

  it("같은 감사 키가 이미 있으면 덮어쓰지 않고 던진다(추가 전용)", async () => {
    const table = new FakeTable();
    await versionedWrite(table as never, TABLES, write(), NOW);
    await expect(
      versionedWrite(
        table as never,
        TABLES,
        write({
          target: opsCreate({ pk: "admin#notice#2", sk: "draft" }),
          idempotencyKey: "1f8fad5b-d9cb-469f-a165-70867728950e",
        }),
        NOW,
      ),
    ).rejects.toThrow("canceled");
    expect(
      table.items.has(table.id("Ops", { pk: "admin#notice#2", sk: "draft" })),
    ).toBe(false);
  });

  it("감사 기록의 운영자가 다르거나 샘플이면 쓰지 않는다", async () => {
    const table = new FakeTable();
    await expect(
      versionedWrite(
        table as never,
        TABLES,
        write({ audit: audit("someone-else") }),
        NOW,
      ),
    ).rejects.toThrow("감사");
    await expect(
      versionedWrite(
        table as never,
        TABLES,
        write({
          audit: {
            ...audit("operator-sub"),
            actor: { sub: "operator-sub", kind: "sample", role: "sample" },
          },
        }),
        NOW,
      ),
    ).rejects.toThrow("감사");
    expect(table.transactions).toBe(0);
  });
});

describe("versionedWrite · 문의 항목", () => {
  const INQUIRY_ID = "123e4567-e89b-42d3-a456-426614174000";
  const nowSec = NOW.getTime() / 1000;

  function seed(table: FakeTable, item: Item) {
    table.items.set(table.id("Inquiry", { pk: `INQUIRY#${INQUIRY_ID}` }), {
      pk: `INQUIRY#${INQUIRY_ID}`,
      kind: "inquiry",
      inquiryStatus: "received",
      version: 1,
      ttl: nowSec + 3600,
      ...item,
    });
  }

  const inquiryWrite = (overrides: Partial<VersionedWrite> = {}) =>
    write({
      target: { kind: "inquiry", inquiryId: INQUIRY_ID },
      expectedVersion: 1,
      set: { inquiryStatus: "in_progress" },
      ...overrides,
    });

  it("있는 문의를 version 조건부로 바꾸고 멱등 기록은 Ops에 남긴다", async () => {
    const table = new FakeTable();
    seed(table, {});
    expect(
      await versionedWrite(table as never, TABLES, inquiryWrite(), NOW),
    ).toEqual({ status: "applied", version: 2 });
    expect(
      table.items.get(table.id("Inquiry", { pk: `INQUIRY#${INQUIRY_ID}` })),
    ).toMatchObject({ inquiryStatus: "in_progress", version: 2 });
    expect(
      table.items.get(table.id("Ops", idempotencyKey(write().idempotencyKey))),
    ).toMatchObject({ target: `inquiry|${INQUIRY_ID}`, resultVersion: 2 });
  });

  it("없는 문의·보관 기한이 지난 문의·문의가 아닌 항목은 409(만들지 않음)", async () => {
    const missing = new FakeTable();
    expect(
      await versionedWrite(missing as never, TABLES, inquiryWrite(), NOW),
    ).toEqual({ status: "conflict", reason: "version" });
    expect(missing.items.size).toBe(0);

    const expired = new FakeTable();
    seed(expired, { ttl: nowSec });
    expect(
      await versionedWrite(expired as never, TABLES, inquiryWrite(), NOW),
    ).toEqual({ status: "conflict", reason: "version" });

    const other = new FakeTable();
    seed(other, { kind: "inquiry_email" });
    expect(
      await versionedWrite(other as never, TABLES, inquiryWrite(), NOW),
    ).toEqual({ status: "conflict", reason: "version" });
  });

  it("이전 전 문의(version 없음)는 expectedVersion 0으로만 바꾼다", async () => {
    const table = new FakeTable();
    seed(table, { version: undefined, inquiryStatus: undefined });
    expect(
      await versionedWrite(table as never, TABLES, inquiryWrite(), NOW),
    ).toEqual({ status: "conflict", reason: "version" });
    expect(
      await versionedWrite(
        table as never,
        TABLES,
        inquiryWrite({
          expectedVersion: 0,
          idempotencyKey: "1f8fad5b-d9cb-469f-a165-70867728950e",
        }),
        NOW,
      ),
    ).toEqual({ status: "applied", version: 1 });
  });

  it("문의 ID가 UUID v4가 아니면 쓰지 않는다", async () => {
    const table = new FakeTable();
    await expect(
      versionedWrite(
        table as never,
        TABLES,
        inquiryWrite({ target: { kind: "inquiry", inquiryId: "../x" } }),
        NOW,
      ),
    ).rejects.toThrow("UUID");
    expect(table.transactions).toBe(0);
  });
});
