import { describe, expect, it } from "vitest";

import { distanceKm, sortByDistance, withinKm } from "./geo";

// 거리 계산 (BRD-26)
const seoul = { lat: 37.5663, lng: 126.9779 }; // 서울시청
const busan = { lat: 35.1798, lng: 129.075 }; // 부산시청

describe("distanceKm", () => {
  it("같은 좌표는 0km", () => {
    expect(distanceKm(seoul, seoul)).toBe(0);
  });

  it("위도 1도는 약 111.19km", () => {
    // toBeCloseTo(값, 1) = 소수 첫째 자리까지 같으면 통과
    expect(
      distanceKm({ lat: 37, lng: 128 }, { lat: 38, lng: 128 }),
    ).toBeCloseTo(111.19, 1);
  });

  it("서울시청에서 부산시청까지 약 325km, 방향을 바꿔도 같다", () => {
    expect(distanceKm(seoul, busan)).toBeCloseTo(325.05, 1);
    expect(distanceKm(busan, seoul)).toBeCloseTo(distanceKm(seoul, busan), 6);
  });
});

describe("sortByDistance·withinKm", () => {
  const items = [
    { id: "far", coords: busan },
    { id: "near", coords: { lat: 37.6, lng: 127.0 } },
  ];

  it("가까운 순으로 정렬하고 거리를 붙이며 원본은 그대로 둔다", () => {
    const sorted = sortByDistance(items, seoul);
    expect(sorted.map((item) => item.id)).toEqual(["near", "far"]);
    // [1]?. = 이 저장소는 배열[번호]가 undefined일 수 있다고 보는 설정(noUncheckedIndexedAccess)이라 ?. 필요
    expect(sorted[1]?.distanceKm).toBeCloseTo(325.05, 1);
    expect(items[0]?.id).toBe("far");
  });

  it("maxKm 밖은 뺀다", () => {
    expect(withinKm(items, seoul, 30).map((item) => item.id)).toEqual(["near"]);
  });
});
