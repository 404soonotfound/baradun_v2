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
      readable: true,
      beachIds,
    });
  });

  it.each([
    ["중구", ["중구"]], // 부산·인천 둘 다 있음
    ["동해안, 울릉도", ["울릉도"]], // data/beaches에 없음
    ["경상북도 울진군", ["경상북도 울진군"]], // 시도 표기가 다름
    ["서해안 일부", ["서해안 일부"]],
    ["동해 연안 전역", ["동해 연안 전역"]],
    ["동해안,", [""]],
    ["", [""]],
  ])("못 읽음: %j", (reg, parts) => {
    expect(matchTsunamiRegion(reg, BEACHES)).toEqual({
      readable: false,
      parts,
    });
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
      beaches: BEACHES,
    });
    expect(result.beaches.e1).toEqual(empty);
    expect(result.unreadable).toEqual([]);
  });

  it("조회 실패 → 모든 해변 사유", () => {
    const result = judgeTsunamiBeaches({
      result: { status: "failed", reason: "resultCode:99" },
      now: NOW,
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

  it("모르는 fcTp → 그 해변들 사유", () => {
    const result = judge([msg({ fcTp: 9 })]);
    expect(result.beaches.e1).toEqual({
      items: [],
      reasons: ["tsunami:fcTp:9"],
    });
    expect(result.beaches.s1).toEqual(empty);
  });

  it("같은 발표 시각에 경보·해제 → 순서를 알 수 없음", () => {
    const result = judge([msg({}), msg({ fcTp: 3 })]);
    expect(result.beaches.e1).toEqual({
      items: [],
      reasons: ["tsunami:order:2026-10-22T01:00:00Z"],
    });
  });
});
