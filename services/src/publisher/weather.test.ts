import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseShortForecast } from "../core/weather/kma";
import type { WeatherInputs } from "./weather";
import { BEACHES, WEATHER_AREAS } from "./fixtures";
import { buildWeather, parseWeatherAreaTable, parseWf } from "./weather";
import { contractErrors } from "./validate";

// weather.json 만들기 (BRD-181, D18-2·D18-8·D18-9). 실응답 픽스처(경포 격자 93,133, 11/5 02:00 발표)

const fixture = readFileSync(
  new URL(
    "../core/weather/fixtures/vilage-93-133-202611050200.json",
    import.meta.url,
  ),
  "utf8",
);
const parsed = parseShortForecast(
  fixture,
  { date: "20261105", time: "0200" },
  { nx: 93, ny: 133 },
);
if (parsed.status !== "ok") throw new Error("픽스처 해석 실패");
const KEY = WEATHER_AREAS.beaches.b0002!.grid;
const LAND = WEATHER_AREAS.beaches.b0002!.midLand;
const TA = WEATHER_AREAS.beaches.b0002!.midTa;
const AM06 = "2026-11-04T21:00:00Z"; // 11/5 06:00 KST 중기 발표

const inputs = (over: Partial<WeatherInputs> = {}): WeatherInputs => ({
  short: { [KEY]: parsed.value },
  now: { [KEY]: { observedAt: "2026-11-05T00:00:00Z", temperature: 11.2 } },
  mid: {
    land: {
      [LAND]: {
        "2026-11-09": {
          issuedAt: AM06,
          am: { pop: 20, wf: "구름많음" },
          pm: { pop: 20, wf: "흐리고 비" },
        },
        "2026-11-10": {
          issuedAt: AM06,
          am: { pop: 10, wf: "맑음" },
          pm: { pop: 30, wf: "흐리고 비/눈" },
        },
        "2026-11-11": {
          issuedAt: AM06,
          am: { pop: 10, wf: "해무" },
          pm: { pop: null, wf: "맑음" },
        },
      },
    },
    ta: {
      [TA]: { "2026-11-09": { issuedAt: AM06, min: 6, max: 12 } },
    },
  },
  ...over,
});
const NOW = Date.parse("2026-11-05T00:30:00Z"); // KST 11/5 09:30
const noLog = () => {};

describe("buildWeather", () => {
  const file = buildWeather(WEATHER_AREAS, BEACHES, inputs(), NOW, noLog);
  const grid = file.grids[KEY]!;

  it("계약을 통과함", () => {
    expect(contractErrors("WeatherFile", file)).toEqual([]);
  });

  it("오늘~모레 3시간 간격 점만 실음(KST 00·03·…·21시)", () => {
    const hours = grid.short!.points.map((p) =>
      new Date(Date.parse(p.at) + 9 * 3600_000).getUTCHours(),
    );
    expect(hours.every((h) => h % 3 === 0)).toBe(true);
    expect(grid.short!.points[0]!.at).toBe("2026-11-04T18:00:00Z"); // 11/5 03:00
    expect(grid.short!.points.at(-1)!.at).toBe("2026-11-07T12:00:00Z"); // 11/7 21:00
    expect(grid.short!.points.length).toBeLessThanOrEqual(24);
  });

  it("글피 하루 한 칸: 가장 높은 강수확률과 그 시각의 하늘, 같으면 이른 시각(D18-9)", () => {
    expect(grid.short!.days).toEqual([
      {
        date: "2026-11-08",
        pop: 30,
        popAt: "2026-11-08T00:00:00Z", // 11/8 09:00 KST(30%가 처음 나온 칸)
        sky: "cloudy",
        precip: "none",
        min: 4,
        max: 12,
      },
    ]);
  });

  it("오늘 최저·최고는 TMN·TMX와 그 발표 시각(시간별 기온으로 대신하지 않음)", () => {
    expect(grid.today).toEqual({
      date: "2026-11-05",
      min: 11,
      minIssuedAt: "2026-11-04T17:00:00Z",
      max: 16,
      maxIssuedAt: "2026-11-04T17:00:00Z",
    });
  });

  it("지금 기온은 초단기실황 값과 기준 시각", () => {
    expect(grid.now).toEqual({
      observedAt: "2026-11-05T00:00:00Z",
      temperature: 11.2,
    });
  });

  it("중기 하루 한 칸: 오전·오후 중 높은 강수확률(같으면 오전), 모르는 하늘 글자는 null", () => {
    expect(file.midLand[LAND]).toEqual({
      name: "강원영동",
      days: [
        {
          date: "2026-11-09",
          issuedAt: AM06,
          pop: 20,
          sky: "mostlyCloudy",
          precip: "none",
        },
        {
          date: "2026-11-10",
          issuedAt: AM06,
          pop: 30,
          sky: "cloudy",
          precip: "rainSnow",
        },
        {
          date: "2026-11-11",
          issuedAt: AM06,
          pop: 10,
          sky: null,
          precip: null,
        },
      ],
    });
    expect(file.midTa[TA]!.days).toEqual([
      { date: "2026-11-09", issuedAt: AM06, min: 6, max: 12 },
      { date: "2026-11-10", issuedAt: null, min: null, max: null },
      { date: "2026-11-11", issuedAt: null, min: null, max: null },
    ]);
  });

  it("숨긴 해변은 넣지 않음", () => {
    expect(file.beaches.b0003).toBeUndefined();
    expect(file.beaches.b0002).toEqual(WEATHER_AREAS.beaches.b0002);
  });
});

describe("오래된 값은 null(2026-11-05 사용자 결정: 단기 12시간·중기 24시간·실황 2시간)", () => {
  it("발표 12시간 뒤 단기예보, 기준 시각 2시간 뒤 실황은 null. 오늘 최저·최고는 그날 내내 유지", () => {
    const later = Date.parse("2026-11-05T05:01:00Z"); // 02:00 발표 + 12시간 1분
    const grid = buildWeather(WEATHER_AREAS, BEACHES, inputs(), later, noLog)
      .grids[KEY]!;
    expect(grid.short).toBeNull();
    expect(grid.now).toBeNull();
    expect(grid.today.min).toBe(11);
  });

  it("발표 24시간이 지난 중기 값은 날짜만 두고 모두 null", () => {
    const later = Date.parse("2026-11-05T21:01:00Z");
    const file = buildWeather(WEATHER_AREAS, BEACHES, inputs(), later, noLog);
    // KST 11/6 → 4~6일 = 11/10~11/12
    expect(file.midLand[LAND]!.days[0]).toEqual({
      date: "2026-11-10",
      issuedAt: null,
      pop: null,
      sky: null,
      precip: null,
    });
  });

  it("받은 값이 하나도 없으면 칸은 두고 값은 null(0·맑음으로 채우지 않음)", () => {
    const file = buildWeather(
      WEATHER_AREAS,
      BEACHES,
      { short: {}, now: {}, mid: { land: {}, ta: {} } },
      NOW,
      noLog,
    );
    expect(contractErrors("WeatherFile", file)).toEqual([]);
    expect(file.grids[KEY]).toEqual({
      short: null,
      today: {
        date: "2026-11-05",
        min: null,
        minIssuedAt: null,
        max: null,
        maxIssuedAt: null,
      },
      now: null,
    });
  });
});

describe("글피 하루 한 칸은 그날을 다 담은 발표에서만", () => {
  it("발표가 글피의 00시만 담으면(KST 00:00~02:10, 전날 23:00 발표) 칸을 두지 않음", () => {
    // 픽스처(11/5 02:00 발표)는 11/9 00시 한 칸까지 담음. KST 11/6 00:30에는 글피 = 11/9
    const at = Date.parse("2026-11-05T15:30:00Z");
    // 발표 시각만 11/5 23:00으로 바꿔 12시간 안에 둠(값은 그대로)
    const late = {
      [KEY]: { ...parsed.value, issuedAt: "2026-11-05T14:00:00Z" },
    };
    const grid = buildWeather(
      WEATHER_AREAS,
      BEACHES,
      inputs({ short: late }),
      at,
      noLog,
    ).grids[KEY]!;
    expect(grid.short!.days).toEqual([]);
    // 오늘~모레 점은 그대로
    expect(grid.short!.points.length).toBeGreaterThan(0);
  });
});

describe("구역표 읽기", () => {
  it("계약 모양이 아닌 해변만 빼고 알림(나머지 해변의 날씨는 게시)", () => {
    const events: string[] = [];
    const table = parseWeatherAreaTable(
      {
        beaches: {
          b0001: {
            grid: { nx: 93, ny: 133 },
            midLand: { regId: "11D20000", name: "강원영동" },
            midTa: { regId: "11D20501", name: "강릉" },
          },
          b0002: {
            grid: { nx: 93, ny: 133 },
            midLand: { regId: "11D20000", name: "강원영동" },
            midTa: { regId: "x", name: "강릉" },
          },
        },
      },
      (_level, event) => events.push(event),
    );
    expect(Object.keys(table.beaches)).toEqual(["b0001"]);
    expect(events).toEqual(["weather_areas_invalid"]);
  });
});

describe("중기 하늘 글자", () => {
  it("활용가이드 표기를 하늘·강수 형태로 나눔", () => {
    expect(parseWf("맑음")).toEqual({ sky: "clear", precip: "none" });
    expect(parseWf("구름많고 소나기")).toEqual({
      sky: "mostlyCloudy",
      precip: "shower",
    });
    expect(parseWf("흐리고 눈")).toEqual({ sky: "cloudy", precip: "snow" });
  });

  it("모르는 글자·뒤가 빠진 글자는 null", () => {
    expect(parseWf("흐리고")).toBeNull();
    expect(parseWf("맑음 비")).toBeNull();
    expect(parseWf("황사")).toBeNull();
  });
});
