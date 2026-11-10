import { describe, expect, it } from "vitest";
import {
  allIncidents,
  incidentMinutes,
  kstHour,
  lowestHour,
  overallHourly,
  reasonOf,
  sourceState,
  successRate,
  versionTime,
  type JobCollection,
} from "./collection";

// 수집 현황 화면 계산 (BRD-149). 기록 없음·일부 실패를 정상으로 바꾸지 않음

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
