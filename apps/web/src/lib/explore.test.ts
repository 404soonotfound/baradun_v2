import { beforeEach, describe, expect, it } from "vitest";

import type { BeachSummary } from "@/lib/beach-summary";
import {
  buildItems,
  exploreMode,
  filterBeaches,
  groupItems,
  isLoading,
  noClearAtAll,
  sortItems,
  type ExploreItem,
} from "@/lib/explore";
import {
  isSortChoice,
  resetSortChoiceForTest,
  setSortChoice,
} from "@/lib/explore-sort";
import type { BadgeLabel, BeachView, Category } from "@/lib/snapshot/view";

function beach(
  id: string,
  name: string,
  sido: string,
  lat: number,
  activities: BeachSummary["activities"] = ["swimming"],
): BeachSummary {
  return {
    id,
    slug: id,
    name,
    sido: { key: sido, label: sido },
    sigungu: { key: "시", label: "시" },
    region: `${sido} 시`,
    coords: { lat, lng: 128.9 },
    activities,
    stations: {
      waveHeight: null,
      wavePeriod: null,
      waveDirection: null,
      waterTemp: null,
      wind: null,
    },
  };
}

type ReadyView = Extract<BeachView, { kind: "ready" }>;

function ready(
  category: Category,
  badge: BadgeLabel,
  stale = false,
  confirmedAt: string | null = "2026-10-27T05:00:00Z",
): ReadyView {
  return {
    kind: "ready",
    category,
    badge,
    reasons: [badge],
    stale,
    confirmedAt,
    metrics: {
      waveHeight: { kind: "hidden" },
      wavePeriod: { kind: "hidden" },
      waveDirection: { kind: "hidden" },
      waterTemp: { kind: "hidden" },
      wind: { kind: "hidden" },
    },
  };
}

const clear = ready("clear", { kind: "clear" });
const wind = ready("unavailable", {
  kind: "warning",
  type: "strong_wind",
  level: "advisory",
});
const unknown = ready("undetermined", { kind: "warning_unknown" });
const delayed = ready("undetermined", { kind: "observation_delayed" });

const A = beach("a", "가해변", "강원", 37.0, ["swimming", "surfing"]);
const B = beach("b", "나해변", "강원", 37.5);
const C = beach("c", "다해변", "부산", 35.1, ["swimming", "scuba"]);
const ALL = [A, B, C];

describe("filterBeaches", () => {
  it("수영은 전체, 서핑·스쿠버는 그 활동이 확인된 해변만", () => {
    expect(filterBeaches(ALL, "swimming", null)).toHaveLength(3);
    expect(filterBeaches(ALL, "surfing", null).map((b) => b.id)).toEqual(["a"]);
    expect(filterBeaches(ALL, "scuba", null).map((b) => b.id)).toEqual(["c"]);
  });

  it("지역은 시·도(와 시·군)로 거름, 전국(null)은 전체", () => {
    expect(
      filterBeaches(ALL, "swimming", { sido: "강원", sigungu: null }).map(
        (b) => b.id,
      ),
    ).toEqual(["a", "b"]);
    expect(
      filterBeaches(ALL, "swimming", { sido: "강원", sigungu: "없는군" }),
    ).toEqual([]);
  });
});

describe("buildItems", () => {
  it("노출 끈 해변(hidden 화면 상태)은 목록에서 뺌", () => {
    const items = buildItems(ALL, null, (item) =>
      item.id === "b" ? { kind: "hidden" } : clear,
    );
    expect(items.map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("측정소가 없는 지표 값은 출처를 붙일 수 없어 숨김", () => {
    const withValue: BeachView = {
      ...clear,
      metrics: {
        ...clear.metrics,
        waveHeight: {
          kind: "value",
          value: 0.6,
          unit: "m",
          observedAt: "2026-10-27T05:00:00Z",
        },
      },
    };
    const [item] = buildItems([A], null, () => withValue);
    expect(
      item?.view.kind === "ready" && item.view.metrics.waveHeight.kind,
    ).toBe("hidden");
  });

  it("위치가 있을 때만 거리를 붙임", () => {
    const withLocation = buildItems(
      ALL,
      { lat: 37.0, lng: 128.9 },
      () => clear,
    );
    expect(withLocation[0]?.distanceKm).toBeCloseTo(0, 1);
    expect(buildItems(ALL, null, () => clear)[0]?.distanceKm).toBeNull();
  });
});

describe("groupItems", () => {
  const views: Record<string, BeachView> = { a: unknown, b: clear, c: wind };
  const items = buildItems(ALL, null, (item) => views[item.id]!);

  it("특보 없음 → 이용불가 → 판단불가 순, 빈 묶음은 숨김", () => {
    expect(groupItems(items, "ko").map((g) => g.category)).toEqual([
      "clear",
      "unavailable",
      "undetermined",
    ]);
    const onlyClear = buildItems(ALL, null, () => clear);
    expect(groupItems(onlyClear, "ko").map((g) => g.category)).toEqual([
      "clear",
    ]);
  });

  it("읽지 못한 해변도 판단불가 묶음에 남음(개수에서 빠지지 않음)", () => {
    const all = buildItems(ALL, null, () => unknown);
    const [group] = groupItems(all, "ko");
    expect(group?.category).toBe("undetermined");
    expect(group?.items).toHaveLength(3);
  });

  it("사유별 개수를 세고, 특보 없음 묶음만 가장 이른 확인 시각을 가짐", () => {
    const mixed = buildItems(ALL, null, (item) =>
      item.id === "a" ? delayed : item.id === "b" ? unknown : clear,
    );
    const groups = groupItems(mixed, "ko");
    expect(groups[0]?.checkedAt).toBe("2026-10-27T05:00:00Z");
    const undetermined = groups.find((g) => g.category === "undetermined");
    expect(undetermined?.counts.map((c) => c.label.kind).sort()).toEqual([
      "observation_delayed",
      "warning_unknown",
    ]);
    expect(undetermined?.checkedAt).toBeNull();
  });

  it("특보 없음 묶음의 확인 시각을 모르는 해변이 섞이면 시각을 내세우지 않음", () => {
    const noTime = ready("clear", { kind: "clear" }, false, null);
    const mixed = buildItems(ALL, null, (item) =>
      item.id === "a" ? noTime : clear,
    );
    expect(groupItems(mixed, "ko")[0]?.checkedAt).toBeNull();
  });

  it("묶음 안은 가까운 순, 위치가 없으면 이름 순이고 가장 가까운 곳을 돌려줌", () => {
    const here = { lat: 37.6, lng: 128.9 };
    const near = buildItems(ALL, here, () => clear);
    const [group] = groupItems(near, "ko");
    expect(group?.items.map((i) => i.id)).toEqual(["b", "a", "c"]);
    expect(group?.nearestKm).toBe(group?.items[0]?.distanceKm);
    const noLocation = buildItems(ALL, null, () => clear);
    const [byName] = groupItems(noLocation, "ko");
    expect(byName?.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(byName?.nearestKm).toBeNull();
  });

  it("오프라인(B5): 발효 특보는 이용불가에 남고, 마지막이 특보 없음이던 해변은 판단불가", () => {
    const staleWind = ready("unavailable", wind.badge, true);
    const staleClear = ready("undetermined", { kind: "warning_unknown" }, true);
    const stale = buildItems(ALL, null, (item) =>
      item.id === "a" ? staleWind : staleClear,
    );
    const groups = groupItems(stale, "ko");
    expect(groups.map((g) => g.category)).toEqual([
      "unavailable",
      "undetermined",
    ]);
  });
});

describe("sortItems", () => {
  it("가까운 순은 거리, 같으면 이름. 이름 순은 가나다", () => {
    const here = { lat: 37.0, lng: 128.9 };
    const items = buildItems(ALL, here, () => clear);
    expect(sortItems(items, "near", "ko").map((i) => i.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(sortItems(items, "name", "ko").map((i) => i.name)).toEqual([
      "가해변",
      "나해변",
      "다해변",
    ]);
  });

  it("원본 배열은 바꾸지 않음", () => {
    const items = buildItems([C, A], null, () => clear);
    sortItems(items, "name", "ko");
    expect(items.map((i) => i.id)).toEqual(["c", "a"]);
  });
});

describe("exploreMode", () => {
  it("위치가 없으면 가까운 순 선택도 이름 순", () => {
    expect(exploreMode("second", false)).toBe("name");
    expect(exploreMode("second", true)).toBe("near");
    expect(exploreMode("status", false)).toBe("status");
  });
});

describe("isLoading · noClearAtAll", () => {
  const loadingItem = (view: BeachView): ExploreItem[] =>
    buildItems([A], null, () => view);

  it("한 곳이라도 불러오는 중이면 로딩", () => {
    expect(isLoading(loadingItem({ kind: "loading" }))).toBe(true);
    expect(isLoading(loadingItem(clear))).toBe(false);
  });

  it("특보 없음이 하나도 없을 때만 안내(지금 받은 정보일 때)", () => {
    expect(noClearAtAll(loadingItem(wind), true)).toBe(true);
    expect(noClearAtAll(loadingItem(clear), true)).toBe(false);
    expect(noClearAtAll([], true)).toBe(false);
  });

  it("오래된 정보·불러오는 중에는 안내하지 않음('특보가 있다'로 읽히지 않게)", () => {
    expect(noClearAtAll(loadingItem(wind), false)).toBe(false);
    expect(noClearAtAll(loadingItem({ kind: "loading" }), true)).toBe(false);
    expect(
      noClearAtAll(loadingItem(ready("unavailable", wind.badge, true)), true),
    ).toBe(false);
  });
});

describe("정렬 선택 기기 저장", () => {
  beforeEach(() => resetSortChoiceForTest());

  it("저장소를 못 써도(오류) 선택은 메모리로 유지", () => {
    // 테스트 환경(node)에는 localStorage가 없어 쓰기·읽기가 모두 오류 → 메모리 값
    expect(() => setSortChoice("second")).not.toThrow();
  });

  it("모르는 저장 값은 거부", () => {
    expect(isSortChoice("second")).toBe(true);
    expect(isSortChoice("near")).toBe(false);
    expect(isSortChoice(null)).toBe(false);
  });
});
