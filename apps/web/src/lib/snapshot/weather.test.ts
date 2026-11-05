import type { WeatherFile } from "@baradun/contracts";
import { describe, expect, it } from "vitest";

import example from "../../../../../packages/contracts/examples/valid/weather.json";
import { beachWeather, readWeatherGrid } from "./weather";

// 날씨 파일 읽기 (BRD-185). 계약 예시(examples/valid/weather.json)를 그대로 씀
const file = example as unknown as WeatherFile;

describe("beachWeather", () => {
  it("해변 → 격자·중기 구역·기온 지점", () => {
    const view = beachWeather(file, "b0002");
    expect(view).toMatchObject({ kind: "ready", midLandId: "11D20000" });
    if (view.kind !== "ready") throw new Error("ready가 아님");
    expect(view.grid.short?.points).toHaveLength(2);
    expect(view.midLand?.name).toBe("강원영동");
    expect(view.midTa?.name).toBe("강릉");
  });

  it("단기예보를 받지 못한 격자도 읽음(화면이 안내 한 줄로 그림)", () => {
    const view = beachWeather(file, "b0008");
    expect(view).toMatchObject({
      kind: "ready",
      grid: { short: null, now: null },
    });
  });

  it("대응표에 없는 해변은 none(카드를 두지 않음)", () => {
    expect(beachWeather(file, "b9999")).toEqual({ kind: "none" });
  });

  it("격자가 없거나 칸 하나라도 읽을 수 없으면 failed(일부만 그리지 않음)", () => {
    const broken = structuredClone(file);
    (broken.grids["93,133"]!.short!.points[0] as { pop: unknown }).pop = "70";
    expect(beachWeather(broken, "b0002")).toEqual({ kind: "failed" });
    const missing = structuredClone(file);
    delete missing.grids["93,133"];
    expect(beachWeather(missing, "b0002")).toEqual({ kind: "failed" });
  });

  it("중기 구역 칸을 읽을 수 없으면 그 구역만 null(중기만 실패)", () => {
    const broken = structuredClone(file);
    (broken.midLand["11D20000"]!.days[0] as { date: unknown }).date = "11/9";
    const view = beachWeather(broken, "b0002");
    expect(view).toMatchObject({ kind: "ready", midLand: null });
  });
});

describe("readWeatherGrid", () => {
  it("지금 기온의 시각이 틀리면 버림", () => {
    const grid = structuredClone(file.grids["93,133"]!);
    (grid.now as { observedAt: string }).observedAt = "2026-11-05 09:00";
    expect(readWeatherGrid(grid)).toBeNull();
  });
});
