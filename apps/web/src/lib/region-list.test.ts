import { describe, expect, it } from "vitest";

import type { BeachSummary } from "@/lib/beach-summary";
import {
  homeScope,
  inRegion,
  NATIONWIDE,
  parseRegionChoice,
  regionChips,
  regionGroups,
  regionName,
  savedScope,
  scopeBeaches,
  validRegion,
} from "@/lib/region-list";
import type { BeachView } from "@/lib/snapshot/view";
import { countByStatus } from "@/lib/status-count";

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

describe("parseRegionChoice", () => {
  it("시·도 지역과 전국을 읽음", () => {
    expect(parseRegionChoice('{"sido":"강원","sigungu":"양양군"}')).toEqual({
      sido: "강원",
      sigungu: "양양군",
    });
    expect(parseRegionChoice('{"sido":"강원"}')).toEqual({
      sido: "강원",
      sigungu: null,
    });
    expect(parseRegionChoice(JSON.stringify(NATIONWIDE))).toBe(NATIONWIDE);
  });

  it("저장값 없음·모양이 다른 값은 null(고르지 않은 것)", () => {
    expect(parseRegionChoice(null)).toBeNull();
    for (const raw of [
      "",
      "{",
      "null",
      "123",
      '"busan"',
      "nationwide", // JSON 글자가 아님
      '{"sido":3}',
      "[]",
    ])
      expect(parseRegionChoice(raw)).toBeNull();
  });
});

describe("homeScope (기본값 전국, BRD-127)", () => {
  it("저장값이 없고 위치도 없으면 전국(기본값)", () => {
    for (const status of ["idle", "denied", "unavailable", "off"] as const)
      expect(homeScope(null, beaches, status)).toEqual({
        kind: "nationwide",
        chosen: false,
      });
  });

  it("저장값이 없어도 위치가 있거나 확인 중이면 가까운 바다(위치 흐름 그대로)", () => {
    for (const status of ["ready", "locating", "checking"] as const)
      expect(homeScope(null, beaches, status)).toEqual({ kind: "nearby" });
  });

  it("고른 지역은 위치와 관계없이 그대로 유지", () => {
    const yangyang = { sido: "강원", sigungu: "양양군" };
    for (const status of ["idle", "ready", "denied", "checking"] as const)
      expect(homeScope(yangyang, beaches, status)).toEqual({
        kind: "region",
        region: yangyang,
      });
  });

  it("시트에서 고른 전국은 위치가 있어도 전국", () => {
    for (const status of ["ready", "idle", "denied", "checking"] as const)
      expect(homeScope(NATIONWIDE, beaches, status)).toEqual({
        kind: "nationwide",
        chosen: true,
      });
  });

  it("잘못된 저장값(목록에 없는 시·도·모양이 다른 값)은 기본값과 같음", () => {
    const gone = { sido: "경북", sigungu: null };
    expect(homeScope(gone, beaches, "denied")).toEqual({
      kind: "nationwide",
      chosen: false,
    });
    expect(homeScope(gone, beaches, "ready")).toEqual({ kind: "nearby" });
    expect(homeScope(parseRegionChoice("{"), beaches, "idle")).toEqual({
      kind: "nationwide",
      chosen: false,
    });
  });
});

describe("scopeBeaches · 전국 집계", () => {
  const all = [
    ...beaches,
    { ...beach("a0", "부산", "해운대구"), activities: ["swimming", "surfing"] },
  ] satisfies BeachSummary[];

  it("전국은 공개 해변 전체를 이름 순으로", () => {
    const list = scopeBeaches(
      all,
      { kind: "nationwide", chosen: false },
      "swimming",
    );
    expect(list).toHaveLength(all.length);
    expect(list.map((item) => item.id)).toEqual([
      "a0",
      "b1",
      "b2",
      "b3",
      "b4",
      "b5",
    ]);
  });

  it("서핑·스쿠버는 그 활동이 확인된 해변만(지역과 같은 규칙)", () => {
    expect(
      scopeBeaches(all, { kind: "nationwide", chosen: true }, "surfing").map(
        (item) => item.id,
      ),
    ).toEqual(["a0"]);
    expect(
      scopeBeaches(all, { kind: "nationwide", chosen: true }, "scuba"),
    ).toEqual([]);
  });

  it("지역은 그 지역만, 가까운 바다는 빈 목록(거리 순은 홈이 만듦)", () => {
    expect(
      scopeBeaches(
        all,
        { kind: "region", region: { sido: "강원", sigungu: null } },
        "swimming",
      ).map((item) => item.id),
    ).toEqual(["b2", "b3", "b4"]);
    expect(scopeBeaches(all, { kind: "nearby" }, "swimming")).toEqual([]);
  });

  it("전국 상태별 개수는 게시된 분류를 해변 수만큼 그대로 셈", () => {
    const list = scopeBeaches(
      all,
      { kind: "nationwide", chosen: false },
      "swimming",
    );
    // 첫 해변만 풍랑주의보, 나머지는 특보 없음(게시값 그대로)
    const views: BeachView[] = list.map((item, index) => ({
      kind: "ready",
      category: index === 0 ? "unavailable" : "clear",
      badge:
        index === 0
          ? { kind: "warning", type: "wind_wave", level: "advisory" }
          : { kind: "clear" },
      reasons: [],
      stale: false,
      confirmedAt: null,
      metrics: {
        waveHeight: { kind: "hidden" },
        wavePeriod: { kind: "hidden" },
        waveDirection: { kind: "hidden" },
        waterTemp: { kind: "hidden" },
        wind: { kind: "hidden" },
      },
    }));
    expect(
      countByStatus(views)?.map((item) => [item.category, item.count]),
    ).toEqual([
      ["clear", all.length - 1],
      ["unavailable", 1],
    ]);
    // 하나라도 불러오는 중이면 개수를 미리 보이지 않음
    expect(countByStatus([...views, { kind: "loading" }])).toBeNull();
  });
});

describe("savedScope (설정 기본 지역, 10/29 결정)", () => {
  it("저장값이 없거나 잘못되면 전국(기본값)", () => {
    for (const saved of [
      null,
      { sido: "경북", sigungu: null },
      parseRegionChoice('{"sido":3}'),
    ])
      expect(savedScope(saved, beaches)).toEqual({
        kind: "nationwide",
        chosen: false,
      });
  });

  it("고른 전국은 chosen, 고른 지역은 그대로", () => {
    expect(savedScope(NATIONWIDE, beaches)).toEqual({
      kind: "nationwide",
      chosen: true,
    });
    expect(savedScope({ sido: "강원", sigungu: "양양군" }, beaches)).toEqual({
      kind: "region",
      region: { sido: "강원", sigungu: "양양군" },
    });
  });

  it("위치를 보지 않음(위치가 있어도 저장값 없음은 전국)", () => {
    expect(savedScope(null, beaches)).toEqual(
      homeScope(null, beaches, "denied"),
    );
    expect(homeScope(null, beaches, "ready")).toEqual({ kind: "nearby" });
  });
});
