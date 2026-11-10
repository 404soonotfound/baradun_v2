import { describe, expect, it } from "vitest";
import type { StationTable } from "../core/collect/publish-summary";
import type { RunView } from "./collection";
import { stationsView } from "./collection-stations";

// 관측소 목록 (GH-380). 상태는 대조한 성공 실행 기준, 모르면 unknown('정상'으로 보지 않음)

const TABLE: StationTable = {
  "22451": {
    name: "속초 파고부이",
    beachIds: ["b0001", "b0002"],
    waveBeachIds: ["b0001", "b0002"],
  },
  "22520": { name: "울진 해양기상부이", beachIds: ["b0003"], waveBeachIds: [] },
  "22104": {
    name: "강릉 파고부이",
    beachIds: ["b0004"],
    waveBeachIds: ["b0004"],
  },
};

function run(
  startedAt: string,
  status: RunView["status"],
  missingStations?: string[],
  missingStationsTotal?: number,
): RunView {
  return {
    startedAt,
    finishedAt: startedAt,
    status,
    failures: [],
    ...(missingStations ? { missingStations } : {}),
    ...(missingStationsTotal ? { missingStationsTotal } : {}),
  };
}

const states = (view: ReturnType<typeof stationsView>) =>
  view.status === "ok"
    ? view.list.map((s) => [s.id, s.state, s.missingSince])
    : view.status;

describe("stationsView", () => {
  it("관측소 표를 못 읽으면 unavailable", () => {
    expect(stationsView(null, [])).toEqual({ status: "unavailable" });
  });

  it("관측소 표가 비었으면 '0곳·문제 없음'이 아니라 unavailable", () => {
    expect(
      stationsView({}, [run("2026-11-10T05:10:00.000Z", "complete", [])]),
    ).toEqual({ status: "unavailable" });
  });

  it("대조한 성공 실행 기준으로 빠짐·정상을 나누고, 빠진 관측소가 먼저 온다", () => {
    const view = stationsView(TABLE, [
      run("2026-11-10T04:10:00.000Z", "complete", []),
      run("2026-11-10T04:40:00.000Z", "complete", ["22520"]),
      run("2026-11-10T05:10:00.000Z", "complete", ["22520"]),
    ]);
    expect(view).toMatchObject({
      status: "ok",
      checkedAt: "2026-11-10T05:10:00.000Z",
    });
    expect(states(view)).toEqual([
      ["22520", "missing", "2026-11-10T04:40:00.000Z"],
      ["22104", "ok", null],
      ["22451", "ok", null],
    ]);
  });

  it("일부 실패 실행은 상태 기준으로 쓰지 않고, 처음 빠진 시각을 셀 때는 건너뛴다", () => {
    const view = stationsView(TABLE, [
      run("2026-11-10T04:10:00.000Z", "complete", []),
      run("2026-11-10T04:40:00.000Z", "partial", ["22451"]),
      run("2026-11-10T05:10:00.000Z", "complete", ["22451"]),
      // 실패한 출처를 대조하지 않은 실행: 22451이 없어도 돌아왔다고 보지 않음
      run("2026-11-10T05:40:00.000Z", "partial", []),
    ]);
    expect(view).toMatchObject({ checkedAt: "2026-11-10T05:10:00.000Z" });
    expect(states(view)).toContainEqual([
      "22451",
      "missing",
      "2026-11-10T04:40:00.000Z",
    ]);
  });

  it("대조한 실행이 없으면 모든 관측소가 unknown(기준 시각 없음)", () => {
    const view = stationsView(TABLE, [
      run("2026-11-10T05:10:00.000Z", "complete"),
      run("2026-11-10T05:40:00.000Z", "failed"),
    ]);
    expect(view).toMatchObject({ checkedAt: null });
    expect(
      view.status === "ok" && view.list.every((s) => s.state === "unknown"),
    ).toBe(true);
  });

  it("빠진 목록이 잘렸으면 목록에 없는 관측소는 정상이 아니라 unknown", () => {
    const view = stationsView(TABLE, [
      run("2026-11-10T05:10:00.000Z", "complete", ["22451"], 120),
    ]);
    expect(states(view)).toEqual([
      ["22451", "missing", "2026-11-10T05:10:00.000Z"],
      ["22104", "unknown", null],
      ["22520", "unknown", null],
    ]);
  });

  it("관측소 표에 없는 빠진 관측소도 목록에 남기고(이름 모름), 잘린 실행에서 처음 빠진 시각을 끊지 않는다", () => {
    const view = stationsView(TABLE, [
      // 120곳 중 일부만 기록: 22451이 목록에 없어도 돌아왔다고 보지 않음
      run("2026-11-10T04:10:00.000Z", "complete", ["22451"], 120),
      run("2026-11-10T04:40:00.000Z", "complete", ["22520"], 120),
      run("2026-11-10T05:10:00.000Z", "complete", ["22520", "29999"]),
    ]);
    expect(view.status === "ok" && view.list.slice(0, 2)).toEqual([
      expect.objectContaining({
        id: "29999",
        name: "29999",
        state: "missing",
        inTable: false,
        beachIds: [],
      }),
      expect.objectContaining({
        id: "22520",
        state: "missing",
        inTable: true,
        missingSince: "2026-11-10T04:40:00.000Z",
      }),
    ]);
  });
});
