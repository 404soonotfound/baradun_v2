import { readFileSync } from "node:fs";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { MemorySnapshotStore } from "../core/snapshots/memory";
import type { SnapshotStore } from "../core/snapshots/types";
import type { AuthDependencies } from "./auth";
import { readBeachStatus } from "./beaches";
import { handleOps, type OpsDependencies } from "./handler";
import { MEMO_MAX } from "./inquiries";
import { AUDIT_PREFIX, beachMemoKey } from "./keys";
import { liveNotices, queryNotices } from "./notices";
import { ACCESS_TOKEN_HEADER, IDEMPOTENCY_KEY_HEADER } from "./policy";
import { FakeTable, type Item } from "./test-dynamo";
import { TEST_CONFIG } from "./test-tokens";

// 운영 API 해변 관리 경로 (BRD-150, ADM-BCH). 토큰 검증은 가짜, DB는 test-dynamo 가짜, 게시본은 메모리 저장소
// - 지금 표시 상태는 게시본 status.json 그대로. 못 읽으면 available: false(정상처럼 보이지 않게)
// - 운영 메모는 Ops 테이블에만. 변경 이력에 메모 글을 복사하지 않고, publisher가 읽는 공지 파티션에 들어가지 않음

const NOW = new Date("2026-11-11T03:00:00Z");
const NOW_SEC = NOW.getTime() / 1000;
const ISS = (pool: string) =>
  `https://cognito-idp.ap-northeast-2.amazonaws.com/${pool}`;

const root = new URL("../../../", import.meta.url);
const example = (name: string) =>
  readFileSync(
    new URL(`packages/contracts/examples/valid/${name}`, root),
    "utf8",
  );
const MANIFEST = example("manifest.json");
const STATUS = example("status.json");
const STATUS_PATH = "data/20261017T053000Z/status.json";

function snapshots(
  files: Record<string, string> = {
    "data/manifest.json": MANIFEST,
    [STATUS_PATH]: STATUS,
  },
): MemorySnapshotStore {
  const store = new MemorySnapshotStore();
  for (const [path, body] of Object.entries(files)) {
    store.files.set(path, { body, cacheControl: "", etag: '"t"' });
  }
  return store;
}

function claims(group: string) {
  return group === "sample"
    ? {
        sub: "sample-sub",
        iss: ISS(TEST_CONFIG.sample.userPoolId),
        auth_time: NOW_SEC - 60,
        "cognito:groups": ["sample"],
      }
    : {
        sub: `${group}-sub`,
        iss: ISS(TEST_CONFIG.operator.userPoolId),
        auth_time: NOW_SEC - 60,
        "cognito:groups": [group],
      };
}

let seq = 0;
function nextIds() {
  seq++;
  const n = String(seq).padStart(6, "0");
  return { traceId: `trace-${n}`, requestId: `req-${n}` };
}

let keySeq = 0;
function newKey(): string {
  keySeq++;
  return `${String(keySeq).padStart(8, "0")}-d9cb-469f-a165-70867728950e`;
}

function deps(
  group: string,
  table: FakeTable,
  store: SnapshotStore | null = null,
): OpsDependencies {
  const auth: AuthDependencies = {
    config: TEST_CONFIG,
    verifier: { verify: async () => claims(group) },
    samplePolicy: async () => ({
      subs: ["sample-sub"],
      allowedFrom: new Date(NOW.getTime() - 3_600_000),
      allowedUntil: new Date(NOW.getTime() + 3_600_000),
    }),
    now: () => NOW,
  };
  return {
    auth,
    data: {
      client: table as never,
      opsTable: "Ops",
      inquiryTable: "Inquiry",
      now: () => NOW,
      snapshots: store,
    },
    ids: nextIds,
  };
}

function event(
  method: string,
  path: string,
  body?: unknown,
  key: string | null = newKey(),
): APIGatewayProxyEventV2 {
  return {
    rawPath: path,
    headers: {
      [ACCESS_TOKEN_HEADER]: "token",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(key ? { [IDEMPOTENCY_KEY_HEADER]: key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method } },
  } as unknown as APIGatewayProxyEventV2;
}

const parse = (result: { body?: string | undefined }) =>
  JSON.parse(result.body!);

function audits(table: FakeTable): Item[] {
  return [...table.items.values()]
    .filter((i) => String(i.pk).startsWith(AUDIT_PREFIX))
    .sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
}

const MEMO = "주차장 공사 중이라 현장 안내판 위치가 바뀜. 010-1234-5678 담당";

async function putMemo(
  table: FakeTable,
  version: number,
  memo: string | null = MEMO,
  group = "editor",
  key = newKey(),
) {
  return handleOps(
    event("PUT", "/ops/beaches/b0001/memo", { version, memo }, key),
    deps(group, table),
  );
}

describe("지금 표시 상태 GET /ops/beaches/published", () => {
  it("게시본 status.json의 분류·사유·validUntil을 그대로 돌려준다(다시 계산하지 않음)", async () => {
    const result = await handleOps(
      event("GET", "/ops/beaches/published"),
      deps("viewer", new FakeTable(), snapshots()),
    );
    expect(result.statusCode).toBe(200);
    const body = parse(result);
    expect(body).toMatchObject({
      available: true,
      snapshotVersion: "20261017T053000Z",
      generatedAt: "2026-10-17T05:30:12Z",
    });
    const source = JSON.parse(STATUS).beaches;
    expect(Object.keys(body.beaches).sort()).toEqual(
      Object.keys(source).sort(),
    );
    for (const [id, beach] of Object.entries(source)) {
      const { category, reasons, validUntil } = beach as {
        category: string;
        reasons: unknown;
        validUntil: string;
      };
      expect(body.beaches[id]).toEqual({ category, reasons, validUntil });
    }
  });

  it("게시 버킷 설정이 없으면 '특보 없음'이 아니라 available: false", async () => {
    const result = await handleOps(
      event("GET", "/ops/beaches/published"),
      deps("viewer", new FakeTable(), null),
    );
    expect(result.statusCode).toBe(200);
    expect(parse(result)).toEqual({
      available: false,
      reason: "not_configured",
    });
  });

  it("manifest·status가 없거나 계약에 맞지 않거나 읽다 실패하면 available: false", async () => {
    const broken = JSON.parse(STATUS) as {
      beaches: Record<string, Record<string, unknown>>;
    };
    broken.beaches.b0094!.category = "safe";
    const otherPath = JSON.stringify({
      ...JSON.parse(MANIFEST),
      files: {
        ...JSON.parse(MANIFEST).files,
        status: "/admin/status.json",
      },
    });
    const cases: [Record<string, string>, string][] = [
      [{}, "manifest_missing"],
      [{ "data/manifest.json": "{" }, "manifest_invalid"],
      [{ "data/manifest.json": otherPath }, "manifest_invalid"],
      [{ "data/manifest.json": MANIFEST }, "status_missing"],
      [
        {
          "data/manifest.json": MANIFEST,
          [STATUS_PATH]: JSON.stringify(broken),
        },
        "status_invalid",
      ],
    ];
    for (const [files, reason] of cases) {
      expect(await readBeachStatus(snapshots(files))).toEqual({
        available: false,
        reason,
      });
    }
    const failing = snapshots();
    failing.getFile = async () => {
      throw new Error("S3 AccessDenied");
    };
    expect(await readBeachStatus(failing)).toEqual({
      available: false,
      reason: "read_failed",
    });
  });

  it("샘플 계정도 받는다(공개 게시본과 같은 값). 조회는 변경 이력에 남는다", async () => {
    const table = new FakeTable();
    const result = await handleOps(
      event("GET", "/ops/beaches/published"),
      deps("sample", table, snapshots()),
    );
    expect(result.statusCode).toBe(200);
    expect(audits(table)).toEqual([
      expect.objectContaining({
        action: "sample.read",
        targetId: "GET /ops/beaches/published",
      }),
    ]);
  });

  it("상태를 쓰는 method는 없다(G1)", async () => {
    for (const method of ["PUT", "POST", "PATCH", "DELETE"]) {
      const result = await handleOps(
        event(method, "/ops/beaches/published", {}),
        deps("publisher", new FakeTable(), snapshots()),
      );
      expect(result.statusCode).toBe(405);
    }
  });
});

describe("운영 메모 /ops/beaches/{id}/memo", () => {
  it("저장한 적 없으면 version 0, 빈 메모", async () => {
    const result = await handleOps(
      event("GET", "/ops/beaches/b0001/memo"),
      deps("viewer", new FakeTable()),
    );
    expect(result.statusCode).toBe(200);
    expect(parse(result)).toEqual({
      beachId: "b0001",
      memo: null,
      version: 0,
      updatedAt: null,
    });
  });

  it("편집 권한이 저장하고, 변경 이력에는 바뀐 항목 이름만 남기고 메모 글은 복사하지 않는다", async () => {
    const table = new FakeTable();
    const first = await putMemo(table, 0);
    expect(first.statusCode).toBe(200);
    expect(parse(first)).toEqual({ beachId: "b0001", version: 1 });
    expect(
      table.items.get(table.id("Ops", beachMemoKey("b0001"))),
    ).toMatchObject({ memo: MEMO, version: 1, updatedBy: "editor-sub" });

    const read = await handleOps(
      event("GET", "/ops/beaches/b0001/memo"),
      deps("viewer", table),
    );
    expect(parse(read)).toMatchObject({ memo: MEMO, version: 1 });

    const [audit] = audits(table);
    expect(audit).toMatchObject({
      action: "beach.memo",
      targetKind: "beach",
      targetId: "b0001",
      changes: ["beachMemo"],
      actorSub: "editor-sub",
    });
    expect(JSON.stringify(audit)).not.toContain("주차장");
    expect(JSON.stringify(audits(table))).not.toContain(MEMO);
  });

  it("변경 이력 화면 목록에 해변 메모 기록이 대상(해변 ID)과 함께 보인다", async () => {
    const table = new FakeTable();
    await putMemo(table, 0);
    const result = await handleOps(
      {
        ...event("GET", "/ops/audit"),
        queryStringParameters: { category: "beach" },
      },
      deps("viewer", table),
    );
    expect(result.statusCode).toBe(200);
    expect(parse(result).items).toEqual([
      expect.objectContaining({
        action: "beach.memo",
        target: { kind: "beach", id: "b0001" },
        changes: ["beachMemo"],
      }),
    ]);
  });

  it("다른 version이면 409로 덮어쓰지 않는다. 같은 키 재전송은 한 번만 저장", async () => {
    const table = new FakeTable();
    const key = newKey();
    expect((await putMemo(table, 0, MEMO, "editor", key)).statusCode).toBe(200);
    const again = await putMemo(table, 0, MEMO, "editor", key);
    expect(again.statusCode).toBe(200);
    expect(parse(again).version).toBe(1);
    // 다른 사람이 먼저 만든 뒤 version 0으로 다시 만들기
    const stale = await putMemo(table, 0, "다른 내용");
    expect(stale.statusCode).toBe(409);
    expect(parse(stale).error.reason).toBe("version");
    const updated = await putMemo(table, 1, "고친 메모");
    expect(parse(updated).version).toBe(2);
    expect(audits(table)).toHaveLength(2);
  });

  it("공백만 남긴 메모는 '메모 없음'(null)으로 저장", async () => {
    const table = new FakeTable();
    await putMemo(table, 0);
    await putMemo(table, 1, "   ");
    expect(
      table.items.get(table.id("Ops", beachMemoKey("b0001")))?.memo,
    ).toBeNull();
  });

  it("보기 권한·샘플은 저장하지 못하고, 샘플은 메모를 읽지도 못한다(거절은 변경 이력에 남음)", async () => {
    const table = new FakeTable();
    expect((await putMemo(table, 0, MEMO, "viewer")).statusCode).toBe(403);
    expect((await putMemo(table, 0, MEMO, "sample")).statusCode).toBe(403);
    const read = await handleOps(
      event("GET", "/ops/beaches/b0001/memo"),
      deps("sample", table),
    );
    expect(read.statusCode).toBe(403);
    expect(table.items.has(table.id("Ops", beachMemoKey("b0001")))).toBe(false);
    expect(audits(table).map((a) => a.action)).toEqual([
      "sample.denied",
      "sample.denied",
    ]);
  });

  it("해변 ID 모양이 아니면 404, 글자 수 상한·모르는 칸·멱등 키 없음은 400", async () => {
    const table = new FakeTable();
    const bad = await handleOps(
      event("PUT", "/ops/beaches/..%2Fnotice/memo", { version: 0, memo: "x" }),
      deps("editor", table),
    );
    expect(bad.statusCode).toBe(404);
    const long = await putMemo(table, 0, "가".repeat(MEMO_MAX + 1));
    expect(parse(long).error.field).toBe("memo");
    const extra = await handleOps(
      event("PUT", "/ops/beaches/b0001/memo", {
        version: 0,
        memo: "x",
        hidden: true,
      }),
      deps("editor", table),
    );
    expect(parse(extra).error.field).toBe("hidden");
    const noKey = await handleOps(
      event("PUT", "/ops/beaches/b0001/memo", { version: 0, memo: "x" }, null),
      deps("editor", table),
    );
    expect(parse(noKey).error.field).toBe("idempotencyKey");
    expect(table.items.size).toBe(0);
  });

  it("메모는 publisher가 읽는 공지 파티션에 들어가지 않아 게시본에 나가지 않는다", async () => {
    const table = new FakeTable();
    await putMemo(table, 0);
    const records = await queryNotices(table as never, "Ops");
    expect(records).toEqual([]);
    expect(liveNotices(records)).toEqual([]);
    expect(beachMemoKey("b0001").pk).not.toBe("admin#notice");
  });
});
