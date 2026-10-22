import { describe, expect, it } from "vitest";
import {
  judgeBeachWarnings,
  type BeachZones,
  type ZoneTables,
} from "./beach-warnings";
import { normalizePwnCdRow, type PwnCdRow } from "./normalize";

// 해변별 특보 상태 검사 (BRD-18, 결정 기록 11장 10/22 ②③④)

// 강문해수욕장(b0001 실제 구역) + 육상 구역이 없는 스쿠버 포인트(가상)
const GANGMUN: BeachZones = {
  id: "b0001",
  warningZones: { sea: "S1151200", land: "L1022510" },
};
const DIVE: BeachZones = { id: "d0001", warningZones: { sea: "S1151200" } };

// 공식 구역표 일부(별표5·별표9)
const ZONES: ZoneTables = {
  sea: { S1151200: "강원중부앞바다", S1151100: "강원북부앞바다" },
  land: { L1022510: "강릉평지" },
};

const NOW = "2026-10-22T01:00:00Z"; // KST 10:00
const CONFIRMED = "2026-10-22T00:48:00Z"; // 12분 전 정상 전체 확인

// getPwnCd 행. 기본값: 2026-10-22 09:00 KST 발표·발효, 주의보
const row = (fields: Partial<PwnCdRow>): PwnCdRow => ({
  tmFc: "202610220900",
  tmSeq: "1",
  areaCode: "S1151200",
  areaName: "강원중부앞바다",
  warnVar: "6",
  warnStress: "0",
  command: "1",
  cancel: "0",
  startTime: "202610220900",
  endTime: "0",
  allEndTime: "0",
  ...fields,
});

const judge = (
  rows: PwnCdRow[],
  options: { lastConfirmedAt?: string | null; beaches?: BeachZones[] } = {},
) =>
  judgeBeachWarnings({
    events: rows.map(normalizePwnCdRow),
    now: NOW,
    lastConfirmedAt:
      options.lastConfirmedAt === undefined
        ? CONFIRMED
        : options.lastConfirmedAt,
    beaches: options.beaches ?? [GANGMUN],
    zones: ZONES,
  });

const windWave = {
  type: "wind_wave",
  level: "advisory",
  zoneCode: "S1151200",
  zoneName: "강원중부앞바다",
  publishedAt: "2026-10-22T00:00:00Z",
  effectiveFrom: "2026-10-22T00:00:00Z",
};

describe("특보 없음 확인", () => {
  it("특보 없음 + 45분 안 확인 → none", () => {
    expect(judge([])).toEqual({
      beaches: {
        b0001: { state: "none", items: [], nearby: [], reasons: [] },
      },
      unknownZones: [],
      unmappedZones: [],
      unknownKinds: [],
    });
  });

  it.each([
    ["2026-10-22T00:14:59Z", "confirmation:expired"], // 45분 01초 지남
    [null, "confirmation:never"],
  ])("확인 시각 %s → unknown (%s)", (lastConfirmedAt, reason) => {
    expect(judge([], { lastConfirmedAt }).beaches.b0001).toEqual({
      state: "unknown",
      items: [],
      nearby: [],
      reasons: [reason],
    });
  });

  it("해변 구역이 구역표에 없음 → 대응 미검증", () => {
    const beach = { id: "b9999", warningZones: { sea: "S1999999" } };
    expect(judge([], { beaches: [beach] }).beaches.b9999).toMatchObject({
      state: "unknown",
      reasons: ["zone_unverified:S1999999"],
    });
  });
});

describe("종류별 연결 (B3)", () => {
  it("풍랑주의보 → 앞바다 구역 해변 active, 구역 이름은 공식표", () => {
    const result = judge([row({ areaName: "강원중부앞바다(응답)" })]);
    expect(result.beaches.b0001).toEqual({
      state: "active",
      items: [windWave],
      nearby: [],
      reasons: [],
    });
  });

  it("확인이 만료돼도 발효 특보는 active 유지, 사유는 남김", () => {
    const result = judge([row({})], { lastConfirmedAt: null });
    expect(result.beaches.b0001).toMatchObject({
      state: "active",
      reasons: ["confirmation:never"],
    });
  });

  it("강풍은 육상 구역만: 육상 L1이면 active", () => {
    const result = judge([
      row({ areaCode: "L1022510", areaName: "강릉평지", warnVar: "1" }),
    ]);
    expect(result.beaches.b0001!.items).toEqual([
      {
        ...windWave,
        type: "strong_wind",
        zoneCode: "L1022510",
        zoneName: "강릉평지",
      },
    ]);
  });

  it("앞바다 구역 코드로 온 강풍은 잇지 않음", () => {
    const result = judge([row({ warnVar: "1" })]);
    expect(result.beaches.b0001!.state).toBe("none");
  });

  it("폭풍해일은 육상 L1로 와도 active (실데이터 사례)", () => {
    const result = judge([
      row({ areaCode: "L1022510", areaName: "강릉평지", warnVar: "5" }),
    ]);
    expect(result.beaches.b0001!.items[0]!.type).toBe("storm_surge");
  });

  it("육상 구역이 없는 스쿠버 포인트는 강풍을 잇지 않음", () => {
    const result = judge(
      [row({ areaCode: "L1022510", areaName: "강릉평지", warnVar: "1" })],
      { beaches: [DIVE] },
    );
    expect(result.beaches.d0001!.state).toBe("none");
  });

  it("호우경보는 주변 특보로만, 분류는 none", () => {
    const result = judge([
      row({
        areaCode: "L1022510",
        areaName: "강릉평지",
        warnVar: "2",
        warnStress: "1",
      }),
    ]);
    expect(result.beaches.b0001).toEqual({
      state: "none",
      items: [],
      nearby: [
        {
          ...windWave,
          type: "heavy_rain",
          level: "warning",
          zoneCode: "L1022510",
          zoneName: "강릉평지",
        },
      ],
      reasons: [],
    });
  });

  it("경보가 주의보보다 앞, 같은 단계는 발표 이른 순", () => {
    const result = judge([
      row({ areaCode: "L1022510", areaName: "강릉평지", warnVar: "1" }),
      row({ warnStress: "1", tmFc: "202610220930", startTime: "202610220930" }),
    ]);
    expect(result.beaches.b0001!.items.map((i) => i.type)).toEqual([
      "wind_wave",
      "strong_wind",
    ]);
  });

  it("발효 예고(발효 전)는 active가 아님", () => {
    const result = judge([row({ startTime: "202610221200" })]);
    expect(result.beaches.b0001!.state).toBe("none");
  });

  it("정정(command 6)처럼 상태를 모르면 그 구역 해변은 unknown", () => {
    const result = judge([row({ command: "6" })]);
    expect(result.beaches.b0001).toMatchObject({
      state: "unknown",
      reasons: ["S1151200:command:6"],
    });
  });

  it("모르는 종류(warnVar)가 해변 구역에 오면 unknown", () => {
    const result = judge([row({ warnVar: "99" })]);
    expect(result.beaches.b0001).toMatchObject({
      state: "unknown",
      reasons: ["S1151200:warnVar:99"],
    });
  });

  it("모르는 종류(warnVar)가 해변 없는 구역에 와도 unknownKinds에 기록", () => {
    const result = judge([
      row({ areaCode: "L1022420", areaName: "평창군산지", warnVar: "99" }),
    ]);
    expect(result.unknownKinds).toEqual(["99"]);
  });
});

describe("해변과 이을 수 없는 구역 (③)", () => {
  it("표에 없는 S1 · 먼바다 → 기록만", () => {
    const result = judge([
      row({ areaCode: "S1152010", areaName: "동해중부안쪽먼바다" }),
    ]);
    expect(result.beaches.b0001!.state).toBe("none");
    expect(result.unmappedZones).toEqual([
      { code: "S1152010", scope: "sea", name: "동해중부안쪽먼바다" },
    ]);
  });

  it("표에 없는 S1 · 먼바다 아님 · 풍랑 발효 → 전국 unknown", () => {
    const result = judge(
      [row({ areaCode: "S1151900", areaName: "강원새앞바다" })],
      { beaches: [GANGMUN, DIVE] },
    );
    expect(result.beaches.b0001!.reasons).toEqual(["unmapped:S1151900"]);
    expect(result.beaches.d0001!.reasons).toEqual(["unmapped:S1151900"]);
  });

  it.each([
    ["발효 예고", { startTime: "202610221200" }],
    ["앞바다에 잇지 않는 강풍", { warnVar: "1" }],
  ])("표에 없는 S1 · 먼바다 아님 · %s → 기록만", (_, fields) => {
    const result = judge([
      row({ areaCode: "S1151900", areaName: "강원새앞바다", ...fields }),
    ]);
    expect(result.beaches.b0001!.state).toBe("none");
    expect(result.unmappedZones.map((z) => z.code)).toEqual(["S1151900"]);
  });

  it("표에 없는 S1 · 먼바다 아님 · 이미 해제 → 기록만", () => {
    const result = judge([
      row({ areaCode: "S1151900", areaName: "강원새앞바다" }),
      row({
        areaCode: "S1151900",
        areaName: "강원새앞바다",
        tmFc: "202610220930",
        tmSeq: "2",
        command: "2",
        startTime: "0",
        endTime: "202610220930",
      }),
    ]);
    expect(result.beaches.b0001!.state).toBe("none");
    expect(result.unmappedZones.map((z) => z.code)).toEqual(["S1151900"]);
  });

  it("표에 없는 L1 · 강풍 → 기록만", () => {
    const result = judge([
      row({ areaCode: "L1022420", areaName: "평창군산지", warnVar: "1" }),
    ]);
    expect(result.beaches.b0001!.state).toBe("none");
    expect(result.unmappedZones).toEqual([
      { code: "L1022420", scope: "land", name: "평창군산지" },
    ]);
  });

  it("S1·L1 형식이 아닌 코드 · 풍랑 → 전국 unknown + unknownZones", () => {
    const result = judge([row({ areaCode: "S2120500" })]);
    expect(result.beaches.b0001).toMatchObject({
      state: "unknown",
      reasons: ["zone:S2120500"],
    });
    expect(result.unknownZones).toEqual(["S2120500"]);
  });

  it("S1·L1 형식이 아닌 코드 · 호우 → 기록만", () => {
    const result = judge([row({ areaCode: "S2120500", warnVar: "2" })]);
    expect(result.beaches.b0001!.state).toBe("none");
    expect(result.unknownZones).toEqual(["S2120500"]);
  });

  it("전국 사유가 있어도 발효 특보 해변은 active", () => {
    const result = judge([row({}), row({ areaCode: "S2120500" })]);
    expect(result.beaches.b0001).toMatchObject({
      state: "active",
      reasons: ["zone:S2120500"],
    });
  });
});
