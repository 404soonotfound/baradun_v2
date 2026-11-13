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

  it("이번 시각 실황이 아직 없으면(03) 한 시간 전 실황을 받음", async () => {
    const { deps, state, urls } = setup({ now: "2026-11-05T01:15:00Z" });
    // 10:00 실황은 아직 없음, 09:00 실황은 픽스처
    deps.get = async (url: string) => {
      urls.push(url);
      const params = new URL(url).searchParams;
      if (op(url) === "getUltraSrtNcst") {
        return ok(
          params.get("base_time") === "0900"
            ? NOW_0900
            : JSON.stringify({ response: { header: { resultCode: "03" } } }),
        );
      }
      return ok(REAL[op(url)] as string);
    };
    expect(await collectWeather(deps)).toMatchObject({ status: "complete" });
    expect(
      urls
        .filter((u) => op(u) === "getUltraSrtNcst")
        .map((u) => new URL(u).searchParams.get("base_time")),
    ).toEqual(["1000", "0900"]);
    expect((await stored(state)).now!["93,133"]!.observedAt).toBe(
      "2026-11-05T00:00:00Z",
    );
  });

  it("이번 시각 확인은 첫 격자로 한 번만: 나왔으면 그 응답을 쓰고, 없으면 모든 격자를 한 시간 전으로 부름", async () => {
    const grids = [
      { nx: 93, ny: 133 },
      { nx: 93, ny: 134 },
    ];
    const nowReply = (nx: string, ny: string, time: string) =>
      NOW_0900.replaceAll('"nx":93', `"nx":${nx}`)
        .replaceAll('"ny":133', `"ny":${ny}`)
        .replaceAll('"0900"', `"${time}"`);
    const run = async (current: boolean) => {
      const { deps, urls } = setup({ now: "2026-11-05T01:15:00Z" });
      deps.areas = { ...AREAS, grids };
      deps.get = async (url: string) => {
        urls.push(url);
        const p = new URL(url).searchParams;
        if (op(url) !== "getUltraSrtNcst") {
          return ok(
            op(url) === "getVilageFcst"
              ? SHORT_0800.replaceAll(
                  '"nx":93',
                  `"nx":${p.get("nx")}`,
                ).replaceAll('"ny":133', `"ny":${p.get("ny")}`)
              : (REAL[op(url)] as string),
          );
        }
        const time = p.get("base_time")!;
        return ok(
          time === "1000" && !current
            ? JSON.stringify({ response: { header: { resultCode: "03" } } })
            : nowReply(p.get("nx")!, p.get("ny")!, time),
        );
      };
      await collectWeather(deps);
      return urls
        .filter((u) => op(u) === "getUltraSrtNcst")
        .map((u) => new URL(u).searchParams.get("base_time"));
    };
    expect(await run(true)).toEqual(["1000", "1000"]);
    expect(await run(false)).toEqual(["1000", "0900", "0900"]);
  });

  it("첫 격자 실황 확인을 기다리는 동안 시간 예산이 지나면 다른 격자는 부르지 않고 budget으로 남김", async () => {
    const grids = [
      { nx: 93, ny: 133 },
      { nx: 93, ny: 134 },
    ];
    // 단기·중기는 이미 받아 둠 → 다음 실행은 실황만 부름
    const state = new MemoryStateStore();
    const first = setup({ state });
    first.deps.areas = { ...AREAS, grids: [grids[0]!] };
    await collectWeather(first.deps);
    const { deps, urls, at } = setup({ state, now: "2026-11-05T01:15:00Z" });
    deps.areas = { ...AREAS, grids };
    deps.get = async (url: string) => {
      urls.push(url);
      // 확인 요청(첫 실황)이 느려 예산(30초)을 넘긴 뒤 03으로 끝남
      if (op(url) === "getUltraSrtNcst") at("2026-11-05T01:15:40Z");
      return ok(
        op(url) === "getUltraSrtNcst"
          ? JSON.stringify({ response: { header: { resultCode: "03" } } })
          : (REAL[op(url)] as string),
      );
    };
    const result = await collectWeather(deps);
    expect(result).toMatchObject({ status: "failed" });
    expect(
      (result as { failures: readonly unknown[] }).failures,
    ).toContainEqual({
      source: "weather",
      reason: "budget",
      count: 2,
    });
    expect(urls.filter((u) => op(u) === "getUltraSrtNcst")).toHaveLength(1);
  });

  it("단기·중기를 실황보다 먼저 부름(시간 예산에 걸려도 덜 자주 오는 발표를 지킴)", async () => {
    const { deps, urls } = setup();
    await collectWeather(deps);
    expect(urls.map(op).at(-1)).toBe("getUltraSrtNcst");
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

  // BRD-186: 기상청 일시 오류는 같은 실행 안에서 한 번 더 받음
  const RESULT = (code: string, msg?: string) =>
    JSON.stringify({
      response: {
        header: {
          resultCode: code,
          ...(msg !== undefined ? { resultMsg: msg } : {}),
        },
      },
    });
  // op마다 정해 둔 응답을 차례로 줌(다 쓰면 실응답)
  const sequence = (
    s: ReturnType<typeof setup>,
    plan: Record<string, Reply[]>,
  ) => {
    s.deps.get = async (url: string) => {
      s.urls.push(url);
      const reply = plan[op(url)]?.shift() ?? REAL[op(url)]!;
      return typeof reply === "string" ? ok(reply) : reply;
    };
  };
  const calls = (urls: string[], name: string) =>
    urls.filter((u) => op(u) === name).length;

  it("단기예보가 01(일시 오류)이면 한 번 더 받아 성공하면 완료", async () => {
    const s = setup();
    sequence(s, { getVilageFcst: [RESULT("01")] });
    expect(await collectWeather(s.deps)).toEqual({
      status: "complete",
      slotId: "202611050915",
    });
    expect(calls(s.urls, "getVilageFcst")).toBe(2);
    expect((await stored(s.state)).short!["93,133"]).toBeDefined();
    expect(s.events().map((e) => e.event)).not.toContain(
      "weather_target_failed",
    );
    expect(
      s.events().find((e) => e.event === "weather_run_finished"),
    ).toMatchObject({ status: "complete", retried: 1, recovered: 1 });
  });

  it("다시 받아도 실패하면 일부 실패로 남기고 실패한 격자를 키 없이 로그에 남김", async () => {
    const s = setup();
    sequence(s, {
      getVilageFcst: [
        RESULT("01", "FIRST_MSG"),
        RESULT("01", `RETRY_MSG serviceKey=${KEY}\n`),
      ],
    });
    expect(await collectWeather(s.deps)).toEqual({
      status: "partial",
      slotId: "202611050915",
      failures: [
        {
          source: "short",
          reason: "result:01",
          code: "01",
          message: "RETRY_MSG serviceKey=***",
        },
      ],
    });
    expect(calls(s.urls, "getVilageFcst")).toBe(2);
    expect((await stored(s.state)).short).toBeNull();
    expect(
      s.events().find((e) => e.event === "weather_target_failed"),
    ).toMatchObject({ source: "short", target: "93,133", reason: "result:01" });
    expect(s.lines.join("\n")).not.toContain(KEY);
  });

  it("실황에 기온(T1H)이 없으면 한 번 더 받음", async () => {
    const s = setup();
    sequence(s, {
      getUltraSrtNcst: [NOW_0900.replaceAll('"T1H"', '"XXX"')],
    });
    expect(await collectWeather(s.deps)).toMatchObject({ status: "complete" });
    expect(calls(s.urls, "getUltraSrtNcst")).toBe(2);
    expect((await stored(s.state)).now!["93,133"]!.temperature).toBe(11.2);
  });

  it("하루 한도(22)·요청 오류(10)·응답이 JSON이 아님은 다시 받지 않음", async () => {
    const s = setup();
    sequence(s, {
      getMidTa: [RESULT("22")],
      getMidLandFcst: [RESULT("10")],
      getVilageFcst: ["<OpenAPI_ServiceResponse/>"],
    });
    const result = await collectWeather(s.deps);
    expect(result).toMatchObject({ status: "partial" });
    expect((result as { failures: readonly unknown[] }).failures).toEqual(
      expect.arrayContaining([
        { source: "mid_ta", reason: "result:22", code: "22" },
        { source: "mid_land", reason: "result:10", code: "10" },
        { source: "short", reason: "not_json" },
      ]),
    );
    expect(calls(s.urls, "getMidTa")).toBe(1);
    expect(calls(s.urls, "getMidLandFcst")).toBe(1);
    expect(calls(s.urls, "getVilageFcst")).toBe(1);
  });

  it("시간 예산이 지났으면 다시 받지 않고 처음 실패 사유로 남김(budget으로 세지 않음)", async () => {
    const s = setup();
    s.deps.get = async (url: string) => {
      s.urls.push(url);
      if (op(url) === "getVilageFcst") {
        s.at("2026-11-05T00:15:40Z"); // 첫 차례 안에서 예산(30초)을 넘김
        return ok(RESULT("01", "FIRST_ERROR"));
      }
      return ok(REAL[op(url)] as string);
    };
    const result = await collectWeather(s.deps);
    expect(calls(s.urls, "getVilageFcst")).toBe(1);
    expect(
      (result as { failures: readonly unknown[] }).failures,
    ).toContainEqual({
      source: "short",
      reason: "result:01",
      code: "01",
      message: "FIRST_ERROR",
    });
    expect(
      s.events().find((e) => e.event === "weather_target_failed"),
    ).toMatchObject({ target: "93,133", reason: "result:01" });
  });

  it("일시 실패가 많으면(기상청 전면 장애) 상한 20곳까지만 다시 받음", async () => {
    const s = setup();
    s.deps.areas = {
      ...AREAS,
      grids: Array.from({ length: 21 }, (_, i) => ({ nx: 93, ny: 133 + i })),
    };
    sequence(s, {
      getUltraSrtNcst: Array.from({ length: 50 }, () => RESULT("01")),
    });
    const result = await collectWeather(s.deps);
    expect(calls(s.urls, "getUltraSrtNcst")).toBe(21 + 20);
    expect(
      (result as { failures: readonly unknown[] }).failures,
    ).toContainEqual({
      source: "now",
      reason: "result:01",
      code: "01",
      count: 21,
    });
    expect(
      s.events().find((e) => e.event === "weather_run_finished"),
    ).toMatchObject({ retried: 20, recovered: 0 });
  });

  const NOW_MISSING = NOW_0900.replace(
    /"category":"T1H",("nx":93,"ny":133,)"obsrValue":"[^"]*"/,
    '"category":"T1H",$1"obsrValue":"-999"',
  );

  it("실황 기온이 기상청 결측(-999)이면 실패로 치지 않고 다시 받지 않으며 곳만 남김", async () => {
    const state = new MemoryStateStore();
    await collectWeather(setup({ state }).deps);
    const s = setup({ state, now: "2026-11-05T01:15:00Z" });
    sequence(s, {
      getUltraSrtNcst: [NOW_MISSING.replaceAll('"0900"', '"1000"')],
    });
    expect(await collectWeather(s.deps)).toMatchObject({ status: "complete" });
    expect(calls(s.urls, "getUltraSrtNcst")).toBe(1);
    // 이전 실황은 덮지 않음(오래되면 publisher가 null로 거름)
    expect((await stored(state)).now!["93,133"]!.observedAt).toBe(
      "2026-11-05T00:00:00Z",
    );
    expect(
      s.events().find((e) => e.event === "weather_now_missing"),
    ).toMatchObject({ target: "93,133" });
    expect(
      s.events().find((e) => e.event === "weather_run_finished"),
    ).toMatchObject({ status: "complete", nowMissing: 1 });
  });

  it("일시 오류로 다시 받은 실황이 결측이어도 실패로 치지 않음", async () => {
    const s = setup();
    sequence(s, { getUltraSrtNcst: [RESULT("01"), NOW_MISSING] });
    expect(await collectWeather(s.deps)).toMatchObject({ status: "complete" });
    expect(calls(s.urls, "getUltraSrtNcst")).toBe(2);
  });

  it("결측 실황 격자가 10곳 이상이면 기상청 쪽 문제로 보고 실패로 남김", async () => {
    const s = setup();
    s.deps.areas = {
      ...AREAS,
      grids: Array.from({ length: 10 }, (_, i) => ({ nx: 93, ny: 133 + i })),
    };
    s.deps.get = async (url: string) => {
      s.urls.push(url);
      const p = new URL(url).searchParams;
      if (op(url) === "getUltraSrtNcst") {
        return ok(NOW_MISSING.replaceAll('"ny":133', `"ny":${p.get("ny")}`));
      }
      return ok(REAL[op(url)] as string);
    };
    const result = await collectWeather(s.deps);
    expect(
      (result as { failures: readonly unknown[] }).failures,
    ).toContainEqual({
      source: "now",
      reason: "t1h_missing",
      count: 10,
    });
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
  it("실제 대응표: 격자 154·육상 구역 8·기온 지점 34", () => {
    const areas = parseWeatherAreas(areasJson);
    expect(areas.grids).toHaveLength(154);
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
