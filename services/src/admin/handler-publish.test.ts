import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import {
  PUBLISH_JOB_PK,
  PUBLISH_JOB_START_LIMIT_MS,
} from "../core/collect/publish-job";
import {
  PUBLISH_RUN_LAST_SK,
  PUBLISH_RUN_PK,
  PUBLISH_SUMMARY_PK,
} from "../core/collect/publish-summary";
import type { SnapshotStore } from "../core/snapshots/types";
import { NOTICE_HOLD_KEY } from "../core/store/dynamodb";
import { MANIFEST_SETTINGS } from "../publisher/policy";
import type { AuthDependencies } from "./auth";
import { handleOps, type OpsDependencies } from "./handler";
import { AUDIT_PREFIX, NOTICE_PK, PUBLISH_JOB_SLOT_KEY } from "./keys";
import { ACCESS_TOKEN_HEADER, IDEMPOTENCY_KEY_HEADER } from "./policy";
import type { PublisherJobEvent } from "./publish-routes";
import { FakeTable, type Item } from "./test-dynamo";
import { TEST_CONFIG } from "./test-tokens";

// 운영 API 데이터 게시 경로 (#331, ADM-PUB · D16-B6·C2·C4·D20-2). 토큰 검증은 가짜, DB는 test-dynamo 가짜
// publisher는 부르지 않고 받은 이벤트만 모음(실제 Lambda 호출 없음)

const NOW = new Date("2026-11-12T06:00:00Z");
const NOW_SEC = NOW.getTime() / 1000;
const ISS = (pool: string) =>
  `https://cognito-idp.ap-northeast-2.amazonaws.com/${pool}`;

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
  return `${String(keySeq).padStart(8, "0")}-7c1e-4a2b-9f00-1234567890ab`;
}

class FakePublisher {
  readonly events: PublisherJobEvent[] = [];
  fail = false;
  // 미리보기 응답(함수면 불러서 던지거나 값을 돌려줌)
  previewResult: unknown | (() => unknown) = { status: "blocked" };
  previews = 0;
  async invoke(event: PublisherJobEvent) {
    if (this.fail) throw new Error("throttled");
    this.events.push(event);
  }
  async preview() {
    this.previews++;
    return typeof this.previewResult === "function"
      ? (this.previewResult as () => unknown)()
      : this.previewResult;
  }
}

function fakeSnapshots(files: Record<string, string | Error>): SnapshotStore {
  const get = async (path: string) => {
    const file = files[path];
    if (file instanceof Error) throw file;
    return file ?? null;
  };
  return {
    getFile: get,
    getTaggedFile: async () => null,
    putFile: async () => undefined,
    putFileIf: async () => false,
    listVersions: async () => [],
    deleteVersion: async () => undefined,
  } as unknown as SnapshotStore;
}

function deps(
  group: string,
  table: FakeTable,
  options: {
    now?: Date;
    publisher?: FakePublisher | null;
    snapshots?: SnapshotStore | null;
  } = {},
): OpsDependencies {
  const now = options.now ?? NOW;
  const auth: AuthDependencies = {
    config: TEST_CONFIG,
    verifier: { verify: async () => claims(group) },
    samplePolicy: async () => ({
      subs: ["sample-sub"],
      allowedFrom: new Date(NOW.getTime() - 3_600_000),
      allowedUntil: new Date(NOW.getTime() + 3_600_000),
    }),
    now: () => now,
  };
  return {
    auth,
    data: {
      client: table as never,
      opsTable: "Ops",
      inquiryTable: "Inquiry",
      now: () => now,
      publisher:
        options.publisher === undefined
          ? new FakePublisher()
          : options.publisher,
      snapshots: options.snapshots ?? null,
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
  return [...table.items.values()].filter((i) =>
    String(i.pk).startsWith(AUDIT_PREFIX),
  );
}

function jobs(table: FakeTable): Item[] {
  return [...table.items.values()].filter((i) => i.pk === PUBLISH_JOB_PK);
}

function put(table: FakeTable, item: Item) {
  table.items.set(table.id("Ops", item as { pk: string; sk: string }), item);
}

const NOTICE_A = {
  id: "n-aaaaaaaaaaaa",
  kind: "general",
  title: { ko: "주차장 공사 안내", en: "Parking lot construction" },
  body: {
    ko: "11월 말까지 일부 구역 공사",
    en: "Partial closure until late Nov",
  },
  startsAt: "2026-11-12T00:00:00Z",
  endsAt: "2026-11-20T00:00:00Z",
};

function noticeItem(
  notice: typeof NOTICE_A,
  overrides: Record<string, unknown> = {},
) {
  const { id, ...content } = notice;
  return {
    pk: NOTICE_PK,
    sk: id,
    kind: "notice",
    id,
    version: 2,
    draft: content,
    live: content,
    exposedAt: "2026-11-11T00:00:00Z",
    updatedAt: "2026-11-11T00:00:00Z",
    deletedAt: null,
    ...overrides,
  };
}

function manifest(notices: unknown[] = [], version = "20261112T054500Z") {
  return JSON.stringify({
    schemaVersion: MANIFEST_SETTINGS.schemaVersion,
    snapshotVersion: version,
    policyVersion: "judgment-2026-10-16",
    generatedAt: "2026-11-12T05:45:00Z",
    maintenance: MANIFEST_SETTINGS.maintenance,
    minWebBuild: MANIFEST_SETTINGS.minWebBuild,
    files: {
      beaches: `/data/${version}/beaches.json`,
      status: `/data/${version}/status.json`,
      history: `/data/${version}/history.json`,
      nationwideWarnings: `/data/${version}/nationwide-warnings.json`,
    },
    ...(notices.length > 0 ? { notices } : {}),
  });
}

async function createJob(
  table: FakeTable,
  body: unknown = { action: "publish" },
  options: Parameters<typeof deps>[2] = {},
  key = newKey(),
) {
  return handleOps(
    event("POST", "/ops/publish/jobs", body, key),
    deps("publisher", table, options),
  );
}

describe("권한 (허용표)", () => {
  it.each(["viewer", "editor"])(
    "%s 권한은 지금 게시·되돌리기·다시 적용을 못 한다(403, 노출 변경만)",
    async (group) => {
      const table = new FakeTable();
      const publisher = new FakePublisher();
      for (const [path, body] of [
        ["/ops/publish/jobs", { action: "publish" }],
        [
          "/ops/publish/jobs",
          { action: "rollback", version: "20261112T050000Z" },
        ],
        ["/ops/publish/holds/n-aaaaaaaaaaaa/reapply", { version: 1 }],
      ] as const) {
        const result = await handleOps(
          event("POST", path, body),
          deps(group, table, { publisher }),
        );
        expect(result.statusCode).toBe(403);
      }
      expect(publisher.events).toEqual([]);
      expect(jobs(table)).toEqual([]);
      expect(table.transactions).toBe(0);
    },
  );

  it("데모 계정은 게시 현황·작업 조회도 못 받고 쓰기도 거절된다(403, 거절 기록만 남음)", async () => {
    const table = new FakeTable();
    const publisher = new FakePublisher();
    for (const [method, path, body] of [
      ["GET", "/ops/publish", undefined],
      ["GET", "/ops/publish/jobs/j-0123456789ab", undefined],
      ["POST", "/ops/publish/jobs", { action: "publish" }],
      ["POST", "/ops/publish/holds/n-aaaaaaaaaaaa/reapply", { version: 1 }],
    ] as const) {
      const result = await handleOps(
        event(method, path, body),
        deps("sample", table, { publisher }),
      );
      expect(result.statusCode).toBe(403);
    }
    expect(publisher.events).toEqual([]);
    expect(jobs(table)).toEqual([]);
    expect(audits(table).map((a) => a.action)).toEqual([
      "sample.denied",
      "sample.denied",
      "sample.denied",
      "sample.denied",
    ]);
  });

  it("보기 권한도 게시 현황과 작업 상태는 읽는다", async () => {
    const table = new FakeTable();
    const overview = await handleOps(
      event("GET", "/ops/publish"),
      deps("viewer", table),
    );
    expect(overview.statusCode).toBe(200);
    const missing = await handleOps(
      event("GET", "/ops/publish/jobs/j-0123456789ab"),
      deps("viewer", table),
    );
    expect(missing.statusCode).toBe(404);
  });
});

describe("작업 만들기 (지금 게시·되돌리기)", () => {
  it("지금 게시는 작업 ID를 돌려주고(202) 대기 작업·작업 자리·감사 기록을 한 번에 남긴 뒤 publisher를 비동기로 부른다", async () => {
    const table = new FakeTable();
    const publisher = new FakePublisher();
    const key = newKey();
    const result = await createJob(
      table,
      { action: "publish" },
      { publisher },
      key,
    );
    expect(result.statusCode).toBe(202);
    const body = parse(result);
    expect(body.jobId).toBe(`j-${key.replaceAll("-", "").slice(0, 12)}`);
    expect(body.job).toMatchObject({
      jobId: body.jobId,
      action: "publish",
      state: "pending",
      createdAt: NOW.toISOString(),
      overdue: false,
    });
    expect(body.job.createdAtMs).toBeUndefined();
    expect(table.transactions).toBe(1);
    expect(jobs(table)).toHaveLength(1);
    expect(
      table.items.get(table.id("Ops", PUBLISH_JOB_SLOT_KEY)),
    ).toMatchObject({ jobId: body.jobId, version: 1 });
    expect(publisher.events).toEqual([
      { action: "publish", jobId: body.jobId },
    ]);
    const [audit] = audits(table);
    expect(audit).toMatchObject({
      action: "publish.now",
      targetKind: "publish",
      targetId: body.jobId,
      changes: ["job"],
      actorSub: "publisher-sub",
    });
  });

  it("되돌리기는 고른 게시본 버전을 작업과 publisher 이벤트에 싣고, 감사에는 버전만 남긴다", async () => {
    const table = new FakeTable();
    const publisher = new FakePublisher();
    const result = await createJob(
      table,
      { action: "rollback", version: "20261112T050000Z" },
      { publisher },
    );
    expect(result.statusCode).toBe(202);
    const { jobId, job } = parse(result);
    expect(job).toMatchObject({
      action: "rollback",
      target: "20261112T050000Z",
      state: "pending",
    });
    expect(publisher.events).toEqual([
      { action: "rollback", version: "20261112T050000Z", jobId },
    ]);
    const [audit] = audits(table);
    expect(audit).toMatchObject({
      action: "publish.rollback",
      targetLabel: "20261112T050000Z",
      changes: ["job", "rollbackTo"],
    });
    expect(audit!.noticeBefore).toBeUndefined();
    expect(audit!.noticeAfter).toBeUndefined();
  });

  it.each([
    ["모르는 action", { action: "republish", version: "20261112T050000Z" }],
    ["되돌리기 버전 없음", { action: "rollback" }],
    ["되돌리기 버전 형식 틀림", { action: "rollback", version: "2026-11-12" }],
    ["지금 게시에 다른 칸", { action: "publish", version: "20261112T050000Z" }],
    ["배열", []],
  ])("%s → 400, 작업을 만들지 않음", async (_name, body) => {
    const table = new FakeTable();
    const publisher = new FakePublisher();
    const result = await createJob(table, body, { publisher });
    expect(result.statusCode).toBe(400);
    expect(jobs(table)).toEqual([]);
    expect(publisher.events).toEqual([]);
  });

  it("멱등 키가 없으면 400", async () => {
    const table = new FakeTable();
    const result = await handleOps(
      event("POST", "/ops/publish/jobs", { action: "publish" }, null),
      deps("publisher", table),
    );
    expect(result.statusCode).toBe(400);
    expect(parse(result).error.field).toBe("idempotencyKey");
  });

  it("응답 시간 초과 뒤 같은 키·같은 내용으로 다시 보내면 새 작업 없이 앞 작업을 돌려준다(중복 실행 없음)", async () => {
    const table = new FakeTable();
    const publisher = new FakePublisher();
    const key = newKey();
    const first = parse(
      await createJob(table, { action: "publish" }, { publisher }, key),
    );
    const again = await createJob(
      table,
      { action: "publish" },
      { publisher },
      key,
    );
    expect(again.statusCode).toBe(202);
    expect(parse(again).jobId).toBe(first.jobId);
    // 작업·감사·트랜잭션이 하나뿐
    expect(jobs(table)).toHaveLength(1);
    expect(audits(table)).toHaveLength(1);
    expect(table.transactions).toBe(1);
    // 아직 대기라 publisher를 다시 부름(호출이 됐는지 모르는 경우). publisher는 대기일 때만 맡으므로 한 번만 실행됨
    expect(publisher.events).toEqual([
      { action: "publish", jobId: first.jobId },
      { action: "publish", jobId: first.jobId },
    ]);
  });

  it("같은 키 재시도라도 작업이 이미 실행·완료면 publisher를 다시 부르지 않는다", async () => {
    const table = new FakeTable();
    const publisher = new FakePublisher();
    const key = newKey();
    const { jobId } = parse(
      await createJob(table, { action: "publish" }, { publisher }, key),
    );
    const jobKey = table.id("Ops", { pk: PUBLISH_JOB_PK, sk: jobId });
    table.items.set(jobKey, {
      ...table.items.get(jobKey)!,
      state: "done",
      result: "published",
      snapshotVersion: "20261112T060001Z",
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
    });
    const again = parse(
      await createJob(table, { action: "publish" }, { publisher }, key),
    );
    expect(again.job).toMatchObject({ state: "done", result: "published" });
    expect(publisher.events).toHaveLength(1);
  });

  it("같은 키·다른 내용은 409(idempotency_mismatch)이고 아무것도 바꾸지 않는다", async () => {
    const table = new FakeTable();
    const publisher = new FakePublisher();
    const key = newKey();
    await createJob(table, { action: "publish" }, { publisher }, key);
    const other = await createJob(
      table,
      { action: "rollback", version: "20261112T050000Z" },
      { publisher },
      key,
    );
    expect(other.statusCode).toBe(409);
    expect(parse(other).error.reason).toBe("idempotency_mismatch");
    expect(jobs(table)).toHaveLength(1);
    expect(publisher.events).toHaveLength(1);
  });

  it("멱등 기록이 지난 뒤(24시간) 같은 키로 다시 보내면 새로 실행하지 않고 409(idempotency_expired)", async () => {
    const table = new FakeTable();
    const publisher = new FakePublisher();
    const key = newKey();
    await createJob(table, { action: "publish" }, { publisher }, key);
    // 앞 작업은 끝났고, 멱등 기록만 TTL로 지워진 상태(작업 기록은 8일 남음)
    for (const [id, item] of [...table.items.entries()]) {
      if (id.startsWith("Ops|admin#idem#")) table.items.delete(id);
      if (item.pk === PUBLISH_JOB_PK) {
        table.items.set(id, { ...item, state: "done", result: "published" });
      }
    }
    const again = await createJob(
      table,
      { action: "publish" },
      { publisher },
      key,
    );
    expect(again.statusCode).toBe(409);
    expect(parse(again).error.reason).toBe("idempotency_expired");
    expect(jobs(table)).toHaveLength(1);
    expect(publisher.events).toHaveLength(1);
  });

  it("다른 운영자가 같은 키를 쓰면 409(앞 작업을 자기 것처럼 돌려주지 않음)", async () => {
    const table = new FakeTable();
    const key = newKey();
    await createJob(table, { action: "publish" }, {}, key);
    // 다른 sub의 노출 변경 권한 운영자
    const other = deps("publisher", table);
    const verify = other.auth.verifier.verify;
    const result = await handleOps(
      event("POST", "/ops/publish/jobs", { action: "publish" }, key),
      {
        ...other,
        auth: {
          ...other.auth,
          verifier: {
            verify: async (...args: Parameters<typeof verify>) => ({
              ...(await verify(...args)),
              sub: "another-publisher-sub",
            }),
          },
        },
      },
    );
    expect(result.statusCode).toBe(409);
    expect(parse(result).error.reason).toBe("idempotency_mismatch");
  });

  it("진행 중인 작업이 있으면 새 키도 409(busy)로 받지 않는다(연속 실행 방지)", async () => {
    const table = new FakeTable();
    const publisher = new FakePublisher();
    const first = parse(
      await createJob(table, { action: "publish" }, { publisher }),
    );
    const second = await createJob(table, { action: "publish" }, { publisher });
    expect(second.statusCode).toBe(409);
    expect(parse(second).error).toMatchObject({
      reason: "busy",
      jobId: first.jobId,
    });
    expect(jobs(table)).toHaveLength(1);
    expect(publisher.events).toHaveLength(1);
  });

  it("앞 작업이 시작 제한을 넘겨 늦어졌으면(publisher가 맡지 않음) 새 작업을 받는다", async () => {
    const table = new FakeTable();
    const publisher = new FakePublisher();
    await createJob(table, { action: "publish" }, { publisher });
    const later = new Date(NOW.getTime() + PUBLISH_JOB_START_LIMIT_MS + 1000);
    const result = await createJob(
      table,
      { action: "publish" },
      { publisher, now: later },
    );
    expect(result.statusCode).toBe(202);
    expect(jobs(table)).toHaveLength(2);
    expect(
      table.items.get(table.id("Ops", PUBLISH_JOB_SLOT_KEY)),
    ).toMatchObject({ version: 2 });
  });

  it("동시에 두 작업을 만들면 하나만 받는다(작업 자리 version 조건)", async () => {
    const table = new FakeTable();
    const publisher = new FakePublisher();
    const results = await Promise.all([
      createJob(table, { action: "publish" }, { publisher }),
      createJob(table, { action: "publish" }, { publisher }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    expect(jobs(table)).toHaveLength(1);
    expect(publisher.events).toHaveLength(1);
  });

  it("publisher 호출이 실패하면 작업을 실패(invoke_failed)로 바꿔 돌려준다", async () => {
    const table = new FakeTable();
    const publisher = new FakePublisher();
    publisher.fail = true;
    const result = await createJob(table, { action: "publish" }, { publisher });
    expect(result.statusCode).toBe(202);
    const { jobId, job } = parse(result);
    expect(job).toMatchObject({ state: "failed", reason: "invoke_failed" });
    expect(
      table.items.get(table.id("Ops", { pk: PUBLISH_JOB_PK, sk: jobId })),
    ).toMatchObject({ state: "failed", reason: "invoke_failed" });
  });

  it("publisher 호출 설정이 없으면 작업을 만들지 않는다(500)", async () => {
    const table = new FakeTable();
    const result = await createJob(
      table,
      { action: "publish" },
      { publisher: null },
    );
    expect(result.statusCode).toBe(500);
    expect(jobs(table)).toEqual([]);
    expect(table.transactions).toBe(0);
  });
});

describe("작업 조회", () => {
  it("형식이 틀리거나 없는 작업 ID는 404", async () => {
    const table = new FakeTable();
    for (const id of ["nope", "j-0123456789ab"]) {
      const result = await handleOps(
        event("GET", `/ops/publish/jobs/${id}`),
        deps("viewer", table),
      );
      expect(result.statusCode).toBe(404);
    }
  });

  it("실행 중으로 오래 남은 작업은 실패로 단정하지 않고 늦어짐(overdue)으로 보여 준다", async () => {
    const table = new FakeTable();
    const { jobId } = parse(await createJob(table));
    const jobKey = table.id("Ops", { pk: PUBLISH_JOB_PK, sk: jobId });
    table.items.set(jobKey, {
      ...table.items.get(jobKey)!,
      state: "running",
      startedAt: NOW.toISOString(),
    });
    const later = new Date(NOW.getTime() + 10 * 60 * 1000);
    const result = parse(
      await handleOps(
        event("GET", `/ops/publish/jobs/${jobId}`),
        deps("viewer", table, { now: later }),
      ),
    );
    expect(result.job).toMatchObject({ state: "running", overdue: true });
    expect(result.job.fromRunRecord).toBeUndefined();
  });

  it("작업 기록을 못 남긴 게시(부분 성공)는 게시 요약의 작업 ID로 게시 완료를 찾는다", async () => {
    const table = new FakeTable();
    const { jobId } = parse(await createJob(table));
    const jobKey = table.id("Ops", { pk: PUBLISH_JOB_PK, sk: jobId });
    table.items.set(jobKey, {
      ...table.items.get(jobKey)!,
      state: "running",
      startedAt: NOW.toISOString(),
    });
    put(table, {
      pk: PUBLISH_SUMMARY_PK,
      sk: "20261112T060005Z",
      version: "20261112T060005Z",
      previous: "20261112T054500Z",
      publishedAt: "2026-11-12T06:00:05Z",
      beachCount: 2,
      delayedBeachIds: [],
      source: "operator",
      jobId,
    });
    const later = new Date(NOW.getTime() + 10 * 60 * 1000);
    const result = parse(
      await handleOps(
        event("GET", `/ops/publish/jobs/${jobId}`),
        deps("viewer", table, { now: later }),
      ),
    );
    expect(result.job).toMatchObject({
      state: "done",
      result: "published",
      snapshotVersion: "20261112T060005Z",
      overdue: false,
      fromRunRecord: true,
    });
  });

  it("실패한 실행 기록의 작업 ID로 실패 사유를 찾는다", async () => {
    const table = new FakeTable();
    const { jobId } = parse(await createJob(table));
    put(table, {
      pk: PUBLISH_RUN_PK,
      sk: "20261112T060005Z",
      at: "2026-11-12T06:00:05Z",
      source: "operator",
      result: "failed",
      version: "20261112T060005Z",
      reason: "beach_ids",
      jobId,
    });
    const later = new Date(NOW.getTime() + 10 * 60 * 1000);
    const result = parse(
      await handleOps(
        event("GET", `/ops/publish/jobs/${jobId}`),
        deps("viewer", table, { now: later }),
      ),
    );
    expect(result.job).toMatchObject({
      state: "failed",
      reason: "beach_ids",
      fromRunRecord: true,
    });
  });
});

describe("게시 현황 (GET /ops/publish)", () => {
  it("지금 게시본·게시 기록(성공·실패, 바뀐 것)·마지막 실행·다음 자동 게시를 준다", async () => {
    const table = new FakeTable();
    put(table, {
      pk: PUBLISH_SUMMARY_PK,
      sk: "20261112T051500Z",
      version: "20261112T051500Z",
      previous: null,
      publishedAt: "2026-11-12T05:15:00Z",
      beachCount: 3,
      delayedBeachIds: ["b1"],
      source: "auto",
      categoryCounts: { clear: 2, unavailable: 0, undetermined: 1 },
      noticeDigest: "aaaaaaaaaaaaaaaa",
    });
    put(table, {
      pk: PUBLISH_SUMMARY_PK,
      sk: "20261112T054500Z",
      version: "20261112T054500Z",
      previous: "20261112T051500Z",
      publishedAt: "2026-11-12T05:45:00Z",
      beachCount: 3,
      delayedBeachIds: [],
      source: "operator",
      jobId: "j-0123456789ab",
      categoryCounts: { clear: 1, unavailable: 2, undetermined: 0 },
      noticeDigest: "bbbbbbbbbbbbbbbb",
    });
    put(table, {
      pk: PUBLISH_RUN_PK,
      sk: "20261112T053000Z",
      at: "2026-11-12T05:30:00Z",
      source: "auto",
      result: "failed",
      version: "20261112T053000Z",
      reason: "beach_ids",
    });
    put(table, {
      pk: PUBLISH_RUN_PK,
      sk: PUBLISH_RUN_LAST_SK,
      at: "2026-11-12T05:50:00Z",
      source: "auto",
      result: "unchanged",
      version: "20261112T054500Z",
    });
    const result = await handleOps(
      event("GET", "/ops/publish"),
      deps("viewer", table, {
        snapshots: fakeSnapshots({ "data/manifest.json": manifest() }),
      }),
    );
    expect(result.statusCode).toBe(200);
    const view = parse(result);
    expect(view.current).toEqual({
      ok: true,
      version: "20261112T054500Z",
      generatedAt: "2026-11-12T05:45:00Z",
    });
    expect(view.history.ok).toBe(true);
    expect(view.history.items.map((i: Item) => [i.result, i.version])).toEqual([
      ["published", "20261112T054500Z"],
      ["failed", "20261112T053000Z"],
      ["published", "20261112T051500Z"],
    ]);
    expect(view.history.items[0]).toMatchObject({
      source: "operator",
      jobId: "j-0123456789ab",
      gapBefore: false,
      changes: {
        notices: true,
        categoryCounts: { clear: 1, unavailable: 2, undetermined: 0 },
        categoryDelta: { clear: -1, unavailable: 2, undetermined: -1 },
        delayedBeaches: 0,
        delayedDelta: -1,
      },
    });
    expect(view.history.items[1]).toMatchObject({ reason: "beach_ids" });
    // 첫 게시는 견줄 앞 게시가 없음
    expect(view.history.items[2].changes).toBeNull();
    expect(view.lastRun).toEqual({
      ok: true,
      run: {
        at: "2026-11-12T05:50:00Z",
        source: "auto",
        result: "unchanged",
        version: "20261112T054500Z",
      },
    });
    // 06:00 기준 다음 특보 수집 06:03, 다음 관측 수집 06:10
    expect(view.nextAuto).toEqual({
      warnings: "2026-11-12T06:03:00.000Z",
      observations: "2026-11-12T06:10:00.000Z",
    });
    expect(view.latestJob).toEqual({ ok: true, job: null });
  });

  it("요약 칸이 생기기 전 기록과 빠진 앞 요약은 '확인 못 함'으로 둔다(0·같음으로 바꾸지 않음)", async () => {
    const table = new FakeTable();
    for (const [version, previous] of [
      ["20261112T050000Z", null],
      ["20261112T053000Z", "20261112T051500Z"], // 05:15 요약이 빠짐
      ["20261112T054500Z", "20261112T053000Z"],
    ] as const) {
      put(table, {
        pk: PUBLISH_SUMMARY_PK,
        sk: version,
        version,
        previous,
        publishedAt: "2026-11-12T05:00:00Z",
        beachCount: 3,
        delayedBeachIds: [],
      });
    }
    const view = parse(
      await handleOps(event("GET", "/ops/publish"), deps("viewer", table)),
    );
    const [latest, middle] = view.history.items;
    expect(latest.changes).toMatchObject({
      notices: null,
      categoryCounts: null,
      categoryDelta: null,
    });
    expect(latest.source).toBe("auto");
    expect(middle).toMatchObject({ gapBefore: true, changes: null });
  });

  it("게시본을 읽지 못하면 지금 게시본·대기 공지는 '확인 못 함'이고 다른 칸은 그대로 준다", async () => {
    const table = new FakeTable();
    const view = parse(
      await handleOps(
        event("GET", "/ops/publish"),
        deps("viewer", table, {
          snapshots: fakeSnapshots({
            "data/manifest.json": new Error("AccessDenied"),
          }),
        }),
      ),
    );
    expect(view.current).toEqual({ ok: false });
    expect(view.pendingNotices).toEqual({ ok: false });
    expect(view.history).toEqual({ ok: true, items: [] });
    expect(view.heldNotices).toEqual({ ok: true, version: 0, items: [] });
  });

  it("게시본이 아직 없으면(첫 게시 전) version null로 구분한다", async () => {
    const table = new FakeTable();
    const view = parse(
      await handleOps(
        event("GET", "/ops/publish"),
        deps("viewer", table, { snapshots: fakeSnapshots({}) }),
      ),
    );
    expect(view.current).toEqual({
      ok: true,
      version: null,
      generatedAt: null,
    });
    expect(view.pendingNotices).toMatchObject({
      ok: true,
      maintenancePending: null,
    });
  });

  it("대기 공지는 확정한 노출본과 지금 게시본의 차이만(대기본·예약 전·지운 공지는 넣지 않음)", async () => {
    const table = new FakeTable();
    const { id: _a, ...contentA } = NOTICE_A;
    // 노출 중 공지 A(게시본과 같음) → 대기 아님
    put(table, noticeItem(NOTICE_A));
    // 노출 확정했지만 게시본에 없는 공지 B → add
    const B = {
      ...NOTICE_A,
      id: "n-bbbbbbbbbbbb",
      title: { ko: "새 공지", en: "New" },
    };
    put(table, noticeItem(B));
    // 대기본만 있는 공지 C → 넣지 않음
    put(
      table,
      noticeItem({ ...NOTICE_A, id: "n-cccccccccccc" }, { live: null }),
    );
    // 예약(시작 전) 공지 D → 넣지 않음(시작 뒤 첫 게시에 실림)
    put(
      table,
      noticeItem({
        ...NOTICE_A,
        id: "n-dddddddddddd",
        startsAt: "2026-11-13T00:00:00Z",
      }),
    );
    // 지운 공지 E(게시본에 남아 있음) → remove
    const E = {
      ...NOTICE_A,
      id: "n-eeeeeeeeeeee",
      title: { ko: "지운 공지", en: "Deleted" },
    };
    put(table, noticeItem(E, { deletedAt: "2026-11-12T05:50:00Z" }));
    const published = [{ id: NOTICE_A.id, ...contentA }, { ...E }];
    const view = parse(
      await handleOps(
        event("GET", "/ops/publish"),
        deps("viewer", table, {
          snapshots: fakeSnapshots({
            "data/manifest.json": manifest(published),
          }),
        }),
      ),
    );
    expect(view.pendingNotices).toEqual({
      ok: true,
      maintenancePending: false,
      items: [
        {
          id: "n-bbbbbbbbbbbb",
          change: "add",
          kind: "general",
          title: "새 공지",
          startsAt: NOTICE_A.startsAt,
          endsAt: NOTICE_A.endsAt,
        },
        {
          id: "n-eeeeeeeeeeee",
          change: "remove",
          kind: "general",
          title: "지운 공지",
          startsAt: NOTICE_A.startsAt,
          endsAt: NOTICE_A.endsAt,
        },
      ],
    });
  });

  it("되돌림 상태인 공지와 포인터 version을 주고, 대기 공지는 되돌림을 반영해 계산한다", async () => {
    const table = new FakeTable();
    const { id: _a, ...contentA } = NOTICE_A;
    const edited = {
      ...contentA,
      title: { ko: "주차장 공사 연장", en: "Construction extended" },
    };
    // 운영 DB 노출본은 고친 문구지만, 되돌림 포인터가 그때 노출본(contentA)을 싣게 함
    put(table, noticeItem(NOTICE_A, { draft: edited, live: edited }));
    put(table, {
      ...NOTICE_HOLD_KEY,
      version: 3,
      notices: {
        [NOTICE_A.id]: {
          target: "20261112T050000Z",
          at: "2026-11-12T05:55:00Z",
          live: { id: NOTICE_A.id, ...contentA },
        },
      },
    });
    const view = parse(
      await handleOps(
        event("GET", "/ops/publish"),
        deps("viewer", table, {
          snapshots: fakeSnapshots({
            "data/manifest.json": manifest([{ id: NOTICE_A.id, ...contentA }]),
          }),
        }),
      ),
    );
    expect(view.heldNotices).toEqual({
      ok: true,
      version: 3,
      items: [
        {
          id: NOTICE_A.id,
          title: "주차장 공사 연장",
          target: "20261112T050000Z",
          at: "2026-11-12T05:55:00Z",
          restoresLive: true,
        },
      ],
    });
    // 되돌린 공지는 다음 게시에도 그때 노출본 그대로 → 대기 아님
    expect(view.pendingNotices.items).toEqual([]);
  });

  it("진행 중 작업을 함께 준다(운영자 sub는 넣지 않음)", async () => {
    const table = new FakeTable();
    const { jobId } = parse(await createJob(table));
    const view = parse(
      await handleOps(event("GET", "/ops/publish"), deps("viewer", table)),
    );
    expect(view.latestJob.job).toMatchObject({ jobId, state: "pending" });
    expect(JSON.stringify(view)).not.toContain("publisher-sub");
  });
});

describe("다시 적용 (되돌림 풀기)", () => {
  const { id: _a, ...contentA } = NOTICE_A;
  function holdWith(table: FakeTable, version = 2) {
    put(table, noticeItem(NOTICE_A));
    put(table, {
      ...NOTICE_HOLD_KEY,
      version,
      notices: {
        [NOTICE_A.id]: {
          target: "20261112T050000Z",
          at: "2026-11-12T05:55:00Z",
          live: null,
        },
        "n-ffffffffffff": {
          target: "20261112T050000Z",
          at: "2026-11-12T05:55:00Z",
          live: { ...NOTICE_A, id: "n-ffffffffffff" },
        },
      },
    });
  }
  const hold = (table: FakeTable) =>
    table.items.get(table.id("Ops", NOTICE_HOLD_KEY))!;

  it("포인터에서 그 공지만 빼고 version을 올리며 감사에는 공지 ID·제목·바뀐 항목만 남긴다", async () => {
    const table = new FakeTable();
    holdWith(table);
    const result = await handleOps(
      event("POST", `/ops/publish/holds/${NOTICE_A.id}/reapply`, {
        version: 2,
      }),
      deps("publisher", table),
    );
    expect(result.statusCode).toBe(200);
    expect(parse(result)).toEqual({ noticeId: NOTICE_A.id, holdVersion: 3 });
    expect(hold(table)).toMatchObject({
      version: 3,
      updatedBy: "publisher-sub",
    });
    expect(Object.keys(hold(table).notices as object)).toEqual([
      "n-ffffffffffff",
    ]);
    const [audit] = audits(table);
    expect(audit).toMatchObject({
      action: "publish.reapply",
      targetKind: "notice",
      targetId: NOTICE_A.id,
      targetLabel: contentA.title.ko,
      changes: ["hold"],
    });
    expect(audit!.noticeBefore).toBeUndefined();
  });

  it("같은 키 재시도는 앞 결과, 읽은 version이 다르면 409, 되돌림 상태가 아닌 공지는 404", async () => {
    const table = new FakeTable();
    holdWith(table);
    const key = newKey();
    const path = `/ops/publish/holds/${NOTICE_A.id}/reapply`;
    await handleOps(
      event("POST", path, { version: 2 }, key),
      deps("publisher", table),
    );
    const again = await handleOps(
      event("POST", path, { version: 2 }, key),
      deps("publisher", table),
    );
    expect(again.statusCode).toBe(200);
    expect(parse(again).holdVersion).toBe(3);
    expect(audits(table)).toHaveLength(1);

    const stale = await handleOps(
      event("POST", "/ops/publish/holds/n-ffffffffffff/reapply", {
        version: 2,
      }),
      deps("publisher", table),
    );
    expect(stale.statusCode).toBe(409);
    const notHeld = await handleOps(
      event("POST", path, { version: 3 }),
      deps("publisher", table),
    );
    expect(notHeld.statusCode).toBe(404);
  });

  it("되돌림 상태인 공지를 다시 노출하면 같은 트랜잭션에서 되돌림도 풀린다", async () => {
    const table = new FakeTable();
    holdWith(table);
    const result = await handleOps(
      event("POST", `/ops/notices/${NOTICE_A.id}/expose`, { version: 2 }),
      deps("publisher", table),
    );
    expect(result.statusCode).toBe(200);
    expect(table.transactions).toBe(1);
    expect(hold(table).version).toBe(3);
    expect(Object.keys(hold(table).notices as object)).toEqual([
      "n-ffffffffffff",
    ]);
    expect(audits(table)[0]).toMatchObject({
      action: "notice.expose",
      changes: expect.arrayContaining(["hold"]),
    });
  });

  it("되돌림 상태인 공지의 노출을 끝내도 되돌림이 풀린다", async () => {
    const table = new FakeTable();
    holdWith(table);
    const result = await handleOps(
      event("POST", `/ops/notices/${NOTICE_A.id}/end`, { version: 2 }),
      deps("publisher", table),
    );
    expect(result.statusCode).toBe(200);
    expect(Object.keys(hold(table).notices as object)).toEqual([
      "n-ffffffffffff",
    ]);
  });

  it("되돌림 포인터가 그사이 바뀌면 노출도 하지 않고 409(related)", async () => {
    const table = new FakeTable();
    holdWith(table);
    // 다른 쓰기가 포인터를 먼저 바꾸는 상황: 트랜잭션 직전에 version을 올림
    const send = table.send.bind(table);
    table.send = (async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "TransactWriteCommand") {
        const key = table.id("Ops", NOTICE_HOLD_KEY);
        table.items.set(key, { ...table.items.get(key)!, version: 9 });
      }
      return send(command as never);
    }) as typeof table.send;
    const result = await handleOps(
      event("POST", `/ops/notices/${NOTICE_A.id}/expose`, { version: 2 }),
      deps("publisher", table),
    );
    expect(result.statusCode).toBe(409);
    expect(parse(result).error.reason).toBe("related");
    expect(
      table.items.get(table.id("Ops", { pk: NOTICE_PK, sk: NOTICE_A.id })),
    ).toMatchObject({ version: 2 });
  });
});
