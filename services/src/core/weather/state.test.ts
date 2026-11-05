import { describe, expect, it } from "vitest";
import type { ShortForecast } from "./kma";
import {
  latestIssue,
  mergeMid,
  mergeNow,
  mergeShort,
  packShort,
  readShort,
  type ShortGrids,
} from "./state";

// 날씨 저장 합치기 (BRD-181). 실패한 곳은 이전 값 유지, 이른 발표가 늦은 발표를 덮지 않음

const T02 = "2026-11-04T17:00:00Z"; // KST 11/5 02:00
const T05 = "2026-11-04T20:00:00Z"; // KST 11/5 05:00
const T23 = "2026-11-04T14:00:00Z"; // KST 11/4 23:00
const KEY = "93,133";

const forecast = (
  issuedAt: string,
  extremes: ShortForecast["extremes"] = {},
): ShortForecast => ({
  issuedAt,
  hours: [[Date.parse(issuedAt) / 1000 + 3600, 12, 1, 0, 0, 270, 2]],
  extremes,
});

describe("단기예보 합치기", () => {
  it("받지 못한 격자는 이전 값을 유지하고, 대응표에 없는 격자는 버림", () => {
    const prev: ShortGrids = {
      [KEY]: forecast(T02),
      "1,1": forecast(T02),
    };
    const merged = mergeShort(prev, new Map(), new Set([KEY]), "2026-11-05");
    expect(Object.keys(merged)).toEqual([KEY]);
    expect(merged[KEY]!.issuedAt).toBe(T02);
  });

  it("더 이른 발표는 시간별 값을 덮지 않음", () => {
    const merged = mergeShort(
      { [KEY]: forecast(T05) },
      new Map([[KEY, forecast(T02)]]),
      new Set([KEY]),
      "2026-11-05",
    );
    expect(merged[KEY]!.issuedAt).toBe(T05);
  });

  it("오늘 최저는 02:00 발표 값을 보관해 05:00 발표(오늘 최저 없음) 뒤에도 남김(D18-8 ②)", () => {
    const after02 = mergeShort(
      {},
      new Map([
        [
          KEY,
          forecast(T02, {
            "2026-11-05": {
              tmn: { v: 11, issuedAt: T02 },
              tmx: { v: 16, issuedAt: T02 },
            },
          }),
        ],
      ]),
      new Set([KEY]),
      "2026-11-05",
    );
    const after05 = mergeShort(
      after02,
      new Map([
        [
          KEY,
          forecast(T05, {
            "2026-11-05": { tmx: { v: 17, issuedAt: T05 } },
          }),
        ],
      ]),
      new Set([KEY]),
      "2026-11-05",
    );
    expect(after05[KEY]!.extremes["2026-11-05"]).toEqual({
      tmn: { v: 11, issuedAt: T02 },
      tmx: { v: 17, issuedAt: T05 },
    });
  });

  it("전날 23:00 발표의 오늘 값은 02:00 발표가 오면 바뀌고, 지난 날짜는 버림", () => {
    const merged = mergeShort(
      {
        [KEY]: forecast(T23, {
          "2026-11-04": { tmn: { v: 9, issuedAt: T23 } },
          "2026-11-05": { tmn: { v: 10, issuedAt: T23 } },
        }),
      },
      new Map([
        [
          KEY,
          forecast(T02, { "2026-11-05": { tmn: { v: 11, issuedAt: T02 } } }),
        ],
      ]),
      new Set([KEY]),
      "2026-11-05",
    );
    expect(merged[KEY]!.extremes).toEqual({
      "2026-11-05": { tmn: { v: 11, issuedAt: T02 } },
    });
  });

  it("압축 저장 → 읽기가 같고, 깨진 기록은 null(빈 값으로 바꾸지 않음)", () => {
    const grids = { [KEY]: forecast(T02) };
    const packed = packShort(grids);
    expect(packed.status).toBe("ok");
    if (packed.status !== "ok") return;
    expect(readShort({ archive: packed.archive })).toEqual(grids);
    expect(readShort({ archive: "깨짐" })).toBeNull();
    expect(readShort(null)).toBeNull();
  });
});

describe("지금 기온 합치기", () => {
  it("더 늦은 실황만 덮고, 받지 못한 격자는 이전 값", () => {
    const prev = {
      [KEY]: { observedAt: "2026-11-05T01:00:00Z", temperature: 12 },
    };
    expect(
      mergeNow(
        prev,
        new Map([
          [KEY, { observedAt: "2026-11-05T00:00:00Z", temperature: 9 }],
        ]),
        new Set([KEY]),
      ),
    ).toEqual(prev);
  });
});

describe("중기예보 합치기", () => {
  it("18:00 발표에 없는 4일째는 06:00 발표 값을 이어 씀", () => {
    const am06 = "2026-11-04T21:00:00Z";
    const pm18 = "2026-11-05T09:00:00Z";
    const merged = mergeMid(
      {
        land: {
          "11D20000": {
            "2026-11-09": { issuedAt: am06, am: { pop: 20, wf: "맑음" } },
            "2026-11-10": { issuedAt: am06, am: { pop: 10, wf: "맑음" } },
          },
        },
        ta: {},
      },
      {
        land: new Map([
          [
            "11D20000",
            { "2026-11-10": { issuedAt: pm18, am: { pop: 30, wf: "흐림" } } },
          ],
        ]),
        ta: new Map(),
      },
      { land: new Set(["11D20000"]), ta: new Set() },
      "2026-11-05",
    );
    expect(merged.land["11D20000"]).toEqual({
      "2026-11-09": { issuedAt: am06, am: { pop: 20, wf: "맑음" } },
      "2026-11-10": { issuedAt: pm18, am: { pop: 30, wf: "흐림" } },
    });
    expect(latestIssue(merged.land["11D20000"])).toBe(Date.parse(pm18));
  });
});
