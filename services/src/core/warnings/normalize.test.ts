import { describe, expect, it } from "vitest";
import data from "./fixtures/pwncd-events.json";
import { normalizePwnCdRow, parseZone, type PwnCdRow } from "./normalize";

// getPwnCd 행 정규화 검사 (BRD-54 5단계). 입력: BRD-16 픽스처 cases 전부

const sea = (code: string) => ({ kind: "code", code, scope: "sea" });
const land = (code: string) => ({ kind: "code", code, scope: "land" });
const judged = (type: string) => ({ group: "judged", type });

// 픽스처 id → 기대 결과. 시각은 KST에서 9시간 뺀 UTC
const EXPECTED: Record<string, object> = {
  "issue-wind-wave-S1": {
    publishedAt: "2026-10-13T15:00:00Z",
    seq: 39,
    action: "issue",
    cancelled: false,
    kind: judged("wind_wave"),
    level: "advisory",
    zone: sea("S1152010"),
    effectiveFrom: "2026-10-13T17:00:00Z",
    unknownReasons: [],
  },
  "change-to-warning": {
    publishedAt: "2026-10-13T22:00:00Z",
    seq: 46,
    action: "change_issue",
    level: "warning",
    effectiveFrom: "2026-10-14T00:00:00Z",
    unknownReasons: [],
  },
  "change-to-advisory": {
    publishedAt: "2026-10-14T04:00:00Z",
    seq: 52,
    action: "change_issue",
    level: "advisory",
    effectiveFrom: "2026-10-14T05:00:00Z",
    unknownReasons: [],
  },
  // endTime → 해제 발효 시각. allEndTime은 해석하지 않고 raw에만 둠
  "release-scheduled-with-allEndTime": {
    publishedAt: "2026-10-14T16:00:00Z",
    seq: 58,
    action: "release",
    effectiveFrom: "2026-10-14T18:00:00Z",
    unknownReasons: [],
  },
  "release-scheduled-no-allEndTime": {
    publishedAt: "2026-10-14T05:00:00Z",
    action: "release",
    zone: sea("S1323400"),
    effectiveFrom: "2026-10-14T06:00:00Z",
    unknownReasons: [],
  },
  "release-immediate-land": {
    publishedAt: "2026-10-15T08:00:00Z",
    action: "release",
    kind: judged("strong_wind"),
    zone: land("L1014200"),
    effectiveFrom: "2026-10-15T08:00:00Z",
    unknownReasons: [],
  },
  "issue-strong-wind-L1": {
    publishedAt: "2026-10-14T21:30:00Z",
    action: "issue",
    kind: judged("strong_wind"),
    zone: land("L1014200"),
    effectiveFrom: "2026-10-14T21:30:00Z",
    unknownReasons: [],
  },
  extend: {
    publishedAt: "2026-09-09T13:00:00Z",
    seq: 64,
    action: "extend",
    zone: sea("S1232220"),
    effectiveFrom: "2026-09-09T13:00:00Z",
    unknownReasons: [],
  },
  "issue-storm-surge-L1": {
    publishedAt: "2026-09-09T13:15:00Z",
    action: "issue",
    kind: judged("storm_surge"),
    zone: land("L1091000"),
    effectiveFrom: "2026-09-09T13:15:00Z",
    unknownReasons: [],
  },
  "release-storm-surge-L1": {
    publishedAt: "2026-09-09T14:30:00Z",
    action: "release",
    kind: judged("storm_surge"),
    effectiveFrom: "2026-09-09T14:30:00Z",
    unknownReasons: [],
  },
  "issue-future-start": {
    publishedAt: "2026-08-31T07:00:00Z",
    seq: 452,
    action: "issue",
    kind: { group: "nearby", type: "tropical_night" },
    zone: land("L1053010"),
    effectiveFrom: "2026-08-31T09:00:00Z",
    unknownReasons: [],
  },
  "issue-other-type-L1": {
    publishedAt: "2026-10-13T02:40:00Z",
    kind: { group: "nearby", type: "heavy_rain" },
    zone: land("L1080600"),
    unknownReasons: [],
  },
  // 정정·변경해제·취소는 정규화 단계에선 알려진 코드 → 사유 없음. unknown은 구역 상태 단계에서 정함
  correction: {
    publishedAt: "2026-10-13T15:30:00Z",
    seq: 40,
    action: "correct",
    effectiveFrom: null,
    unknownReasons: [],
  },
  "change-release": {
    seq: 49,
    action: "change_release",
    effectiveFrom: "2026-10-14T03:00:00Z",
    unknownReasons: [],
  },
  cancelled: {
    publishedAt: "2026-10-13T15:10:00Z",
    action: "issue",
    cancelled: true,
    unknownReasons: [],
  },
  "unknown-area-S2": {
    zone: { kind: "unknown", raw: "S2120500" },
    unknownReasons: ["zone:S2120500"],
  },
  "unknown-warnVar": {
    kind: { group: "unknown", raw: "99" },
    unknownReasons: ["warnVar:99"],
  },
};

describe("normalizePwnCdRow · 픽스처 cases", () => {
  it("모든 case에 기대 결과가 있음", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(
      data.cases.map((c) => c.id).sort(),
    );
  });

  it.each(data.cases)("$id", ({ id, row }) => {
    const event = normalizePwnCdRow(row);
    expect(event).toMatchObject(EXPECTED[id]!);
    expect(event).toMatchObject({
      source: "getPwnCd",
      agency: "기상청",
      stationId: null, // 픽스처에 stnId 없음
      raw: row,
    });
  });

  it("실데이터는 사유 없음, 합성 중 모르는 코드만 사유 남음", () => {
    const withReasons = data.cases
      .filter((c) => normalizePwnCdRow(c.row).unknownReasons.length > 0)
      .map((c) => [c.id, c.source]);
    expect(withReasons).toEqual([
      ["unknown-area-S2", "synthetic"],
      ["unknown-warnVar", "synthetic"],
    ]);
  });
});

const BASE: PwnCdRow = data.cases[0]!.row;

describe("normalizePwnCdRow · 해석 못 한 값", () => {
  it("stnId가 있으면 원문 보관", () => {
    expect(normalizePwnCdRow({ ...BASE, stnId: "108" }).stationId).toBe("108");
  });

  it("잘못된 시각·발표번호·코드는 null + 사유", () => {
    const event = normalizePwnCdRow({
      ...BASE,
      tmFc: "202613010000",
      tmSeq: "x",
      command: "4",
      cancel: "9",
      warnStress: "5",
    });
    expect(event).toMatchObject({
      publishedAt: null,
      seq: null,
      action: null,
      level: null,
      effectiveFrom: null,
    });
    expect(event.unknownReasons).toEqual([
      "tmFc:202613010000",
      "tmSeq:x",
      "command:4",
      "cancel:9",
      "warnStress:5",
    ]);
  });

  it("발표인데 startTime이 없으면 사유", () => {
    const event = normalizePwnCdRow({ ...BASE, startTime: "0" });
    expect(event.effectiveFrom).toBeNull();
    expect(event.unknownReasons).toEqual(["startTime:0"]);
  });

  it("해제인데 endTime이 잘못되면 사유", () => {
    const event = normalizePwnCdRow({
      ...BASE,
      command: "2",
      endTime: "20261015",
    });
    expect(event.unknownReasons).toEqual(["endTime:20261015"]);
  });
});

describe("parseZone", () => {
  it.each([
    ["S1152010", sea("S1152010")],
    ["L1014200", land("L1014200")],
    ["S2120500", { kind: "unknown", raw: "S2120500" }],
    ["L2000000", { kind: "unknown", raw: "L2000000" }],
    ["S1", { kind: "unknown", raw: "S1" }],
    ["", { kind: "unknown", raw: "" }],
  ])("%j", (code, zone) => {
    expect(parseZone(code)).toEqual(zone);
  });
});
