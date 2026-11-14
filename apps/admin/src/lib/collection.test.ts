import { describe, expect, it } from "vitest";
import {
  alarmInfo,
  cycleDelayText,
  incidentErrorTitle,
  allIncidents,
  barCounts,
  barState,
  cloudWatchUrl,
  groupedAlarms,
  incidentKey,
  logsUrl,
  matchesFilter,
  kstClock,
  normalizeCollection,
  incidentTimeline,
  lambdaUrl,
  sortedAlarms,
  incidentMinutes,
  kstHour,
  lowestHour,
  overallHourly,
  reasonOf,
  sourceState,
  successRate,
  versionTime,
  type AlarmView,
  type Incident,
  type JobCollection,
} from "./collection";

// 수집 현황 화면 계산 (BRD-149). 기록 없음·일부 실패를 정상으로 바꾸지 않음

const job_ = (partial: Partial<JobCollection>) => job(partial);

function job(partial: Partial<JobCollection>): JobCollection {
  return {
    job: "collect-ocean",
    lastRun: null,
    lastSuccessAt: null,
    day: { runs: 0, ok: 0 },
    week: { runs: 0, ok: 0 },
    hourly: [],
    incidents: [],
    truncated: false,
    lateAfterMinutes: 35,
    overdue: false,
    ...partial,
  };
}

const run = (status: "complete" | "partial" | "failed") => ({
  startedAt: "2026-11-04T05:10:00.000Z",
  finishedAt: "2026-11-04T05:10:02.000Z",
  status,
  failures: [],
});

describe("sourceState", () => {
  it("응답에 없거나 기록이 없으면 '기록 없음', 마지막 실행 상태를 그대로 씀", () => {
    expect(sourceState(undefined)).toBe("none");
    expect(sourceState(job({}))).toBe("none");
    expect(sourceState(job({ lastRun: run("complete") }))).toBe("ok");
    expect(sourceState(job({ lastRun: run("partial") }))).toBe("partial");
    expect(sourceState(job({ lastRun: run("failed") }))).toBe("failed");
  });

  it("마지막 실행이 성공이어도 지연 기준을 넘겼으면 '지연', 실패·일부 실패가 지연보다 앞섬", () => {
    expect(sourceState(job({ lastRun: run("complete"), overdue: true }))).toBe(
      "late",
    );
    expect(sourceState(job({ lastRun: run("failed"), overdue: true }))).toBe(
      "failed",
    );
    expect(sourceState(job({ lastRun: run("partial"), overdue: true }))).toBe(
      "partial",
    );
  });

  it("예전 응답이라 지연을 판정하지 못하면(overdue null) 정상이 아니라 '지연 확인 못 함'", () => {
    expect(sourceState(job({ lastRun: run("complete"), overdue: null }))).toBe(
      "unchecked",
    );
    expect(sourceState(job({ lastRun: run("failed"), overdue: null }))).toBe(
      "failed",
    );
  });
});

describe("successRate", () => {
  it("실행이 없으면 null(0%·100%로 바꾸지 않음), 올림하지 않음", () => {
    expect(successRate({ runs: 0, ok: 0 })).toBeNull();
    expect(successRate({ runs: 672, ok: 671 })).toBe(99.8);
    expect(successRate({ runs: 2000, ok: 1999 })).toBe(99.9);
    expect(successRate({ runs: 3, ok: 3 })).toBe(100);
  });
});

describe("시간별 성공률", () => {
  const hour = (h: string, runs: number, ok: number) => ({
    hour: `2026-11-04T${h}:00:00.000Z`,
    runs,
    ok,
    late: false,
  });

  it("수집기 칸을 시각별로 더하고, 가장 낮은 칸을 고름", () => {
    const hourly = overallHourly([
      job({ hourly: [hour("01", 4, 4), hour("02", 4, 2)] }),
      job({ hourly: [hour("01", 2, 1), hour("02", 2, 2)] }),
    ]);
    // 모든 출처를 더한 칸은 지연 표시 없이 실행 수만
    const counts = (h: string, runs: number, ok: number) => ({
      hour: `2026-11-04T${h}:00:00.000Z`,
      runs,
      ok,
    });
    expect(hourly).toEqual([counts("01", 6, 5), counts("02", 6, 4)]);
    expect(lowestHour(hourly)).toEqual(counts("02", 6, 4));
    expect(lowestHour([hour("01", 4, 4), hour("02", 0, 0)])).toBeNull();
  });

  it("칸 이름은 KST 시", () => {
    expect(kstHour("2026-11-04T17:00:00.000Z")).toBe(2);
  });
});

describe("장애 기록", () => {
  it("수집기를 합쳐 최신 먼저, 이어지는 장애는 지금까지 분", () => {
    const list = allIncidents([
      job({
        job: "collect-warnings",
        incidents: [
          {
            startedAt: "2026-11-04T01:00:00.000Z",
            endedAt: "2026-11-04T01:30:00.000Z",
            runs: 2,
            failures: [],
            kind: "failure",
            stations: [],
            missingTruncated: false,
          },
        ],
      }),
      job({
        job: "collect-ocean",
        incidents: [
          {
            startedAt: "2026-11-04T05:10:00.000Z",
            endedAt: null,
            runs: 1,
            failures: [],
            kind: "failure",
            stations: [],
            missingTruncated: false,
          },
        ],
      }),
    ]);
    expect(list.map((i) => i.job)).toEqual([
      "collect-ocean",
      "collect-warnings",
    ]);
    expect(incidentMinutes(list[1]!, 0)).toBe(30);
    expect(
      incidentMinutes(list[0]!, Date.parse("2026-11-04T05:25:00.000Z")),
    ).toBe(15);
  });
});

describe("reasonOf", () => {
  it("아는 사유는 문구 키로, 모르는 사유는 원래 글 그대로", () => {
    expect(reasonOf({ source: "pwncd", reason: "timeout" })).toEqual({
      key: "timeout",
      value: "",
    });
    expect(reasonOf({ source: "sea_obs", reason: "http:503" })).toEqual({
      key: "http",
      value: "503",
    });
    expect(
      reasonOf({ source: "pwncd", reason: "resultCode:22", code: "22" }),
    ).toEqual({ key: "resultCode", value: "22" });
    expect(reasonOf({ source: "rip", reason: "result:22" })).toEqual({
      key: "resultCode",
      value: "22",
    });
    expect(
      reasonOf({ source: "storage", reason: "readings_not_saved" }),
    ).toEqual({ key: "storage", value: "readings_not_saved" });
    expect(reasonOf({ source: "x", reason: "새로운 사유" })).toEqual({
      key: "other",
      value: "새로운 사유",
    });
  });
});

describe("versionTime", () => {
  it("게시본 버전을 시각으로, 모양이 틀리면 null", () => {
    expect(versionTime("20261104T051000Z")).toBe("2026-11-04T05:10:00Z");
    expect(versionTime(null)).toBeNull();
    expect(versionTime("2026-11-04")).toBeNull();
  });
});

describe("24시간 막대", () => {
  const bucket = (runs: number, ok: number, late = false) => ({
    hour: "2026-11-04T01:00:00.000Z",
    runs,
    ok,
    late,
  });

  it("실패가 지연보다, 지연이 기록 없음보다 앞섬. 실행이 없어도 지연이면 지연", () => {
    expect(barState(bucket(4, 3, true))).toBe("failed");
    expect(barState(bucket(4, 4, true))).toBe("late");
    expect(barState(bucket(0, 0, true))).toBe("late");
    expect(barState(bucket(0, 0))).toBe("none");
    expect(barState(bucket(4, 4))).toBe("ok");
  });

  it("상태별 칸 수를 셈(화면 읽기 프로그램 요약)", () => {
    expect(
      barCounts([bucket(4, 4), bucket(4, 3), bucket(0, 0), bucket(4, 4, true)]),
    ).toEqual({ ok: 1, failed: 1, none: 1, late: 1 });
  });
});

describe("장애 경과", () => {
  const base: Incident = {
    kind: "stations",
    startedAt: "2026-11-04T01:00:00.000Z",
    endedAt: null,
    runs: 3,
    failures: [],
    stations: [
      {
        id: "22105",
        firstMissingAt: "2026-11-04T01:00:00.000Z",
        lastMissingAt: "2026-11-04T01:30:00.000Z",
        returnedAt: "2026-11-04T02:00:00.000Z",
      },
      {
        id: "22190",
        firstMissingAt: "2026-11-04T01:00:00.000Z",
        lastMissingAt: "2026-11-04T02:30:00.000Z",
        returnedAt: null,
      },
    ],
    missingTruncated: false,
    alarms: [
      {
        id: "OceanErrors",
        name: "BaradunV2-OceanErrors",
        at: "2026-11-04T01:05:00.000Z",
        from: "OK",
        to: "ALARM",
      },
    ],
  };

  it("시작 → 경보·돌아온 관측소(시각순) → 이어지는 중. 돌아오지 않은 관측소는 넣지 않음", () => {
    expect(
      incidentTimeline(base, "2026-11-04T03:00:00.000Z").map((e) => [
        e.type,
        e.at,
      ]),
    ).toEqual([
      ["start", "2026-11-04T01:00:00.000Z"],
      ["alarm", "2026-11-04T01:05:00.000Z"],
      ["returned", "2026-11-04T02:00:00.000Z"],
      ["ongoing", "2026-11-04T03:00:00.000Z"],
    ]);
  });

  it("끝난 장애는 해결로 끝나고, 경보를 읽지 못했으면(null) 경보 줄 없이 그대로", () => {
    const events = incidentTimeline(
      { ...base, endedAt: "2026-11-04T02:40:00.000Z", alarms: null },
      "2026-11-04T03:00:00.000Z",
    );
    expect(events.map((e) => e.type)).toEqual(["start", "returned", "end"]);
  });
});

describe("경보", () => {
  it("경보 이름에서 묶음·출처를 읽고, 모르는 경보는 other(이름을 숨기지 않음)", () => {
    const classification = {
      kind: "stopped",
      source: "collect-ocean",
    } as const;
    expect(alarmInfo({ classification })).toEqual(classification);
    expect(alarmInfo({})).toEqual({ kind: "other", source: null });
  });

  it("울리는 경보를 먼저, 같은 상태는 이름순", () => {
    const alarm = (id: string, state: AlarmView["state"]): AlarmView => ({
      id,
      name: `BaradunV2-${id}`,
      state,
      stateUpdatedAt: null,
      description: "",
      windowMinutes: 5,
      functionName: null,
    });
    expect(
      sortedAlarms([
        alarm("RipErrors", "OK"),
        alarm("OceanErrors", "INSUFFICIENT_DATA"),
        alarm("WarningsStopped", "ALARM"),
        alarm("CatalogErrors", "OK"),
      ]).map((a) => a.id),
    ).toEqual(["WarningsStopped", "OceanErrors", "CatalogErrors", "RipErrors"]);
  });

  it("콘솔 주소: 지역이 없으면 기본 콘솔, 경보·함수 이름은 주소에 맞게 바꿈", () => {
    expect(cloudWatchUrl(null)).toBe(
      "https://console.aws.amazon.com/cloudwatch/home#alarmsV2:",
    );
    expect(cloudWatchUrl("ap-northeast-2", "BaradunV2-Ocean Errors")).toBe(
      "https://ap-northeast-2.console.aws.amazon.com/cloudwatch/home?region=ap-northeast-2#alarmsV2:alarm/BaradunV2-Ocean%20Errors",
    );
    expect(lambdaUrl("ap-northeast-2", "BaradunV2-Ocean")).toBe(
      "https://ap-northeast-2.console.aws.amazon.com/lambda/home?region=ap-northeast-2#/functions/BaradunV2-Ocean",
    );
  });
});

describe("normalizeCollection", () => {
  it("GH-375 전 응답은 게시 요약 null·경보 unavailable·지연 기준을 모름으로 두고 legacy로 표시", () => {
    const view = normalizeCollection({
      generatedAt: "2026-11-04T05:10:00.000Z",
      publishedVersion: "20261104T051000Z",
      jobs: [
        {
          job: "collect-ocean",
          lastRun: null,
          lastSuccessAt: null,
          day: { runs: 0, ok: 0 },
          week: { runs: 0, ok: 0 },
          hourly: [{ hour: "2026-11-04T01:00:00.000Z", runs: 2, ok: 2 }],
          incidents: [
            {
              startedAt: "2026-11-04T01:00:00.000Z",
              endedAt: null,
              runs: 1,
              failures: [],
            },
          ],
          truncated: false,
        },
      ],
    });
    expect(view.legacy).toBe(true);
    expect(view.publish).toBeNull();
    expect(view.alarms).toEqual({ status: "unavailable" });
    expect(view.jobs[0]).toMatchObject({
      overdue: null,
    });
    expect(view.jobs[0]!.hourly[0]!.late).toBe(false);
    expect(view.jobs[0]!.incidents[0]).toMatchObject({
      kind: "failure",
      stations: [],
      missingTruncated: false,
    });
  });

  it("새 응답은 그대로 두고 legacy가 아님. 모양이 틀린 경보는 읽지 못함으로", () => {
    const fresh = normalizeCollection({
      generatedAt: "2026-11-04T05:10:00.000Z",
      publishedVersion: null,
      publish: null,
      alarms: { status: "ok", region: "ap-northeast-2", list: [], history: [] },
      jobs: [
        {
          job: "collect-warnings",
          lastRun: null,
          lastSuccessAt: null,
          day: { runs: 0, ok: 0 },
          week: { runs: 0, ok: 0 },
          hourly: [],
          incidents: [],
          truncated: false,
          lateAfterMinutes: 20,
          overdue: true,
        },
      ],
    });
    expect(fresh.legacy).toBe(false);
    expect(fresh.jobs[0]).toMatchObject({
      lateAfterMinutes: 20,
      overdue: true,
    });
    expect(fresh.alarms.status).toBe("ok");
    expect(
      normalizeCollection({ publish: null, alarms: { status: "ok" }, jobs: [] })
        .alarms,
    ).toEqual({ status: "unavailable" });
  });
});

describe("출처 거르기", () => {
  const judgment = { job: "collect-warnings" as const, judgment: true };
  const reference = { job: "collect-rip" as const, judgment: false };
  it("문제 있음은 정상이 아닌 출처(기록 없음 포함)", () => {
    expect(matchesFilter("all", reference, "ok")).toBe(true);
    expect(matchesFilter("judgment", judgment, "ok")).toBe(true);
    expect(matchesFilter("judgment", reference, "ok")).toBe(false);
    expect(matchesFilter("reference", reference, "ok")).toBe(true);
    expect(matchesFilter("problem", judgment, "ok")).toBe(false);
    expect(matchesFilter("problem", reference, "none")).toBe(true);
    expect(matchesFilter("problem", judgment, "late")).toBe(true);
  });
});

describe("경보 묶음", () => {
  const alarm = (id: string, state: AlarmView["state"] = "OK"): AlarmView => ({
    id,
    name: `BaradunV2-${id}`,
    state,
    stateUpdatedAt: null,
    description: "",
    windowMinutes: 5,
    functionName: null,
  });
  it("서버 분류를 따르고 분류가 빠진 경보도 그 밖에 포함", () => {
    const groups = groupedAlarms([
      alarm("LoginAbuse"),
      {
        ...alarm("OceanErrors"),
        classification: { kind: "errors", source: "collect-ocean" },
      },
      {
        ...alarm("WarningsStopped"),
        classification: { kind: "stopped", source: "collect-warnings" },
      },
      {
        ...alarm("OceanStopped", "ALARM"),
        classification: { kind: "stopped", source: "collect-ocean" },
      },
    ]);
    expect(groups.map((g) => [g.kind, g.alarms.map((a) => a.id)])).toEqual([
      ["stopped", ["OceanStopped", "WarningsStopped"]],
      ["errors", ["OceanErrors"]],
      ["failing", []],
      ["other", ["LoginAbuse"]],
    ]);
  });

  it("로그 주소는 로그 그룹 이름의 /를 콘솔 형식으로 바꿈", () => {
    expect(logsUrl("ap-northeast-2", "BaradunV2-Ocean")).toBe(
      "https://ap-northeast-2.console.aws.amazon.com/cloudwatch/home?region=ap-northeast-2#logsV2:log-groups/log-group/$252Faws$252Flambda$252FBaradunV2-Ocean",
    );
  });
});

describe("장애 경과 순서 (Codex P2)", () => {
  it("장애 앞뒤 10분 안의 경보도 시작·해결과 함께 시각순으로", () => {
    const events = incidentTimeline(
      {
        kind: "failure",
        startedAt: "2026-11-04T00:00:00.000Z",
        endedAt: "2026-11-04T00:02:00.000Z",
        runs: 1,
        failures: [],
        stations: [],
        missingTruncated: false,
        alarms: [
          {
            id: "OceanErrors",
            name: "BaradunV2-OceanErrors",
            at: "2026-11-04T00:05:00.000Z",
            from: "OK",
            to: "ALARM",
          },
          {
            id: "OceanStopped",
            name: "BaradunV2-OceanStopped",
            at: "2026-11-03T23:55:00.000Z",
            from: "OK",
            to: "ALARM",
          },
        ],
      },
      "2026-11-04T01:00:00.000Z",
    );
    expect(events.map((e) => e.type)).toEqual([
      "alarm",
      "start",
      "end",
      "alarm",
    ]);
  });
});

describe("게시 요약 모양·장애 키 (Claude 리뷰)", () => {
  const base = {
    generatedAt: "2026-11-04T05:10:00.000Z",
    publishedVersion: null,
    alarms: { status: "unavailable" },
    jobs: [],
  };
  it("게시 요약 칸이 빠지거나 숫자가 아니면 null('확인 못 함')", () => {
    expect(
      normalizeCollection({
        ...base,
        publish: { version: "v", publishedAt: "t" },
      }).publish,
    ).toBeNull();
    expect(
      normalizeCollection({
        ...base,
        publish: {
          version: "v",
          publishedAt: "t",
          beachCount: "214",
          delayedBeaches: 1,
        },
      }).publish,
    ).toBeNull();
    const ok = {
      version: "v",
      publishedAt: "t",
      beachCount: 214,
      delayedBeaches: 0,
    };
    expect(normalizeCollection({ ...base, publish: ok }).publish).toEqual(ok);
  });

  it("장애 키는 수집기·종류·시작 시각으로 같은 장애를 가리킴", () => {
    expect(
      incidentKey({
        job: "collect-ocean",
        kind: "stations",
        startedAt: "2026-11-04T01:00:00.000Z",
        endedAt: null,
        runs: 1,
        failures: [],
        stations: [],
        missingTruncated: false,
      }),
    ).toBe("collect-ocean|stations|2026-11-04T01:00:00.000Z");
  });
});

describe("최종 리뷰 지적 (#378)", () => {
  const base = {
    generatedAt: "2026-11-04T05:10:00.000Z",
    publishedVersion: null,
    publish: null,
  };
  const incident = (extra: Record<string, unknown> = {}) => ({
    kind: "failure",
    startedAt: "2026-11-04T01:00:00.000Z",
    endedAt: null,
    runs: 1,
    failures: [],
    stations: [],
    missingTruncated: false,
    ...extra,
  });

  it("모르는 경보 상태는 unknown, 모양이 틀린 경보 목록은 읽지 못함", () => {
    const view = normalizeCollection({
      ...base,
      alarms: {
        status: "ok",
        region: "ap-northeast-2",
        list: [
          { id: "OceanErrors", name: "BaradunV2-OceanErrors", state: "NEW" },
        ],
        history: [],
      },
      jobs: [],
    });
    expect(view.alarms.status === "ok" && view.alarms.list[0]!.state).toBe(
      "unknown",
    );
    expect(
      normalizeCollection({
        ...base,
        alarms: { status: "ok", region: "r", list: [{ name: 1 }], history: [] },
        jobs: [],
      }).alarms,
    ).toEqual({ status: "unavailable" });
  });

  it("해변 영향·장애 경보 모양이 틀리면 영향은 빼고(응답에 없음) 경보는 null(확인 못 함)", () => {
    const job = {
      job: "collect-ocean",
      lastRun: null,
      lastSuccessAt: null,
      day: { runs: 0, ok: 0 },
      week: { runs: 0, ok: 0 },
      hourly: [],
      truncated: false,
      lateAfterMinutes: 35,
      overdue: false,
      incidents: [
        incident({ impact: { status: "affected" }, alarms: [{ at: 1 }] }),
      ],
    };
    const view = normalizeCollection({
      ...base,
      alarms: { status: "unavailable" },
      jobs: [job],
    });
    const out = view.jobs[0]!.incidents[0]!;
    expect(out.impact).toBeUndefined();
    expect(out.alarms).toBeNull();
  });

  it("같은 시각 장애는 실패 → 관측소 빠짐, 수집기 이름 순으로 늘 같은 순서", () => {
    const at = "2026-11-04T01:00:00.000Z";
    const mk = (job: string, kind: "failure" | "stations") =>
      job_({
        job,
        incidents: [{ ...incident({ kind }), startedAt: at } as never],
      });
    const list = allIncidents([
      mk("collect-ocean", "stations"),
      mk("collect-warnings", "failure"),
      mk("collect-ocean", "failure"),
    ]);
    expect(list.map((i) => `${i.job}|${i.kind}`)).toEqual([
      "collect-ocean|failure",
      "collect-warnings|failure",
      "collect-ocean|stations",
    ]);
  });
});

describe("관측소 목록 (GH-380)", () => {
  const station = {
    id: "22105",
    name: "강릉 부이",
    beachIds: ["b0001"],
    waveBeachIds: ["b0001"],
    state: "missing",
    inTable: true,
    missingSince: "2026-11-10T05:00:00.000Z",
  };
  const base = { generatedAt: "2026-11-10T06:00:00.000Z", jobs: [] };

  it("모양이 맞으면 그대로, 칸이 없으면(배포 전 서버) 확인 못 함", () => {
    expect(
      normalizeCollection({
        ...base,
        stations: { status: "ok", checkedAt: null, list: [station] },
      }).stations,
    ).toEqual({ status: "ok", checkedAt: null, list: [station] });
    expect(normalizeCollection(base).stations).toEqual({
      status: "unavailable",
    });
  });

  it("빈 목록·읽을 수 없는 기준 시각은 '0곳·문제 없음'이 아니라 확인 못 함", () => {
    for (const stations of [
      { status: "ok", checkedAt: null, list: [] },
      { status: "ok", checkedAt: "모름", list: [station] },
    ]) {
      expect(normalizeCollection({ ...base, stations }).stations).toEqual({
        status: "unavailable",
      });
    }
  });

  it("한 줄이라도 모양이 틀리거나 모르는 상태면 목록 전체를 확인 못 함(남은 줄을 전체로 보이지 않게)", () => {
    for (const bad of [
      { ...station, state: "late" },
      { ...station, beachIds: null },
      { ...station, missingSince: 3 },
      { ...station, missingSince: "어제" },
    ]) {
      expect(
        normalizeCollection({
          ...base,
          stations: { status: "ok", checkedAt: null, list: [station, bad] },
        }).stations,
      ).toEqual({ status: "unavailable" });
    }
  });
});

describe("kstClock", () => {
  const now = "2026-11-10T06:00:00.000Z"; // KST 11/10 15:00
  it("같은 날(KST)이면 시각만, 초를 원하면 초까지", () => {
    expect(kstClock("2026-11-10T05:33:05.000Z", now)).toBe("14:33");
    expect(kstClock("2026-11-10T05:33:05.000Z", now, true)).toBe("14:33:05");
  });
  it("다른 날이면 초 없이 날짜를 붙임(어제 값을 오늘로 읽지 않게)", () => {
    // UTC로는 같은 날이지만 KST로는 11/9
    expect(kstClock("2026-11-09T14:59:00.000Z", now, true)).toBe("11/9 23:59");
  });
});

describe("수집 현황 표시", () => {
  it("예정 시각 누락과 형식 오류를 구분한다", () => {
    const job = { overdue: false, hourly: [], incidents: [] };
    const view = normalizeCollection({
      jobs: [job, { ...job, nextScheduledAt: "invalid" }],
    });
    expect(view.jobs[0]).not.toHaveProperty("nextScheduledAt");
    expect(view.jobs[1]).toHaveProperty("nextScheduledAt", null);
  });

  it.each([
    [20, "20분 넘으면 지연"],
    [35, "35분 넘으면 지연"],
    [180, "180분 넘으면 지연"],
    [null, "지연 표시 안 함"],
    [undefined, "지연 기준 확인 못 함"],
  ])("서버 기준 %s의 주기 줄", (minutes, text) => {
    expect(cycleDelayText(minutes)).toBe(text);
  });

  it.each([
    ["resultCode:22", "호출 한도 초과"],
    ["result:22", "호출 한도 초과"],
    ["http:429", "호출 한도 초과"],
    ["timeout", "응답 시간 초과"],
    ["resultCode:123456", "알 수 없는 오류"],
    ["new-code", "알 수 없는 오류"],
  ])("장애 사유 %s의 제목", (reason, title) => {
    expect(incidentErrorTitle({ source: "pwncd", reason })).toBe(title);
  });
});
