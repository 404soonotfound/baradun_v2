import { describe, expect, it } from "vitest";
import { normalizeTsunamiItem, type TsunamiItem } from "./tsunami";
import {
  judgeTsunamiBeaches,
  matchTsunamiRegion,
  type BeachRegion,
} from "./tsunami-match";

// 지진해일 reg 글 → 해변 검사 (BRD-18, 결정 기록 11장 10/22 ⑤)
// 실데이터 없음(제공 범위 3일) → 합성. 중구는 부산·인천 두 곳이라 시군 이름만으로는 못 읽음

const beach = (
  id: string,
  coast: BeachRegion["coast"],
  sido: string,
  sigungu: string,
): BeachRegion => ({
  id,
  coast,
  region: { sido: { ko: sido }, sigungu: { ko: sigungu } },
});

const BEACHES = [
  beach("e1", "east", "강원", "강릉시"),
  beach("e2", "east", "경북", "울진군"),
  beach("s1", "south", "부산", "중구"),
  beach("w1", "west", "인천", "중구"),
  beach("j1", "jeju", "제주", "제주시"),
];

describe("matchTsunamiRegion", () => {
  it.each([
    ["남해안, 동해안", ["e1", "e2", "s1"]], // 활용가이드 예제
    ["제주도", ["j1"]],
    ["서해안", ["w1"]],
    ["경북 울진군", ["e2"]],
    ["울진군", ["e2"]],
    ["부산 중구", ["s1"]],
    ["강원 강릉시·경북 울진군", ["e1", "e2"]],
  ])("읽음: %j", (reg, beachIds) => {
    expect(matchTsunamiRegion(reg, BEACHES)).toEqual({
      beachIds,
      unreadable: [],
    });
  });

  it.each([
    ["중구", [], ["중구"]], // 부산·인천 둘 다 있음
    ["제주시, 고성군", ["j1"], ["고성군"]], // 해변 데이터에 없어도 강원·경남 둘 다 있는 이름
    ["동해안, 울릉도", ["e1", "e2"], ["울릉도"]], // 울릉도는 data/beaches에 없음
    ["경상북도 울진군", [], ["경상북도 울진군"]], // 시도 표기가 다름
    ["서해안 일부", [], ["서해안 일부"]],
    ["동해 연안 전역", [], ["동해 연안 전역"]],
    ["동해안,", ["e1", "e2"], [""]],
    ["", [], [""]],
  ])("못 읽은 조각: %j", (reg, beachIds, unreadable) => {
    expect(matchTsunamiRegion(reg, BEACHES)).toEqual({ beachIds, unreadable });
  });
});

const NOW = "2026-10-22T02:00:00Z"; // KST 11:00

// getTsunamiMsg 행. 기본값: KST 10:00 발표·발효, 경보, 동해안
const msg = (fields: TsunamiItem) =>
  normalizeTsunamiItem({
    stnId: 108,
    tmFc: 202610221000,
    tmEf: 202610221000,
    fcTp: 2,
    reg: "동해안",
    ann: "지진해일 경보 발표",
    ...fields,
  });

const judge = (events: ReturnType<typeof msg>[]) =>
  judgeTsunamiBeaches({
    result: { status: "ok", events },
    now: NOW,
    lastConfirmedAt: NOW,
    beaches: BEACHES,
  });

const empty = { items: [], reasons: [] };
const warning = {
  type: "tsunami",
  level: "warning",
  zoneCode: null,
  zoneName: "동해안",
  publishedAt: "2026-10-22T01:00:00Z",
  effectiveFrom: "2026-10-22T01:00:00Z",
};

describe("judgeTsunamiBeaches", () => {
  it("03 발표 없음 확인 → 모든 해변 비어 있음", () => {
    const result = judgeTsunamiBeaches({
      result: { status: "none" },
      now: NOW,
      lastConfirmedAt: NOW,
      beaches: BEACHES,
    });
    expect(result.beaches.e1).toEqual(empty);
    expect(result.unreadable).toEqual([]);
  });

  it("조회 실패 → 모든 해변 사유", () => {
    const result = judgeTsunamiBeaches({
      result: { status: "failed", reason: "resultCode:99" },
      now: NOW,
      lastConfirmedAt: NOW,
      beaches: BEACHES,
    });
    expect(result.beaches.j1).toEqual({
      items: [],
      reasons: ["tsunami:resultCode:99"],
    });
  });

  it("동해안 경보 → 동해안 해변만 발효, 구역 이름은 reg 원문", () => {
    const result = judge([msg({})]);
    expect(result.beaches.e1).toEqual({ items: [warning], reasons: [] });
    expect(result.beaches.e2).toEqual({ items: [warning], reasons: [] });
    expect(result.beaches.s1).toEqual(empty);
  });

  it("발표 뒤 해제 → 발효 없음", () => {
    const result = judge([
      msg({}),
      msg({ tmFc: 202610221030, tmEf: 202610221030, fcTp: 3 }),
    ]);
    expect(result.beaches.e1).toEqual(empty);
  });

  it("동해안 발표 뒤 강릉시만 해제 → 울진군은 발효 유지", () => {
    const result = judge([
      msg({}),
      msg({
        tmFc: 202610221030,
        tmEf: 202610221030,
        fcTp: 3,
        reg: "강원 강릉시",
      }),
    ]);
    expect(result.beaches.e1).toEqual(empty);
    expect(result.beaches.e2!.items).toEqual([warning]);
  });

  it("기준 시각 뒤 발표는 아직 모름", () => {
    const result = judge([msg({ tmFc: 202610221200, tmEf: 202610221200 })]);
    expect(result.beaches.e1).toEqual(empty);
  });

  it("못 읽은 글 → unreadable + 원문, 해변은 그대로", () => {
    const result = judge([msg({ reg: "동해 연안 전역" })]);
    expect(result.unreadable).toEqual([
      {
        reg: "동해 연안 전역",
        parts: ["동해 연안 전역"],
        announcement: "지진해일 경보 발표",
      },
    ]);
    expect(result.beaches.e1).toEqual(empty);
  });

  it("일부만 읽힌 경보 → 읽힌 해변은 발효, 못 읽은 조각은 unreadable", () => {
    const result = judge([msg({ reg: "동해안, 울릉도" })]);
    const item = { ...warning, zoneName: "동해안, 울릉도" };
    expect(result.beaches.e1).toEqual({ items: [item], reasons: [] });
    expect(result.beaches.e2).toEqual({ items: [item], reasons: [] });
    expect(result.beaches.s1).toEqual(empty);
    expect(result.unreadable).toEqual([
      {
        reg: "동해안, 울릉도",
        parts: ["울릉도"],
        announcement: "지진해일 경보 발표",
      },
    ]);
  });

  it("일부만 읽힌 해제 → 읽힌 해변만 해제, 못 읽은 조각은 unreadable", () => {
    const result = judge([
      msg({ reg: "동해안, 남해안" }),
      msg({
        tmFc: 202610221030,
        tmEf: 202610221030,
        fcTp: 3,
        reg: "동해안, 울릉도",
      }),
    ]);
    expect(result.beaches.e1).toEqual(empty);
    expect(result.beaches.s1!.items).toHaveLength(1);
    expect(result.unreadable.map((u) => u.parts)).toEqual([["울릉도"]]);
  });

  it("완전히 같은 행이 두 번 → 하나로 보고 발효", () => {
    const result = judge([msg({}), msg({})]);
    expect(result.beaches.e1).toEqual({ items: [warning], reasons: [] });
  });

  it("모르는 fcTp 두 가지가 같은 시각 → 사유 둘 다 남김", () => {
    const result = judge([msg({ fcTp: 8 }), msg({ fcTp: 9 })]);
    expect(result.beaches.e1!.reasons).toEqual([
      "tsunami:fcTp:8",
      "tsunami:fcTp:9",
    ]);
  });

  it("앞선 경보 뒤 다른 지역 글의 주의보 → 경보를 낮추지 않고 둘 다 발효", () => {
    const result = judge([
      msg({ reg: "경북 울진군" }),
      msg({ tmFc: 202610221030, tmEf: 202610221030, fcTp: 1 }),
    ]);
    expect(result.beaches.e2!.items.map((i) => [i.level, i.zoneName])).toEqual([
      ["warning", "경북 울진군"],
      ["advisory", "동해안"],
    ]);
  });

  it("같은 지역 글의 뒤 주의보 → 앞선 경보를 대신함", () => {
    const result = judge([
      msg({}),
      msg({ tmFc: 202610221030, tmEf: 202610221030, fcTp: 1 }),
    ]);
    expect(result.beaches.e1!.items.map((i) => i.level)).toEqual(["advisory"]);
  });

  it("못 읽은 행 뒤 해제 → 해제가 대신해 사유 없음", () => {
    const result = judge([
      msg({ fcTp: 9 }),
      msg({ tmFc: 202610221030, tmEf: 202610221030, fcTp: 3 }),
    ]);
    expect(result.beaches.e1).toEqual(empty);
  });

  it("발표 시각을 못 읽은 행 → 해제가 와도 사유", () => {
    const result = judge([
      msg({ tmFc: "x" }),
      msg({ tmFc: 202610221030, tmEf: 202610221030, fcTp: 3 }),
    ]);
    expect(result.beaches.e1!.reasons).toEqual(["tsunami:tmFc:x"]);
  });

  it("45분 넘게 확인 못 함 → 모든 해변 사유, 발효 중 경보는 유지", () => {
    const result = judgeTsunamiBeaches({
      result: { status: "ok", events: [msg({})] },
      now: NOW,
      lastConfirmedAt: "2026-10-22T01:14:59Z", // 45분 1초 전
      beaches: BEACHES,
    });
    expect(result.beaches.e1).toEqual({
      items: [warning],
      reasons: ["tsunami:confirmation:expired"],
    });
    expect(result.beaches.s1!.reasons).toEqual([
      "tsunami:confirmation:expired",
    ]);
  });

  it("발효 전 해제만 보임 → 앞선 발표를 몰라 사유", () => {
    const result = judge([msg({ tmEf: 202610221200, fcTp: 3 })]);
    expect(result.beaches.e1).toEqual({
      items: [],
      reasons: ["tsunami:release_without_issue"],
    });
  });

  it("발효 중 경보 + 발효 전 해제 → 해제 시각까지 경보 유지", () => {
    const result = judge([
      msg({}),
      msg({ tmFc: 202610221030, tmEf: 202610221200, fcTp: 3 }),
    ]);
    expect(result.beaches.e1).toEqual({ items: [warning], reasons: [] });
  });

  it.each([
    ["경보 → 주의보", [2, 1]],
    ["주의보 → 경보", [1, 2]],
  ])("같은 시각·지역 글에 단계만 다름(%s 순) → 높은 단계 유지", (_, fcTps) => {
    const result = judge(fcTps.map((fcTp) => msg({ fcTp })));
    expect(result.beaches.e1).toEqual({ items: [warning], reasons: [] });
  });

  it("예고 해제 뒤 발효된 해제 → 확인된 해제로 없음", () => {
    const result = judge([
      msg({ tmEf: 202610221200, fcTp: 3 }),
      msg({ tmFc: 202610221030, tmEf: 202610221030, fcTp: 3 }),
    ]);
    expect(result.beaches.e1).toEqual(empty);
  });

  it("모르는 fcTp → 그 해변들 사유", () => {
    const result = judge([msg({ fcTp: 9 })]);
    expect(result.beaches.e1).toEqual({
      items: [],
      reasons: ["tsunami:fcTp:9"],
    });
    expect(result.beaches.s1).toEqual(empty);
  });

  it("같은 발표 시각에 지역 글만 다른 경보 → 둘 다 발효", () => {
    const result = judge([msg({ reg: "강원 강릉시" }), msg({})]);
    expect(result.beaches.e1).toEqual({
      items: [{ ...warning, zoneName: "강원 강릉시" }, warning], // 지역 글 순
      reasons: [],
    });
  });

  it("같은 발표 시각에 주의보·경보 → 둘 다 발효, 경보 먼저", () => {
    const result = judge([
      msg({ fcTp: 1, reg: "강원 강릉시" }),
      msg({ reg: "동해안" }),
    ]);
    expect(result.beaches.e1!.reasons).toEqual([]);
    expect(result.beaches.e1!.items.map((i) => i.level)).toEqual([
      "warning",
      "advisory",
    ]);
  });

  it("옛 시각의 경보·해제 충돌을 뒤 해제가 대신함 → 없음", () => {
    const result = judge([
      msg({}),
      msg({ fcTp: 3 }),
      msg({ tmFc: 202610221030, tmEf: 202610221030, fcTp: 3 }),
    ]);
    expect(result.beaches.e1).toEqual(empty);
  });

  it("같은 발표 시각에 경보·해제 → 순서를 알 수 없음", () => {
    const result = judge([msg({}), msg({ fcTp: 3 })]);
    expect(result.beaches.e1).toEqual({
      items: [],
      reasons: ["tsunami:order:2026-10-22T01:00:00Z"],
    });
  });
});
