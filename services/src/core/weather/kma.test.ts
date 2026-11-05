import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addDays,
  HOUR_FIELDS,
  kstDate,
  kstToMs,
  parseEnvelope,
  parseMidLand,
  parseMidTa,
  parseNow,
  parseShortForecast,
} from "./kma";

// 기상청 날씨 응답 해석 (BRD-181). 픽스처는 2026-11-04·05 실응답(경포 격자 93,133 · 강원영동 · 강릉)
// 단기예보 픽스처는 쓰는 항목·3시간 간격 행만 남기고 totalCount를 맞춤(fixtures/README.md)

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const GRID = { nx: 93, ny: 133 };
const BASE = { date: "20261105", time: "0200" };

const envelope = (items: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL_SERVICE" },
      body: { items: { item: items }, totalCount: items.length, ...extra },
    },
  });

describe("시각", () => {
  it("KST 날짜·시각 → UTC, 달력에 없는 날은 null", () => {
    expect(kstToMs("20261105", "0200")).toBe(
      Date.parse("2026-11-04T17:00:00Z"),
    );
    expect(kstToMs("20261131", "0000")).toBeNull();
    expect(kstToMs("20261105", "2400")).toBeNull();
    expect(kstDate(Date.parse("2026-11-04T15:00:00Z"))).toBe("2026-11-05");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
  });
});

describe("응답 껍데기", () => {
  it("resultCode가 00이 아니거나 JSON이 아니면 실패(키 오류는 XML로 옴)", () => {
    expect(parseEnvelope("<OpenAPI_ServiceResponse/>")).toEqual({
      status: "failed",
      reason: "not_json",
    });
    expect(
      parseEnvelope(
        JSON.stringify({ response: { header: { resultCode: "03" } } }),
      ),
    ).toEqual({ status: "failed", reason: "result:03" });
  });

  it("행이 없거나 totalCount보다 적게 받으면 실패(빈 배열을 정상으로 읽지 않음)", () => {
    expect(parseEnvelope(envelope([]))).toEqual({
      status: "failed",
      reason: "no_rows",
    });
    expect(parseEnvelope(envelope([{}], { totalCount: 5 }))).toEqual({
      status: "failed",
      reason: "truncated:1/5",
    });
  });
});

describe("단기예보", () => {
  const parsed = parseShortForecast(
    fixture("vilage-93-133-202611050200.json"),
    BASE,
    GRID,
  );

  it("시간별 값과 날짜별 최저·최고를 발표 시각과 함께 읽음", () => {
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(parsed.value.issuedAt).toBe("2026-11-04T17:00:00Z");
    // 첫 칸: 11/5 03:00 KST
    const first = parsed.value.hours[0]!;
    expect(first[0]).toBe(Date.parse("2026-11-04T18:00:00Z") / 1000);
    expect(first.length).toBe(HOUR_FIELDS.length + 1);
    expect(parsed.value.extremes["2026-11-05"]).toEqual({
      tmn: { v: 11, issuedAt: "2026-11-04T17:00:00Z" },
      tmx: { v: 16, issuedAt: "2026-11-04T17:00:00Z" },
    });
    expect(Object.keys(parsed.value.extremes)).toEqual([
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
      "2026-11-08",
    ]);
  });

  it("파고 예보(WAV)는 받지 않음(D18-8 ④)", () => {
    expect(HOUR_FIELDS).not.toContain("WAV");
  });

  it("범위 밖·결측 표기 값은 null(0·맑음으로 채우지 않음)", () => {
    const row = (category: string, fcstValue: string) => ({
      baseDate: "20261105",
      baseTime: "0200",
      category,
      fcstDate: "20261105",
      fcstTime: "0300",
      fcstValue,
      nx: 93,
      ny: 133,
    });
    const result = parseShortForecast(
      envelope([
        row("TMP", "-999"),
        row("SKY", "2"),
        row("PTY", "9"),
        row("POP", "150"),
        row("VEC", "400"),
        row("WSD", "-1"),
      ]),
      BASE,
      GRID,
    );
    expect(result).toEqual({
      status: "ok",
      value: {
        issuedAt: "2026-11-04T17:00:00Z",
        hours: [
          [
            Date.parse("2026-11-04T18:00:00Z") / 1000,
            null,
            null,
            null,
            null,
            null,
            null,
          ],
        ],
        extremes: {},
      },
    });
  });

  it("요청과 다른 발표 시각·격자 응답은 실패(다른 곳 값을 쓰지 않음)", () => {
    expect(
      parseShortForecast(
        fixture("vilage-93-133-202611050200.json"),
        { date: "20261105", time: "0500" },
        GRID,
      ),
    ).toEqual({ status: "failed", reason: "base_mismatch" });
    expect(
      parseShortForecast(fixture("vilage-93-133-202611050200.json"), BASE, {
        nx: 93,
        ny: 132,
      }),
    ).toEqual({ status: "failed", reason: "grid_mismatch" });
  });
});

describe("초단기실황", () => {
  const base = { date: "20261105", time: "0900" };

  it("기온(T1H)과 실황 기준 시각", () => {
    expect(parseNow(fixture("ncst-20261105-0900.json"), base, GRID)).toEqual({
      status: "ok",
      value: { observedAt: "2026-11-05T00:00:00Z", temperature: 11.2 },
    });
  });

  it("기온이 없으면 실패(다른 항목만 있는 응답)", () => {
    const body = envelope([
      {
        baseDate: "20261105",
        baseTime: "0900",
        category: "REH",
        nx: 93,
        ny: 133,
        obsrValue: "94",
      },
    ]);
    expect(parseNow(body, base, GRID)).toEqual({
      status: "failed",
      reason: "no_t1h",
    });
  });
});

describe("중기예보", () => {
  it("06:00 발표: 4~7일 오전·오후, 8~10일 하루 값", () => {
    const result = parseMidLand(
      fixture("midland-202611050600.json"),
      "11D20000",
      "202611050600",
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const days = result.value;
    expect(Object.keys(days)[0]).toBe("2026-11-09");
    expect(days["2026-11-09"]).toMatchObject({
      issuedAt: "2026-11-04T21:00:00Z",
    });
    expect(days["2026-11-09"]!.am).toBeDefined();
    expect(days["2026-11-13"]!.all).toBeDefined();
    expect(days["2026-11-13"]!.am).toBeUndefined();
  });

  it("18:00 발표는 4일 칸이 없음 → 그 날짜를 넣지 않음(빈 값으로 채우지 않음)", () => {
    const result = parseMidLand(
      fixture("midland-202611041800.json"),
      "11D20000",
      "202611041800",
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value["2026-11-08"]).toBeUndefined();
    expect(result.value["2026-11-09"]).toEqual({
      issuedAt: "2026-11-04T09:00:00Z",
      am: { pop: 20, wf: "구름많음" },
      pm: { pop: 10, wf: "맑음" },
    });
  });

  it("기온 지점: 날짜별 최저·최고", () => {
    const result = parseMidTa(
      fixture("midta-202611041800.json"),
      "11D20501",
      "202611041800",
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value["2026-11-09"]).toEqual({
      issuedAt: "2026-11-04T09:00:00Z",
      min: 6,
      max: 12,
    });
    expect(result.value["2026-11-08"]).toBeUndefined();
  });

  it("다른 구역 응답은 실패", () => {
    expect(
      parseMidTa(
        fixture("midta-202611041800.json"),
        "11D20401",
        "202611041800",
      ),
    ).toEqual({ status: "failed", reason: "region_mismatch" });
  });
});
