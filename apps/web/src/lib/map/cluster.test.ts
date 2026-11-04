import { describe, expect, it } from "vitest";

import { listBeachSummaries } from "@/lib/beaches";
import type { LocationState } from "@/lib/location";
import {
  CLUSTER_MAX_ZOOM,
  CLUSTER_RADIUS_PX,
  clusterMarkers,
  releaseMarkers,
  type MapGroup,
} from "./cluster";
import { boundsOf } from "./bounds";
import {
  NEARBY_BEACH_COUNT,
  nearbyBeaches,
  nearbyPlan,
  nearbyWaitStep,
} from "./nearby";

// 지도 마커 묶음·내 주변 보기 (BRD-114 · 결정 기록 12장 결정 5·8)

// 강릉 해변 셋(서로 1~2km)과 멀리 떨어진 부산 해변 하나
const b1 = {
  id: "b1",
  coords: { lat: 37.805, lng: 128.915 },
  badge: "blocked",
};
const b2 = { id: "b2", coords: { lat: 37.785, lng: 128.93 }, badge: "stale" };
const b3 = { id: "b3", coords: { lat: 37.795, lng: 128.92 }, badge: "clear" };
const b9 = { id: "b9", coords: { lat: 35.159, lng: 129.16 }, badge: "clear" };
const beaches = [b3, b1, b2, b9];

// 묶음마다 해변 id 목록
const clusterIds = <T extends { id: string }>(groups: MapGroup<T>[]) =>
  groups.flatMap((group) =>
    group.kind === "cluster" ? [group.items.map((item) => item.id)] : [],
  );
const allSingle = <T>(groups: MapGroup<T>[]) =>
  groups.every((group) => group.kind === "single");

describe("clusterMarkers", () => {
  it("낮은 확대 단계에서 겹치는 마커를 하나로 묶고, 멀리 있는 마커는 따로 둔다", () => {
    const groups = clusterMarkers(beaches, 8);
    expect(clusterIds(groups)).toEqual([["b1", "b2", "b3"]]);
    expect(groups.filter((group) => group.kind === "single")).toEqual([
      { kind: "single", item: b9 },
    ]);
  });

  it("묶음은 해변 수·범위만 갖고 대표 상태를 만들지 않는다(각 해변의 분류는 그대로)", () => {
    const groups = clusterMarkers([b1, b2, b3], 8);
    expect(groups).toHaveLength(1);
    const cluster = groups[0];
    if (cluster?.kind !== "cluster") throw new Error("묶음이 아님");
    expect(Object.keys(cluster).sort()).toEqual([
      "bounds",
      "center",
      "items",
      "key",
      "kind",
    ]);
    expect(cluster.items).toEqual([b1, b2, b3]);
    expect(cluster.bounds).toEqual([
      [128.915, 37.785],
      [128.93, 37.805],
    ]);
  });

  it(`확대 ${CLUSTER_MAX_ZOOM} 이상은 붙어 있어도 모두 개별 마커다`, () => {
    expect(allSingle(clusterMarkers(beaches, CLUSTER_MAX_ZOOM))).toBe(true);
    expect(allSingle(clusterMarkers(beaches, 14))).toBe(true);
  });

  it("입력 순서가 달라도 결과가 같다", () => {
    const keys = (list: typeof beaches) =>
      clusterMarkers(list, 8).map((group) =>
        group.kind === "cluster" ? group.key : group.item.id,
      );
    expect(keys([...beaches].reverse())).toEqual(keys(beaches));
  });

  it("화면에서 묶는 거리보다 멀면 묶지 않는다", () => {
    // 확대 10에서 b1·b2는 화면에서 가로 약 22px · 세로 약 37px 떨어짐
    expect(clusterIds(clusterMarkers([b1, b2], 10, 44))).toEqual([
      ["b1", "b2"],
    ]);
    expect(allSingle(clusterMarkers([b1, b2], 10, 36))).toBe(true);
  });
});

describe("releaseMarkers", () => {
  it("고른·가리킨 해변을 묶음에서 꺼내고, 남은 해변만 다시 묶는다", () => {
    const groups = releaseMarkers(
      clusterMarkers([b1, b2, b3], 8),
      new Set(["b2"]),
      8,
    );
    expect(groups).toContainEqual({ kind: "single", item: b2 });
    expect(clusterIds(groups)).toEqual([["b1", "b3"]]);
  });

  it("고른 해변이 없는 묶음은 그대로 둔다(key가 같아 마커를 다시 붙이지 않음)", () => {
    const base = clusterMarkers(beaches, 8);
    const released = releaseMarkers(base, new Set(["b9"]), 8);
    expect(released).toEqual(base);
    expect(releaseMarkers(base, new Set(), 8)).toEqual(base);
  });

  it("남은 해변이 하나면 개별 마커로 둔다", () => {
    const groups = releaseMarkers(
      clusterMarkers([b1, b2], 8),
      new Set(["b1"]),
      8,
    );
    expect(allSingle(groups)).toBe(true);
    expect(groups).toHaveLength(2);
  });
});

describe("nearbyBeaches", () => {
  const me = { lat: 37.75, lng: 128.9 };

  it(`내 위치에서 가까운 순 ${NEARBY_BEACH_COUNT}곳을 고른다(먼 해변은 넣지 않음)`, () => {
    expect(nearbyBeaches(beaches, me).map((b) => b.id)).toEqual([
      "b2",
      "b3",
      "b1",
    ]);
  });

  it("고른 해변의 범위에 내 위치는 들어가지 않는다", () => {
    const box = boundsOf(nearbyBeaches(beaches, me).map((b) => b.coords));
    expect(box).toEqual([
      [128.915, 37.785],
      [128.93, 37.805],
    ]);
    // 내 위치(위도 37.75)는 범위 밖에 남음
    expect(box[0][1]).toBeGreaterThan(me.lat);
  });

  it("부산에 있으면 부산 해변부터(지역과 상관없이 전체에서 고름)", () => {
    expect(nearbyBeaches(beaches, { lat: 35.16, lng: 129.15 })[0]?.id).toBe(
      "b9",
    );
  });

  it("해변이 없으면 빈 목록", () => {
    expect(nearbyBeaches([], me)).toEqual([]);
  });

  it("좌표가 잘못된 해변은 빼고 고른다(정렬이 어긋나지 않게)", () => {
    const broken = { id: "bx", coords: { lat: Number.NaN, lng: 128.9 } };
    expect(
      nearbyBeaches([broken, b9, b1, b2, b3], me).map((b) => b.id),
    ).toEqual(["b2", "b3", "b1"]);
  });

  it("내 위치가 잘못된 값이면 고르지 않는다", () => {
    expect(nearbyBeaches(beaches, { lat: Number.NaN, lng: 0 })).toEqual([]);
  });
});

describe("nearbyPlan", () => {
  it("가까운 해변이 지금 보이는 지역 안이면 지역을 그대로 둔다", () => {
    const plan = nearbyPlan(beaches, new Set(["b1", "b2", "b3"]), {
      lat: 37.75,
      lng: 128.9,
    });
    expect(plan).toEqual({
      box: [
        [128.915, 37.785],
        [128.93, 37.805],
      ],
      nationwide: false,
    });
  });

  it("가까운 해변이 지역 밖에 있으면 전국으로 바꾼다", () => {
    const plan = nearbyPlan(beaches, new Set(["b1", "b2", "b3"]), {
      lat: 35.16,
      lng: 129.15,
    });
    expect(plan?.nationwide).toBe(true);
  });

  it("옮길 해변이 없으면 null", () => {
    expect(nearbyPlan([], new Set(), { lat: 37.75, lng: 128.9 })).toBeNull();
  });
});

describe("nearbyWaitStep", () => {
  const coords = { lat: 37.75, lng: 128.9 };
  it.each([
    [{ status: "ready", coords }, "move"],
    [{ status: "locating", coords: null }, "wait"],
    [{ status: "checking", coords: null }, "wait"],
    // 다른 곳의 '다시 시도' 답을 기다리는 중
    [{ status: "denied", coords: null, retry: "pending" }, "wait"],
    [{ status: "denied", coords: null }, "stop"],
    [{ status: "denied", coords: null, retry: "denied" }, "stop"],
    [{ status: "off", coords: null }, "stop"],
    [{ status: "unavailable", coords: null }, "stop"],
    [{ status: "idle", coords: null }, "stop"],
  ] as const)("%o → %s", (state, step) => {
    expect(nearbyWaitStep(state as LocationState)).toBe(step);
  });
});

describe("clusterMarkers(출시 해변 전체)", () => {
  // 화면 좌표(웹 메르카토르, 512px 타일)
  const px = ({ lat, lng }: { lat: number; lng: number }, zoom: number) => {
    const size = 512 * 2 ** zoom;
    const sin = Math.sin((lat * Math.PI) / 180);
    return {
      x: ((lng + 180) / 360) * size,
      y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
    };
  };
  const all = listBeachSummaries("ko");

  it.each([5, 6, 8, 10])(
    "확대 %i에서 남은 마커·묶음끼리 누르는 자리(44px)가 겹치지 않고, 해변을 빠뜨리지 않는다",
    (zoom) => {
      const groups = clusterMarkers(all, zoom);
      // 화면에 놓이는 자리: 묶음은 center, 해변은 좌표
      const spots = groups.map((group) =>
        px(group.kind === "cluster" ? group.center : group.item.coords, zoom),
      );
      for (let i = 0; i < spots.length; i++)
        for (let j = i + 1; j < spots.length; j++)
          expect(
            Math.max(
              Math.abs(spots[i]!.x - spots[j]!.x),
              Math.abs(spots[i]!.y - spots[j]!.y),
            ),
          ).toBeGreaterThanOrEqual(CLUSTER_RADIUS_PX);
      const ids = groups.flatMap((group) =>
        group.kind === "cluster"
          ? group.items.map((b) => b.id)
          : [group.item.id],
      );
      expect(ids.sort()).toEqual(all.map((b) => b.id).sort());
    },
  );
});
