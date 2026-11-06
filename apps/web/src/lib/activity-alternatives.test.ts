import { describe, expect, it } from "vitest";

import type { Activity } from "@/lib/activity";
import { activityAlternatives } from "@/lib/activity-alternatives";
import type { BeachSummary } from "@/lib/beach-summary";
import type { HomeScope } from "@/lib/region-list";

// 테스트용 해변. 지역·활동만 계산에 씀
function beach(
  id: string,
  sigungu: string,
  activities: [Activity, ...Activity[]],
): BeachSummary {
  return {
    id,
    slug: id,
    name: id,
    sido: { key: "강원", label: "강원" },
    sigungu: { key: sigungu, label: sigungu },
    region: `강원 ${sigungu}`,
    coords: { lat: 0, lng: 0 },
    activities,
    names: [id, id],
    aliases: [],
    regionNames: [],
    warningZones: { sea: "S1151200", land: "L1022510" },
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

const BEACHES = [
  beach("a", "강릉시", ["swimming", "surfing"]),
  beach("b", "강릉시", ["swimming"]),
  beach("c", "양양군", ["swimming", "surfing"]),
];
const GANGNEUNG: HomeScope = {
  kind: "region",
  region: { sido: "강원", sigungu: "강릉시" },
};
const YANGGU: HomeScope = {
  kind: "region",
  region: { sido: "강원", sigungu: "고성군" },
};

describe("activityAlternatives", () => {
  it("수영은 대신 찾아볼 일이 없음", () => {
    expect(activityAlternatives(BEACHES, GANGNEUNG, "swimming")).toEqual([]);
  });

  it("전국 0곳(스쿠버): 전국 줄 없이 같은 지역 다른 활동, 0곳 활동은 뺌", () => {
    expect(activityAlternatives(BEACHES, GANGNEUNG, "scuba")).toEqual([
      { kind: "scoped", activity: "swimming", count: 2 },
      { kind: "scoped", activity: "surfing", count: 1 },
    ]);
  });

  it("지역에만 없고 전국에 있으면 '전국 ○○ 해변'이 먼저", () => {
    expect(activityAlternatives(BEACHES, YANGGU, "surfing")).toEqual([
      { kind: "nationwide", activity: "surfing", count: 2 },
    ]);
  });

  it("전국으로 볼 때는 전국 줄을 두지 않음", () => {
    expect(
      activityAlternatives(
        BEACHES,
        { kind: "nationwide", chosen: true },
        "scuba",
      ),
    ).toEqual([
      { kind: "scoped", activity: "swimming", count: 3 },
      { kind: "scoped", activity: "surfing", count: 2 },
    ]);
  });

  it("가까운 바다는 개수 없이, 전국에 있는 활동만", () => {
    expect(
      activityAlternatives(
        [beach("a", "강릉시", ["swimming"])],
        { kind: "nearby" },
        "scuba",
      ),
    ).toEqual([{ kind: "nearby", activity: "swimming" }]);
  });
});
