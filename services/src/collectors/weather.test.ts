import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import areasJson from "../../../data/weather-areas.json";
import type { HttpResult } from "../core/collect/http";
import { createLogger } from "../core/collect/log";
import { MemoryOpsStore, MemoryStateStore } from "../core/store/memory";
import { readMid, readNow, readShort } from "../core/weather/state";
import {
  collectWeather,
  latestBase,
  parseWeatherAreas,
  WEATHER_JOB,
  WEATHER_STATE,
  type WeatherAreas,
} from "./weather";

// collect-weather (BRD-181). HTTP·키·저장소를 가짜로 바꿔 실패 경로를 확인
// 응답 본문은 실응답 픽스처(경포 격자 93,133 · 강원영동 · 강릉). 단기예보는 발표 시각만 08:00으로 바꿔 씀

const fixture = (name: string) =>
  readFileSync(
    new URL(`../core/weather/fixtures/${name}`, import.meta.url),
    "utf8",
  );
const SHORT_0800 = fixture("vilage-93-133-202611050200.json").replaceAll(
  '"baseTime":"0200"',
  '"baseTime":"0800"',
);
const NOW_0900 = fixture("ncst-20261105-0900.json");
const LAND_0600 = fixture("midland-202611050600.json");
const TA_0600 = fixture("midta-202611050600.json");
const KEY = "WEATHER-KEY-SECRET";
const AREAS: WeatherAreas = {
  grids: [{ nx: 93, ny: 133 }],
  land: ["11D20000"],
  ta: ["11D20501"],
};
const RUN_AT = "2026-11-05T00:15:00Z"; // KST 09:15 → 실황 09:00 · 단기 08:00 · 중기 06:00

type Reply = HttpResult | string;
const ok = (body: string): HttpResult => ({
  status: "ok",
  body,
  httpStatus: 200,
  attempts: 1,
});
const op = (url: string) => new URL(url).pathname.split("/").at(-1)!;
const REAL: Record<string, Reply> = {
  getUltraSrtNcst: NOW_0900,
  getVilageFcst: SHORT_0800,
  getMidLandFcst: LAND_0600,
  getMidTa: TA_0600,
};

function setup(
  options: {
    now?: string;
    replies?: Record<string, Reply>;
    key?: boolean;
    state?: MemoryStateStore;
  } = {},
) {
  const state = options.state ?? new MemoryStateStore();
  const ops = new MemoryOpsStore();
  const urls: string[] = [];
  const lines: string[] = [];
  let nowMs = Date.parse(options.now ?? RUN_AT);
  const deps = {
    state,
    ops,
    keys: {
      get: async () => {
        if (options.key === false) throw new Error("no key");
        return KEY;
      },
    },
    get: async (url: string) => {
      urls.push(url);
      const reply = { ...REAL, ...options.replies }[op(url)]!;
      return typeof reply === "string" ? ok(reply) : reply;
    },
    log: createLogger(
      () => [KEY],
      (line) => lines.push(line),
    ),
    clock: () => nowMs,
    owner: "run-1",
    areas: AREAS,
  };
  const at = (iso: string) => {
    nowMs = Date.parse(iso);
  };
  const events = () =>
    lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { deps, state, ops, urls, lines, at, events };
}

const stored = async (state: MemoryStateStore) => ({
  short: readShort(
    (await state.getState(WEATHER_STATE.short.pk, WEATHER_STATE.short.sk))
      ?.value,
  ),
  now: readNow(
    (await state.getState(WEATHER_STATE.now.pk, WEATHER_STATE.now.sk))?.value,
  ),
  mid: readMid(
    (await state.getState(WEATHER_STATE.mid.pk, WEATHER_STATE.mid.sk))?.value,
  ),
});

describe("collectWeather", () => {
  it("실황·단기·중기를 받아 저장하고 슬롯을 끝냄", async () => {
    const { deps, state, ops, urls } = setup();
    expect(await collectWeather(deps)).toEqual({
      status: "complete",
      slotId: "202611050915",
    });
    expect(urls.map(op).sort()).toEqual([
      "getMidLandFcst",
      "getMidTa",
      "getUltraSrtNcst",
      "getVilageFcst",
    ]);
    const s = await stored(state);
    expect(s.now!["93,133"]).toEqual({
      observedAt: "2026-11-05T00:00:00Z",
      temperature: 11.2,
    });
    expect(s.short!["93,133"]!.issuedAt).toBe("2026-11-04T23:00:00Z");
    expect(Object.keys(s.mid!.land["11D20000"]!)[0]).toBe("2026-11-09");
    expect(s.mid!.ta["11D20501"]!["2026-11-09"]).toMatchObject({
      issuedAt: "2026-11-04T21:00:00Z",
    });
    expect(
      await ops.claimSlot(WEATHER_JOB, "202611050915", "next", Date.now(), 1),
    ).toBe("done");
  });

  it("다음 실행은 이미 받은 단기·중기 발표를 다시 부르지 않고 실황만 부름", async () => {
    const state = new MemoryStateStore();
    await collectWeather(setup({ state }).deps);
    const second = setup({
      state,
      now: "2026-11-05T01:15:00Z",
      replies: {
        getUltraSrtNcst: NOW_0900.replaceAll('"0900"', '"1000"'),
      },
    });
    expect(await collectWeather(second.deps)).toMatchObject({
      status: "complete",
    });
    expect(second.urls.map(op)).toEqual(["getUltraSrtNcst"]);
  });

  it("단기예보가 시간 초과면 그것만 실패로 남기고 받은 값은 저장(partial)", async () => {
    const { deps, state, events } = setup({
      replies: {
        getVilageFcst: { status: "failed", reason: "timeout", attempts: 2 },
      },
    });
    expect(await collectWeather(deps)).toEqual({
      status: "partial",
      slotId: "202611050915",
      failures: [{ source: "short", reason: "timeout" }],
    });
    const s = await stored(state);
    expect(s.short).toBeNull();
    expect(s.now!["93,133"]!.temperature).toBe(11.2);
    expect(
      events().find((e) => e.event === "weather_run_finished"),
    ).toMatchObject({ status: "partial", short: 0, now: 1 });
  });

  it("실황을 받지 못하면 이전 기온을 덮지 않음(오래되면 publisher가 null로 거름)", async () => {
    const state = new MemoryStateStore();
    await collectWeather(setup({ state }).deps);
    const failed = setup({
      state,
      now: "2026-11-05T01:15:00Z",
      replies: {
        getUltraSrtNcst: JSON.stringify({
          response: { header: { resultCode: "03" } },
        }),
      },
    });
    expect(await collectWeather(failed.deps)).toMatchObject({
      status: "failed",
      failures: [{ source: "now", reason: "result:03" }],
    });
    expect((await stored(state)).now!["93,133"]!.observedAt).toBe(
      "2026-11-05T00:00:00Z",
    );
  });

  it("키를 읽지 못하면 부르지 않고 실패, 저장값은 그대로", async () => {
    const { deps, state, urls } = setup({ key: false });
    expect(await collectWeather(deps)).toEqual({
      status: "failed",
      slotId: "202611050915",
      failures: [{ source: "weather", reason: "api_key" }],
    });
    expect(urls).toEqual([]);
    expect(await stored(state)).toEqual({ short: null, now: null, mid: null });
  });

  it("로그·실패 사유에 키를 남기지 않음", async () => {
    const { deps, lines } = setup({
      replies: {
        getMidTa: { status: "failed", reason: "http:500", attempts: 2 },
      },
    });
    await collectWeather(deps);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("같은 슬롯을 이미 끝냈으면 건너뜀", async () => {
    const state = new MemoryStateStore();
    const first = setup({ state });
    await collectWeather(first.deps);
    const again = { ...first.deps, owner: "run-2" };
    expect(await collectWeather(again)).toEqual({
      status: "skipped",
      slotId: "202611050915",
      claim: "done",
    });
  });
});

describe("latestBase", () => {
  it("발표 뒤 기다리는 분이 지나야 그 발표를 씀", () => {
    // KST 08:05 → 단기 08:00은 10분 전이라 아직 05:00
    expect(
      latestBase(Date.parse("2026-11-04T23:05:00Z"), [2, 5, 8], 10),
    ).toMatchObject({ date: "20261105", time: "0500" });
    // KST 06:30 → 중기 06:00은 1시간 전이라 아직 전날 18:00
    expect(
      latestBase(Date.parse("2026-11-04T21:30:00Z"), [6, 18], 60),
    ).toMatchObject({ date: "20261104", time: "1800" });
  });
});

describe("parseWeatherAreas", () => {
  it("실제 대응표: 격자 140·육상 구역 8·기온 지점 34", () => {
    const areas = parseWeatherAreas(areasJson);
    expect(areas.grids).toHaveLength(140);
    expect(areas.land).toHaveLength(8);
    expect(areas.ta).toHaveLength(34);
  });

  it("모양이 틀린 항목이 있으면 멈춤(틀린 목록으로 돌지 않음)", () => {
    expect(() =>
      parseWeatherAreas({
        beaches: {
          b0001: {
            grid: { nx: "93", ny: 133 },
            midLand: { regId: "11D20000" },
            midTa: { regId: "11D20501" },
          },
        },
      }),
    ).toThrow(/형식 오류/);
    expect(() => parseWeatherAreas({ beaches: {} })).toThrow(/해변 없음/);
  });
});
