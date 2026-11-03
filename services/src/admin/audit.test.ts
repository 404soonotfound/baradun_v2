import { describe, expect, it } from "vitest";
import {
  AUDIT_PAGE_DEFAULT,
  auditItem,
  listAudit,
  parseAuditQuery,
  recordAudit,
  type AuditEntry,
  type AuditQuery,
} from "./audit";
import { AUDIT_PREFIX } from "./keys";
import { AUDIT_TTL_SECONDS } from "./policy";
import { FakeTable } from "./test-dynamo";

// 변경 이력 (BRD-155, D16-B5)

const NOW = new Date("2026-11-03T06:00:00Z");

function entry(n: number, overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    actor: { sub: "editor-sub", kind: "operator", role: "editor" },
    action: "inquiry.update",
    target: { kind: "inquiry", id: `id-${n}` },
    changes: ["status"],
    statusFrom: "received",
    statusTo: "in_progress",
    ids: {
      traceId: `trace-${String(n).padStart(4, "0")}`,
      requestId: `req-${n}`,
    },
    ...overrides,
  };
}

function query(params: Record<string, string>): AuditQuery {
  const check = parseAuditQuery(params, NOW);
  if (!check.ok) throw new Error(check.field);
  return check.query;
}

// 시각 목록으로 기록을 넣음. 홀수 번째는 샘플 조회
async function seed(times: string[]): Promise<FakeTable> {
  const table = new FakeTable();
  for (const [i, at] of times.entries()) {
    await recordAudit(
      table as never,
      "Ops",
      i % 2 === 1
        ? entry(i, {
            actor: { sub: "sample-sub", kind: "sample", role: "sample" },
            action: "sample.read",
            target: { kind: "route", id: "GET /ops/me" },
            changes: [],
          })
        : entry(i),
      new Date(at),
    );
  }
  return table;
}

describe("감사 기록 항목", () => {
  it("UTC 월 파티션·시각 정렬 키·1년 TTL로 만든다", () => {
    expect(auditItem(entry(1), NOW)).toEqual({
      pk: `${AUDIT_PREFIX}2026-11`,
      sk: `${NOW.toISOString()}#trace-0001`,
      kind: "audit",
      at: NOW.toISOString(),
      actorSub: "editor-sub",
      actorKind: "operator",
      role: "editor",
      action: "inquiry.update",
      targetKind: "inquiry",
      targetId: "id-1",
      changes: ["status"],
      statusFrom: "received",
      statusTo: "in_progress",
      requestId: "req-1",
      traceId: "trace-0001",
      ttl: NOW.getTime() / 1000 + AUDIT_TTL_SECONDS,
    });
  });

  it("KST로 다음 날이어도 UTC 월로 나눈다", () => {
    // 2026-11-30T15:00Z = 12월 1일 0시(KST)
    expect(auditItem(entry(1), new Date("2026-11-30T15:00:00Z")).pk).toBe(
      `${AUDIT_PREFIX}2026-11`,
    );
  });

  it("같은 키에는 다시 쓰지 않는다(추가 전용)", async () => {
    const table = new FakeTable();
    await recordAudit(table as never, "Ops", entry(1), NOW);
    await expect(
      recordAudit(
        table as never,
        "Ops",
        entry(1, { action: "sample.read" }),
        NOW,
      ),
    ).rejects.toThrow("exists");
    expect(table.puts).toBe(1);
  });
});

describe("목록 요청 검사", () => {
  it("기본은 지금부터 30일 전까지·50개", () => {
    expect(query({})).toEqual({
      filter: {
        from: "2026-10-04T06:00:00.000Z",
        to: NOW.toISOString(),
      },
      limit: AUDIT_PAGE_DEFAULT,
    });
  });

  it("366일까지 받는다", () => {
    expect(
      parseAuditQuery(
        { from: "2025-11-02T06:00:00Z", to: "2026-11-03T06:00:00Z" },
        NOW,
      ).ok,
    ).toBe(true);
  });
});

describe("목록", () => {
  it("월을 넘어 최근 기록부터 읽고 cursor로 이어 간다(빠짐·겹침 없음)", async () => {
    const times = [
      "2026-09-01T00:00:00Z",
      "2026-09-15T00:00:00Z",
      "2026-10-01T00:00:00Z",
      "2026-11-01T00:00:00Z",
      "2026-11-02T00:00:00Z",
    ];
    const table = await seed(times);
    const seen: string[] = [];
    let cursor: string | undefined;
    const base = {
      from: "2026-08-01T00:00:00Z",
      to: NOW.toISOString(),
      limit: "2",
    };
    do {
      const page = await listAudit(
        table as never,
        "Ops",
        query({ ...base, ...(cursor ? { cursor } : {}) }),
      );
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.at));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(times.map((t) => new Date(t).toISOString()).reverse());
  });

  it("기간 밖 기록은 넣지 않는다", async () => {
    const table = await seed([
      "2026-10-31T23:59:59Z",
      "2026-11-01T00:00:00Z",
      "2026-11-02T00:00:00Z",
    ]);
    const page = await listAudit(
      table as never,
      "Ops",
      query({ from: "2026-11-01T00:00:00Z", to: "2026-11-01T23:59:59Z" }),
    );
    expect(page.items.map((i) => i.at)).toEqual(["2026-11-01T00:00:00.000Z"]);
    expect(page.nextCursor).toBeNull();
  });

  it("종류 필터는 쪽마다 Limit을 넘기지 않고 다음 쪽에서 이어 간다", async () => {
    const table = await seed([
      "2026-11-01T00:00:00Z",
      "2026-11-01T01:00:00Z",
      "2026-11-01T02:00:00Z",
      "2026-11-01T03:00:00Z",
      "2026-11-01T04:00:00Z",
    ]);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listAudit(
        table as never,
        "Ops",
        query({
          action: "inquiry.update",
          limit: "2",
          ...(cursor ? { cursor } : {}),
        }),
      );
      expect(page.items.every((i) => i.action === "inquiry.update")).toBe(true);
      seen.push(...page.items.map((i) => i.at.slice(11, 13)));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(["04", "02", "00"]);
  });

  it("해가 바뀌는 월도 이어 읽는다", async () => {
    const table = await seed(["2025-12-31T00:00:00Z", "2026-01-01T00:00:00Z"]);
    const page = await listAudit(
      table as never,
      "Ops",
      query({ from: "2025-12-01T00:00:00Z", to: "2026-01-31T00:00:00Z" }),
    );
    expect(page.items.map((i) => i.at.slice(0, 10))).toEqual([
      "2026-01-01",
      "2025-12-31",
    ]);
  });

  it("저장된 모양이 틀린 기록은 조용히 빼지 않고 던진다", async () => {
    const table = await seed(["2026-11-01T00:00:00Z"]);
    const [id, item] = [...table.items.entries()][0]!;
    table.items.set(id, { ...item, action: "unknown" });
    await expect(listAudit(table as never, "Ops", query({}))).rejects.toThrow(
      "모양",
    );
  });
});

describe("cursor", () => {
  async function firstCursor(params: Record<string, string>) {
    const table = await seed([
      "2026-11-01T00:00:00Z",
      "2026-11-01T01:00:00Z",
      "2026-11-01T02:00:00Z",
    ]);
    const page = await listAudit(
      table as never,
      "Ops",
      query({ ...params, limit: "1" }),
    );
    return page.nextCursor!;
  }

  it("cursor만 보내면 담긴 필터를 그대로 쓰고, 같은 필터를 함께 보내도 된다", async () => {
    const cursor = await firstCursor({ action: "inquiry.update" });
    expect(query({ cursor }).filter.action).toBe("inquiry.update");
    expect(parseAuditQuery({ cursor, action: "inquiry.update" }, NOW).ok).toBe(
      true,
    );
  });

  it("다른 필터와 섞으면 거부한다", async () => {
    const cursor = await firstCursor({ action: "inquiry.update" });
    for (const other of [
      { action: "sample.read" },
      { actor: "someone" },
      { from: "2026-10-01T00:00:00Z" },
    ]) {
      expect(parseAuditQuery({ cursor, ...other }, NOW)).toEqual({
        ok: false,
        field: "cursor",
      });
    }
  });

  it.each([
    [
      "다른 월의 키",
      { m: "2026-11", k: { pk: `${AUDIT_PREFIX}2026-10`, sk: "s" } },
    ],
    ["기간 밖 월", { m: "2026-09" }],
    ["감사가 아닌 키", { m: "2026-11", k: { pk: "lock#publish", sk: "lock" } }],
    [
      "키에 다른 칸",
      { m: "2026-11", k: { pk: `${AUDIT_PREFIX}2026-11`, sk: "s", x: "1" } },
    ],
    ["시간대 없는 기간", { from: "2026-10-04T06:00:00", m: "2026-11" }],
  ])("%s이면 거부", (_, overrides) => {
    const cursor = Buffer.from(
      JSON.stringify({
        from: "2026-10-04T06:00:00.000Z",
        to: NOW.toISOString(),
        ...overrides,
      }),
    ).toString("base64url");
    expect(parseAuditQuery({ cursor }, NOW)).toEqual({
      ok: false,
      field: "cursor",
    });
  });
});
