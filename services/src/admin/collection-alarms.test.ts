import { describe, expect, it } from "vitest";
import type { Incident } from "./collection";
import {
  alarmJob,
  incidentAlarms,
  readAlarms,
  toAlarmEvent,
  toAlarmView,
  type AlarmReader,
} from "./collection-alarms";

// 수집 현황 · CloudWatch 경보 (BRD-187). 스택 접두어 경보만, 읽지 못하면 '확인 못 함'

const PREFIX = "BaradunV2-";
const NOW = new Date("2026-11-02T05:00:00Z");

// 오류 경보: 5분 × 1구간, 대상 함수는 차원에 있음
const OCEAN_ERRORS = {
  AlarmName: "BaradunV2-OceanErrors",
  AlarmDescription: "바다 관측 수집 실패. 사유는 CloudWatch 로그의 reason",
  StateValue: "OK",
  StateUpdatedTimestamp: new Date("2026-11-02T03:05:00Z"),
  Period: 300,
  EvaluationPeriods: 1,
  Dimensions: [{ Name: "FunctionName", Value: "BaradunV2-OceanFunction" }],
};

// 심장박동 경보: 수식 경보(Period가 MetricStat 안), 5분 × 12구간
const OCEAN_STOPPED = {
  AlarmName: "BaradunV2-OceanStopped",
  AlarmDescription: "바다 관측 수집이 돌지 않음",
  StateValue: "INSUFFICIENT_DATA",
  EvaluationPeriods: 12,
  Metrics: [
    { Id: "expr", Expression: "FILL(m, 0)", Period: 300 },
    {
      Id: "m",
      MetricStat: {
        Period: 300,
        Metric: {
          Dimensions: [
            { Name: "FunctionName", Value: "BaradunV2-OceanFunction" },
          ],
        },
      },
    },
  ],
};

const history = (name: string, at: string, from: string, to: string) => ({
  AlarmName: name,
  Timestamp: new Date(at),
  HistoryData: JSON.stringify({
    oldState: { stateValue: from },
    newState: { stateValue: to },
  }),
});

function reader(
  alarms: unknown[],
  items: Record<string, unknown[]>,
  fail?: "describe" | "history",
): AlarmReader {
  return {
    region: "ap-northeast-2",
    prefix: PREFIX,
    async describe() {
      if (fail === "describe") throw new Error("AccessDenied");
      return alarms;
    },
    async history(name) {
      if (fail === "history") throw new Error("Throttling");
      return items[name] ?? [];
    },
  };
}

describe("toAlarmView", () => {
  it("오류 경보의 창(구간 × 구간 수)과 대상 함수를 읽는다", () => {
    expect(toAlarmView(OCEAN_ERRORS, PREFIX)).toEqual({
      id: "OceanErrors",
      name: "BaradunV2-OceanErrors",
      state: "OK",
      stateUpdatedAt: "2026-11-02T03:05:00.000Z",
      description: "바다 관측 수집 실패. 사유는 CloudWatch 로그의 reason",
      windowMinutes: 5,
      functionName: "BaradunV2-OceanFunction",
    });
  });

  it("수식 경보는 지표 안의 구간으로 창을 셈(관측 60분)", () => {
    expect(toAlarmView(OCEAN_STOPPED, PREFIX)).toMatchObject({
      id: "OceanStopped",
      state: "INSUFFICIENT_DATA",
      stateUpdatedAt: null,
      windowMinutes: 60,
      functionName: "BaradunV2-OceanFunction",
    });
  });

  it("접두어가 다른 경보는 버리고, 모르는 상태는 unknown", () => {
    expect(
      toAlarmView({ ...OCEAN_ERRORS, AlarmName: "Other-X" }, PREFIX),
    ).toBeNull();
    expect(
      toAlarmView({ ...OCEAN_ERRORS, StateValue: "MUTED" }, PREFIX)?.state,
    ).toBe("unknown");
  });
});

describe("toAlarmEvent", () => {
  it("상태 변경 기록의 이전·다음 상태를 읽고, 깨진 기록은 unknown으로 둔다", () => {
    expect(
      toAlarmEvent(
        history("BaradunV2-OceanErrors", "2026-11-02T02:15:00Z", "OK", "ALARM"),
        PREFIX,
      ),
    ).toEqual({
      id: "OceanErrors",
      name: "BaradunV2-OceanErrors",
      at: "2026-11-02T02:15:00.000Z",
      from: "OK",
      to: "ALARM",
    });
    expect(
      toAlarmEvent(
        {
          AlarmName: "BaradunV2-OceanErrors",
          Timestamp: NOW,
          HistoryData: "{",
        },
        PREFIX,
      ),
    ).toMatchObject({ from: "unknown", to: "unknown" });
    expect(
      toAlarmEvent({ AlarmName: "BaradunV2-OceanErrors" }, PREFIX),
    ).toBeNull();
  });
});

describe("readAlarms", () => {
  it("읽기 도구가 없으면 확인 못 함", async () => {
    expect(await readAlarms(null, NOW)).toEqual({ status: "unavailable" });
  });

  it("경보 설정과 상태 변경 기록을 최신 먼저 돌려준다", async () => {
    const view = await readAlarms(
      reader([OCEAN_STOPPED, OCEAN_ERRORS], {
        "BaradunV2-OceanErrors": [
          history(
            "BaradunV2-OceanErrors",
            "2026-11-02T02:15:00Z",
            "OK",
            "ALARM",
          ),
          history(
            "BaradunV2-OceanErrors",
            "2026-11-02T03:05:00Z",
            "ALARM",
            "OK",
          ),
        ],
      }),
      NOW,
    );
    expect(view.status).toBe("ok");
    if (view.status !== "ok") return;
    expect(view.region).toBe("ap-northeast-2");
    expect(view.list.map((a) => a.id)).toEqual(["OceanErrors", "OceanStopped"]);
    expect(view.history.map((e) => e.at)).toEqual([
      "2026-11-02T03:05:00.000Z",
      "2026-11-02T02:15:00.000Z",
    ]);
  });

  it("설정이나 기록 하나라도 읽지 못하면 일부만 보여 주지 않고 확인 못 함", async () => {
    expect(
      await readAlarms(reader([OCEAN_ERRORS], {}, "describe"), NOW),
    ).toEqual({
      status: "unavailable",
    });
    expect(
      await readAlarms(reader([OCEAN_ERRORS], {}, "history"), NOW),
    ).toEqual({
      status: "unavailable",
    });
  });
});

describe("incidentAlarms", () => {
  const incident: Incident = {
    startedAt: "2026-11-02T02:10:00.000Z",
    endedAt: "2026-11-02T03:00:00.000Z",
    runs: 2,
    failures: [],
    stations: [],
  };

  it("그 수집기 경보가 장애 동안(앞뒤 10분) ALARM으로 바뀐 기록만", async () => {
    const view = await readAlarms(
      reader([OCEAN_ERRORS], {
        "BaradunV2-OceanErrors": [
          history(
            "BaradunV2-OceanErrors",
            "2026-11-02T02:15:00Z",
            "OK",
            "ALARM",
          ),
          history(
            "BaradunV2-OceanErrors",
            "2026-11-02T03:05:00Z",
            "ALARM",
            "OK",
          ),
          history(
            "BaradunV2-OceanErrors",
            "2026-11-01T22:00:00Z",
            "OK",
            "ALARM",
          ),
        ],
      }),
      NOW,
    );
    expect(
      incidentAlarms(view, "collect-ocean", incident, NOW.getTime())?.map(
        (e) => e.at,
      ),
    ).toEqual(["2026-11-02T02:15:00.000Z"]);
    expect(
      incidentAlarms(view, "collect-warnings", incident, NOW.getTime()),
    ).toEqual([]);
  });

  it("경보를 읽지 못했으면 빈 목록이 아니라 null", () => {
    expect(
      incidentAlarms(
        { status: "unavailable" },
        "collect-ocean",
        incident,
        NOW.getTime(),
      ),
    ).toBeNull();
  });

  it("경보 ID 앞부분으로 수집기를 찾고, 게시·로그인 경보는 수집기가 아님", () => {
    expect(alarmJob("WarningsStopped")).toBe("collect-warnings");
    expect(alarmJob("WeatherFailing")).toBe("collect-weather");
    expect(alarmJob("PublishErrors")).toBeNull();
    expect(alarmJob("LoginAbuse")).toBeNull();
  });
});
