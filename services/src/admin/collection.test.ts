import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { PUBLISH_SUMMARY_PK } from "../core/collect/publish-summary";
import { runLogPk, runLogSk } from "../core/collect/run-log";
import { CATALOG_JOB } from "../collectors/catalog";
import { OCEAN_JOB } from "../collectors/ocean";
import { RIP_JOB } from "../collectors/rip";
import { WARNINGS_JOB } from "../collectors/warnings";
import { WEATHER_JOB } from "../collectors/weather";
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
      WEATHER_JOB,
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
    // 04:18 성공 뒤 05:03까지 45분(기준 20분) → 04:38부터 지연이 05시 칸까지 걸침
    expect(job.hourly.at(-1)).toEqual({
      hour: "2026-11-04T05:00:00.000Z",
      runs: 1,
      ok: 1,
      late: true,
    });
    // 지금(05:20)은 05:03 성공 뒤 17분 → 지연 아님
    expect(job.overdue).toBe(false);
    expect(job.lateAfterMinutes).toBe(20);
    // 전날 05:10 성공 뒤 04:18까지 성공이 없었음 → 04시 칸에 지연이 걸침
    expect(job.hourly.at(-2)).toEqual({
      hour: "2026-11-04T04:00:00.000Z",
      runs: 2,
      ok: 1,
      late: true,
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
        stations: [],
      },
      {
        startedAt: "2026-11-04T01:00:00.000Z",
        endedAt: "2026-11-04T01:30:00.000Z",
        runs: 2,
        // 실행 수는 runs. count(해변 수)는 실행끼리 더하지 않음
        failures: [{ source: "pwncd", reason: "timeout" }],
        stations: [],
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

describe("지연 판정·빠진 관측소 (BRD-187)", () => {
  it("마지막 성공 뒤 기준(관측 35분)을 넘으면 overdue", () => {
    const job = summarizeJob(
      "collect-ocean",
      [run("2026-11-04T04:40:00.000Z", "complete")],
      NOW,
      false,
    );
    expect(job.lateAfterMinutes).toBe(35);
    expect(job.overdue).toBe(true); // 40분 지남
  });

  it("사진(하루 1회)과 이안류 비수기(11월)는 지연을 보지 않는다", () => {
    const old = [run("2026-11-01T04:00:00.000Z", "complete")];
    for (const name of ["collect-catalog", "collect-rip"] as const) {
      const job = summarizeJob(name, old, NOW, false);
      expect(job.lateAfterMinutes).toBeNull();
      expect(job.overdue).toBe(false);
      expect(job.hourly.some((h) => h.late)).toBe(false);
    }
  });

  it("성공 기록이 없으면 overdue로 만들지 않는다(상태는 lastRun이 말함)", () => {
    const job = summarizeJob(
      "collect-warnings",
      [run("2026-11-04T04:00:00.000Z", "failed")],
      NOW,
      false,
    );
    expect(job.overdue).toBe(false);
  });

  it("빠진 관측소만 있는 성공 실행도 장애로 묶고, 대조한 성공 실행에서 돌아온 시각을 둔다", () => {
    const missing = (at: string, ids: string[]): RunView => ({
      ...run(at, "complete"),
      missingStations: ids,
    });
    const incidents = incidentsOf([
      missing("2026-11-02T02:00:00.000Z", []),
      missing("2026-11-02T02:10:00.000Z", ["22451", "22520"]),
      // 출처가 실패해 대조하지 못한 실행은 돌아온 것으로 보지 않음
      run("2026-11-02T02:40:00.000Z", "partial", [
        { source: "sea_obs", reason: "timeout" },
      ]),
      missing("2026-11-02T03:00:00.000Z", ["22520"]),
      missing("2026-11-02T03:10:00.000Z", []),
    ]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      startedAt: "2026-11-02T02:10:00.000Z",
      endedAt: "2026-11-02T03:10:00.000Z",
      runs: 3,
      stations: [
        {
          id: "22451",
          firstMissingAt: "2026-11-02T02:10:00.000Z",
          lastMissingAt: "2026-11-02T02:10:00.000Z",
          returnedAt: "2026-11-02T03:00:00.000Z",
        },
        {
          id: "22520",
          firstMissingAt: "2026-11-02T02:10:00.000Z",
          lastMissingAt: "2026-11-02T03:00:00.000Z",
          returnedAt: "2026-11-02T03:10:00.000Z",
        },
      ],
    });
  });

  it("옛 기록(빠진 관측소 칸 없음)은 깨끗한 실행으로 읽고, 칸이 있으면 그대로 읽는다", () => {
    expect(
      toRunView({ startedAt: "2026-11-04T05:03:00.000Z", status: "complete" }),
    ).not.toHaveProperty("missingStations");
    expect(
      toRunView({
        startedAt: "2026-11-04T05:03:00.000Z",
        status: "complete",
        missingStations: ["22451", 3],
        missingStationsTotal: 60,
      }),
    ).toMatchObject({ missingStations: ["22451"], missingStationsTotal: 60 });
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
        // 게시 요약: 최신 하나(관측소 표) + 8일 목록
        `query ${PUBLISH_SUMMARY_PK}`,
        `query ${PUBLISH_SUMMARY_PK}`,
        ...COLLECTION_JOBS.map((job) => `query ${runLogPk(job)}`),
      ].sort(),
    );
    expect(view.publishedVersion).toBe("20261104T051000Z");
    const ocean = view.jobs.find((j) => j.job === OCEAN_JOB)!;
    expect(ocean.week).toEqual({ runs: 2, ok: 1 });
    expect(ocean.lastRun?.status).toBe("complete");
    expect(view.jobs.find((j) => j.job === WARNINGS_JOB)!.lastRun).toBeNull();
  });

  it("경보 읽기 도구가 없으면 경보는 확인 못 함, 장애의 경보는 null, 관측 장애에는 해변 영향을 둔다", async () => {
    const { client } = fakeOps(
      [stored(OCEAN_JOB, run("2026-11-04T05:10:00.000Z", "failed"))],
      "20261104T051000Z",
    );
    const view = await readCollection(client, "Ops", NOW);
    expect(view.alarms).toEqual({ status: "unavailable" });
    // 게시 요약이 하나도 없음 → 관측 지연 해변 수를 0으로 만들지 않음
    expect(view.publish).toBeNull();
    const [incident] = view.jobs.find((j) => j.job === OCEAN_JOB)!.incidents;
    expect(incident?.alarms).toBeNull();
    expect(incident?.impact).toMatchObject({
      status: "unknown",
      reason: "summary_missing",
    });
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
