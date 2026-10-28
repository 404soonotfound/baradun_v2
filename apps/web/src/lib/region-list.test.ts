import { describe, expect, it } from "vitest";

import type { BeachSummary } from "@/lib/beach-summary";
import {
  inRegion,
  regionChips,
  regionGroups,
  regionName,
  validRegion,
} from "@/lib/region-list";

// 테스트용 해변. 이름·좌표·측정소는 계산에 쓰지 않아 아무 값
function beach(id: string, sido: string, sigungu: string): BeachSummary {
  return {
    id,
    slug: id,
    name: id,
    sido: { key: sido, label: sido },
    sigungu: { key: sigungu, label: sigungu },
    region: `${sido} ${sigungu}`,
    coords: { lat: 0, lng: 0 },
    activities: ["swimming"],
    names: [id, id],
    aliases: [],
    regionNames: [],
    photo: null,
    stations: {
      waveHeight: null,
      wavePeriod: null,
      waveDirection: null,
      waterTemp: null,
      wind: null,
    },
  };
}

const beaches = [
  beach("b1", "제주", "제주시"),
  beach("b2", "강원", "양양군"),
  beach("b3", "강원", "강릉시"),
  beach("b4", "강원", "양양군"),
  beach("b5", "부산", "해운대구"),
];

describe("regionChips", () => {
  it("해변이 있는 시·도만, 지리 순서로", () => {
    expect(regionChips(beaches).map((part) => part.key)).toEqual([
      "강원",
      "부산",
      "제주",
    ]);
  });
});

describe("regionGroups", () => {
  it("시·도마다 시·군을 한 번씩, 이름 순으로", () => {
    expect(regionGroups(beaches)[0]).toEqual({
      sido: { key: "강원", label: "강원" },
      sigungu: [
        { key: "강릉시", label: "강릉시" },
        { key: "양양군", label: "양양군" },
      ],
    });
  });
});

describe("regionName · inRegion · validRegion", () => {
  const groups = regionGroups(beaches);

  it("시·군까지 고르면 둘 다, 아니면 시·도만", () => {
    expect(regionName(groups, { sido: "강원", sigungu: null })).toBe("강원");
    expect(regionName(groups, { sido: "강원", sigungu: "양양군" })).toBe(
      "강원 양양군",
    );
    expect(regionName(groups, { sido: "경북", sigungu: null })).toBeNull();
  });

  it("고른 지역 안의 해변만", () => {
    const yangyang = { sido: "강원", sigungu: "양양군" };
    expect(beaches.filter((item) => inRegion(item, yangyang))).toHaveLength(2);
    expect(
      beaches.filter((item) => inRegion(item, { sido: "강원", sigungu: null })),
    ).toHaveLength(3);
  });

  it("없어진 시·군은 시·도만 남기고, 없어진 시·도는 null", () => {
    expect(validRegion({ sido: "강원", sigungu: "속초시" }, beaches)).toEqual({
      sido: "강원",
      sigungu: null,
    });
    expect(validRegion({ sido: "경북", sigungu: null }, beaches)).toBeNull();
  });
});
