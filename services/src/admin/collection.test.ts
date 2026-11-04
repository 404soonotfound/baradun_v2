import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { runLogPk, runLogSk } from "../core/collect/run-log";
import { CATALOG_JOB } from "../collectors/catalog";
import { OCEAN_JOB } from "../collectors/ocean";
import { RIP_JOB } from "../collectors/rip";
import { WARNINGS_JOB } from "../collectors/warnings";
import type { AuthDependencies } from "./auth";
import {
  COLLECTION_JOBS,
  incidentsOf,
  readCollection,
  summarizeJob,
  toRunView,
  type RunView,
} from "./collection";
import { handleOps } from "./handler";
import { ACCESS_TOKEN_HEADER } from "./policy";
import type { Sender } from "./writes";
import { TEST_CONFIG } from "./test-tokens";

// 수집 현황 (BRD-149, ADM-COLLECT). 실행 기록만 읽고 State·판단 상태는 건드리지 않음

const NOW = new Date("2026-11-04T05:20:00Z");

function run(
  startedAt: string,
  status: RunView["status"],
  failures: RunView["failures"] = [],
): RunView {
  return { startedAt, finishedAt: startedAt, status, failures };
}

// 실행 기록 파티션 Query(sk >= :from)와 게시 버전 Get만 받는 가짜 클라이언트
function fakeOps(items: Record<string, unknown>[], version?: string) {
  const sent: string[] = [];
  const client = {
    async send(command: QueryCommand | GetCommand) {
      if (command instanceof GetCommand) {
        sent.push(`get ${command.input.Key?.pk}`);
        return { Item: version ? { version } : undefined };
      }
      if (command instanceof QueryCommand) {
        const values = command.input.ExpressionAttributeValues!;
        sent.push(`query ${values[":pk"]}`);
        const forward = command.input.ScanIndexForward !== false;
        return {
          Items: items
            .filter(
              (item) =>
                item.pk === values[":pk"] &&
                String(item.sk) >= String(values[":from"]),
            )
            .sort((a, b) => (String(a.sk) < String(b.sk) === forward ? -1 : 1)),
        };
      }
      throw new Error("이 경로는 Query·Get만 씀");
    },
  } as unknown as Sender;
  return { client, sent };
}

function stored(job: string, view: RunView, owner = "req-1") {
  return {
    pk: runLogPk(job),
    sk: runLogSk(view.startedAt, owner),
    job,
    slotId: "s",
    ...view,
    ttl: 0,
  };
}

describe("수집 현황 집계", () => {
  it("수집기 이름이 수집기 코드와 같다", () => {
    expect(COLLECTION_JOBS).toEqual([
      WARNINGS_JOB,
      OCEAN_JOB,
      RIP_JOB,
      CATALOG_JOB,
    ]);
  });

  it("기록이 없으면 정상으로 보지 않고 lastRun·lastSuccessAt을 null로 둔다", () => {
    const job = summarizeJob("collect-warnings", [], NOW, false);
    expect(job).toMatchObject({
      lastRun: null,
      lastSuccessAt: null,
      day: { runs: 0, ok: 0 },
      week: { runs: 0, ok: 0 },
      incidents: [],
    });
    expect(job.hourly).toHaveLength(24);
    expect(job.hourly.every((h) => h.runs === 0)).toBe(true);
  });

  it("partial은 성공으로 세지 않고, 24시간·7일·시간별로 나눠 센다", () => {
    const runs = [
      run("2026-10-30T05:00:00.000Z", "complete"),
      run("2026-11-03T05:10:00.000Z", "complete"), // 24시간 밖(경계 직전)
      run("2026-11-04T04:03:00.000Z", "partial"),
      run("2026-11-04T04:18:00.000Z", "complete"),
      run("2026-11-04T05:03:00.000Z", "complete"),
    ];
    const job = summarizeJob("collect-warnings", runs, NOW, false);
    expect(job.day).toEqual({ runs: 3, ok: 2 });
    expect(job.week).toEqual({ runs: 5, ok: 4 });
    expect(job.lastSuccessAt).toBe("2026-11-04T05:03:00.000Z");
    // 마지막 칸이 지금 시간(05시), 앞 칸이 04시
    expect(job.hourly.at(-1)).toEqual({
      hour: "2026-11-04T05:00:00.000Z",
      runs: 1,
      ok: 1,
    });
    expect(job.hourly.at(-2)).toEqual({
      hour: "2026-11-04T04:00:00.000Z",
      runs: 2,
      ok: 1,
    });
    expect(job.hourly[0]!.hour).toBe("2026-11-03T06:00:00.000Z");
  });

  it("이어진 실패를 한 장애로 묶고, 다음 성공 시각을 끝으로 둔다(최신 먼저)", () => {
    const timeout = { source: "pwncd", reason: "timeout" };
    const incidents = incidentsOf([
      run("2026-11-04T01:00:00.000Z", "failed", [timeout]),
      run("2026-11-04T01:15:00.000Z", "partial", [timeout]),
      run("2026-11-04T01:30:00.000Z", "complete"),
      run("2026-11-04T05:03:00.000Z", "failed", [
        { source: "tsunami", reason: "resultCode:22", code: "22" },
      ]),
    ]);
    expect(incidents).toEqual([
      {
        startedAt: "2026-11-04T05:03:00.000Z",
        endedAt: null,
        runs: 1,
        failures: [{ source: "tsunami", reason: "resultCode:22", code: "22" }],
      },
      {
        startedAt: "2026-11-04T01:00:00.000Z",
        endedAt: "2026-11-04T01:30:00.000Z",
        runs: 2,
        // 실행 수는 runs. count(해변 수)는 실행끼리 더하지 않음
        failures: [{ source: "pwncd", reason: "timeout" }],
      },
    ]);
  });

  it("해변 수(count)는 실행끼리 더하지 않고 가장 많았던 실행의 값을 둔다", () => {
    const [incident] = incidentsOf([
      run("2026-11-04T01:00:00.000Z", "partial", [
        { source: "rip", reason: "timeout", count: 3 },
      ]),
      run("2026-11-04T01:30:00.000Z", "partial", [
        { source: "rip", reason: "timeout", count: 2 },
      ]),
    ]);
    expect(incident).toMatchObject({
      runs: 2,
      failures: [{ source: "rip", reason: "timeout", count: 3 }],
    });
  });

  it("모르는 상태 값은 정상이 아니라 실패로 읽고, 시각이 없는 기록은 버린다", () => {
    expect(
      toRunView({ startedAt: "2026-11-04T05:03:00.000Z", status: "ok" }),
    ).toEqual({
      startedAt: "2026-11-04T05:03:00.000Z",
      finishedAt: "2026-11-04T05:03:00.000Z",
      status: "failed",
      failures: [{ source: "record", reason: "unknown_status" }],
    });
    expect(toRunView({ status: "complete" })).toBeNull();
    expect(
      toRunView({
        startedAt: "2026-11-04T05:03:00.000Z",
        status: "failed",
        failures: [
          { source: "pwncd" },
          { source: "pwncd", reason: "http:500" },
        ],
      })?.failures,
    ).toEqual([{ source: "pwncd", reason: "http:500" }]);
  });
});

describe("readCollection", () => {
  it("수집기마다 7일 기록을 읽고 게시본 버전을 함께 돌려준다", async () => {
    const { client, sent } = fakeOps(
      [
        stored(OCEAN_JOB, run("2026-10-27T05:00:00.000Z", "complete")), // 7일 밖
        stored(OCEAN_JOB, run("2026-11-04T04:40:00.000Z", "failed")),
        stored(OCEAN_JOB, run("2026-11-04T05:10:00.000Z", "complete")),
      ],
      "20261104T051000Z",
    );
    const view = await readCollection(client, "Ops", NOW);
    expect(sent.sort()).toEqual(
      [
        "get publish",
        ...COLLECTION_JOBS.map((job) => `query ${runLogPk(job)}`),
      ].sort(),
    );
    expect(view.publishedVersion).toBe("20261104T051000Z");
    const ocean = view.jobs.find((j) => j.job === OCEAN_JOB)!;
    expect(ocean.week).toEqual({ runs: 2, ok: 1 });
    expect(ocean.lastRun?.status).toBe("complete");
    expect(view.jobs.find((j) => j.job === WARNINGS_JOB)!.lastRun).toBeNull();
  });
});

describe("GET /ops/collection", () => {
  function deps(groups: string[], kind: "operator" | "sample" = "operator") {
    const pool = kind === "sample" ? TEST_CONFIG.sample : TEST_CONFIG.operator;
    const auth: AuthDependencies = {
      config: TEST_CONFIG,
      verifier: {
        verify: async () => ({
          sub: "sample-sub",
          iss: `https://cognito-idp.ap-northeast-2.amazonaws.com/${pool.userPoolId}`,
          auth_time: NOW.getTime() / 1000 - 60,
          "cognito:groups": groups,
        }),
      },
      samplePolicy: async () => ({
        subs: ["sample-sub"],
        allowedFrom: new Date(NOW.getTime() - 3_600_000),
        allowedUntil: new Date(NOW.getTime() + 3_600_000),
      }),
      now: () => NOW,
    };
    const { client } = fakeOps([]);
    return {
      auth,
      ids: () => ({ traceId: "t", requestId: "req-abcd1234" }),
      data: {
        client,
        opsTable: "Ops",
        inquiryTable: "Inquiry",
        now: () => NOW,
      },
    };
  }

  function event(method: string): APIGatewayProxyEventV2 {
    return {
      rawPath: "/ops/collection",
      headers: { [ACCESS_TOKEN_HEADER]: "token" },
      requestContext: { http: { method } },
    } as unknown as APIGatewayProxyEventV2;
  }

  it("보기 권한이면 수집기 4개를 돌려주고, 쓰기 method는 받지 않는다", async () => {
    const ok = await handleOps(event("GET"), deps(["viewer"]));
    expect(ok.statusCode).toBe(200);
    expect(
      JSON.parse(ok.body!).jobs.map((j: { job: string }) => j.job),
    ).toEqual([...COLLECTION_JOBS]);
    expect(
      (await handleOps(event("POST"), deps(["publisher"]))).statusCode,
    ).toBe(405);
  });
});
