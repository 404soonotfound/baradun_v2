import type {
  MidLandForecast,
  MidTaForecast,
  WeatherPoint,
  WeatherShort,
} from "@baradun/contracts";
import { describe, expect, it } from "vitest";

import {
  hourCells,
  laterDays,
  midIssuedAt,
  monthDay,
  skyIcon,
  skyWord,
} from "./weather";

// 상세 날씨 카드 모델 (BRD-185). 시각은 모두 UTC로 쓰고 한국 시각(+9)으로 나눔
const NOW = Date.parse("2026-11-05T05:00:00Z"); // KST 11/5(목) 14:00

const point = (
  at: string,
  extra: Partial<WeatherPoint> = {},
): WeatherPoint => ({
  at,
  sky: "clear",
  precip: "none",
  temperature: 15,
  pop: 0,
  windFrom: 0,
  windSpeed: 3,
  ...extra,
});

describe("skyWord·skyIcon", () => {
  it("강수가 있으면 강수, 없으면 하늘. 밤에는 해 대신 달", () => {
    expect(skyWord("clear", "rain")).toBe("rain");
    expect(skyWord("mostlyCloudy", "none")).toBe("mostlyCloudy");
    expect(skyIcon("clear", true)).toBe("moon");
    expect(skyIcon("mostlyCloudy", false)).toBe("cloudSun");
  });

  it("값 없음·모르는 값은 맑음으로 그리지 않음", () => {
    expect(skyWord(null, "none")).toBeNull();
    expect(skyWord("sunny", "none")).toBeNull();
    // 강수 값을 모르면 하늘로 대신하지 않음(비가 오는데 맑음으로 보일 수 있음)
    expect(skyWord("clear", "hail")).toBeNull();
    expect(skyIcon(null, false)).toBe("unknown");
  });
});

describe("hourCells", () => {
  const points = [
    point("2026-11-05T03:00:00Z"), // KST 12시: 지난 칸
    point("2026-11-05T06:00:00Z"), // KST 15시
    point("2026-11-05T15:00:00Z", { windFrom: 270, temperature: null }), // KST 11/6 0시
    point("2026-11-07T12:00:00Z"), // KST 11/7 21시(모레)
    point("2026-11-07T15:00:00Z"), // KST 11/8 0시(글피): 시간 줄 밖
  ];

  it("지금 다음 칸부터 모레까지, 날이 시작되는 칸 표시", () => {
    const cells = hourCells(points, NOW);
    expect(cells.map((c) => [c.day, c.hour, c.dayStart])).toEqual([
      [0, 15, true],
      [1, 0, true],
      [2, 21, true],
    ]);
    expect(cells[1]!.date).toBe("2026-11-06");
  });

  it("풍향은 불어가는 쪽으로 180° 돌림, 값 없음은 null 그대로", () => {
    const cells = hourCells(points, NOW);
    expect(cells[0]!.windTo).toBe(180);
    expect(cells[1]!.windTo).toBe(90);
    expect(cells[1]!.temperature).toBeNull();
  });
});

describe("laterDays", () => {
  const short: WeatherShort = {
    issuedAt: "2026-11-05T02:00:00Z",
    points: [],
    days: [
      {
        date: "2026-11-08",
        pop: 30,
        popAt: "2026-11-08T06:00:00Z",
        sky: "cloudy",
        precip: "none",
        min: 6,
        max: 13,
      },
    ],
  };
  const land: MidLandForecast = {
    name: "강원영동",
    days: ["2026-11-09", "2026-11-10", "2026-11-11"].map((date, i) => ({
      date,
      issuedAt: "2026-11-04T21:00:00Z",
      pop: [10, 0, null][i] ?? null,
      sky: i === 2 ? null : "clear",
      precip: i === 2 ? null : "none",
    })),
  };
  const ta: MidTaForecast = {
    name: "강릉",
    days: [
      { date: "2026-11-09", issuedAt: "2026-11-04T21:00:00Z", min: 7, max: 15 },
    ],
  };

  it("글피(단기) + 중기 3일, 기온 지점 값을 날짜로 붙임", () => {
    const { days, midFailed } = laterDays(short, land, ta, NOW);
    expect(midFailed).toBe(false);
    expect(days.map((d) => [d.date, d.source, d.min, d.max])).toEqual([
      ["2026-11-08", "short", 6, 13],
      ["2026-11-09", "mid", 7, 15],
      ["2026-11-10", "mid", null, null],
      ["2026-11-11", "mid", null, null],
    ]);
    // 받지 못한 칸은 null(0·맑음 아님)
    expect(days[3]!.pop).toBeNull();
    expect(days[3]!.icon).toBe("unknown");
  });

  it("중기 구역·기온 지점이 없거나 받은 값이 하나도 없으면 중기만 실패", () => {
    expect(laterDays(short, land, null, NOW).midFailed).toBe(true);
    expect(laterDays(short, null, null, NOW)).toMatchObject({
      midFailed: true,
      days: [{ date: "2026-11-08" }],
    });
    const empty: MidLandForecast = {
      ...land,
      days: land.days.map((d) => ({
        ...d,
        pop: null,
        sky: null,
        precip: null,
      })),
    };
    expect(laterDays(short, empty, null, NOW).midFailed).toBe(true);
  });

  it("글피 칸이 없을 때(KST 00:00~02:10)는 중기 3일만", () => {
    const { days } = laterDays({ ...short, days: [] }, land, ta, NOW);
    expect(days.map((d) => d.source)).toEqual(["mid", "mid", "mid"]);
  });
});

describe("midIssuedAt·monthDay", () => {
  it("가장 늦은 중기 발표 시각, 날짜는 앞 0 없이", () => {
    expect(
      midIssuedAt({
        name: "x",
        days: [
          {
            date: "2026-11-09",
            issuedAt: "2026-11-04T09:00:00Z",
            pop: 1,
            sky: null,
            precip: null,
          },
          {
            date: "2026-11-10",
            issuedAt: "2026-11-04T21:00:00Z",
            pop: 1,
            sky: null,
            precip: null,
          },
          {
            date: "2026-11-11",
            issuedAt: null,
            pop: null,
            sky: null,
            precip: null,
          },
        ],
      }),
    ).toBe("2026-11-04T21:00:00Z");
    expect(midIssuedAt(null)).toBeNull();
    expect(monthDay("2026-11-07")).toBe("11/7");
  });
});
