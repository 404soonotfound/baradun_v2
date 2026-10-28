import { describe, expect, it } from "vitest";

import { boundsOf, KOREA_BOUNDS } from "./bounds";
import { initialMapLoad, mapLoadReducer, type MapLoad } from "./map-load";
import {
  buildMapStyle,
  OPENFREEMAP_TILEJSON,
  PINNED_TILES_VERSION,
  TILE_SOURCE_ID,
  tileModeFor,
} from "./style";
import lightStyle from "./style-light.json";

// 지도 스타일·범위·불러오기 상태 (BRD-65)

function labelFields(style: ReturnType<typeof buildMapStyle>) {
  return style.layers.flatMap((layer) =>
    layer.type === "symbol" && layer.layout?.["text-field"]
      ? [JSON.stringify(layer.layout["text-field"])]
      : [],
  );
}

describe("buildMapStyle", () => {
  it("운영(pinned)은 검증한 타일 판 주소로 고정하고 TileJSON(최신)을 부르지 않는다", () => {
    const style = buildMapStyle({
      locale: "ko",
      tiles: "pinned",
      theme: "light",
    });
    const source = style.sources[TILE_SOURCE_ID];
    expect(source).toEqual({
      type: "vector",
      tiles: [
        `https://tiles.openfreemap.org/planet/${PINNED_TILES_VERSION}/{z}/{x}/{y}.pbf`,
      ],
      minzoom: 0,
      maxzoom: 14,
    });
    expect(JSON.stringify(style)).not.toContain(`"${OPENFREEMAP_TILEJSON}"`);
  });

  it("개발(latest)은 최신 TileJSON을 쓴다", () => {
    const style = buildMapStyle({
      locale: "ko",
      tiles: "latest",
      theme: "light",
    });
    expect(style.sources[TILE_SOURCE_ID]).toEqual({
      type: "vector",
      url: OPENFREEMAP_TILEJSON,
    });
  });

  it("타일 출처는 OpenFreeMap 하나뿐이다(다른 지도 서버로 요청하지 않음)", () => {
    const style = buildMapStyle({
      locale: "ko",
      tiles: "pinned",
      theme: "light",
    });
    expect(Object.keys(style.sources)).toEqual([TILE_SOURCE_ID]);
    expect(style.glyphs).toMatch(/^https:\/\/tiles\.openfreemap\.org\//);
    expect(String(style.sprite)).toMatch(
      /^https:\/\/tiles\.openfreemap\.org\//,
    );
  });

  it("한국어 라벨은 name:ko → name 순서", () => {
    const fields = labelFields(
      buildMapStyle({ locale: "ko", tiles: "pinned", theme: "light" }),
    );
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field).toBe('["coalesce",["get","name:ko"],["get","name"]]');
    }
  });

  it("영어 라벨은 name:en → name:latin → name 순서", () => {
    const fields = labelFields(
      buildMapStyle({ locale: "en", tiles: "pinned", theme: "light" }),
    );
    for (const field of fields) {
      expect(field).toBe(
        '["coalesce",["get","name:en"],["get","name:latin"],["get","name"]]',
      );
    }
  });

  it("도로 번호 표지·작은 도로 이름·공항 아이콘 레이어는 없다(해변 마커와 겹치지 않게)", () => {
    const ids = buildMapStyle({
      locale: "ko",
      tiles: "pinned",
      theme: "light",
    }).layers.map((layer) => layer.id);
    for (const removed of [
      "highway-shield-non-us",
      "highway-name-minor",
      "highway-name-path",
      "airport",
    ]) {
      expect(ids).not.toContain(removed);
    }
  });

  it("원본 스타일 JSON을 고치지 않는다", () => {
    const before = JSON.stringify(lightStyle);
    buildMapStyle({ locale: "en", tiles: "pinned", theme: "light" });
    expect(JSON.stringify(lightStyle)).toBe(before);
  });
});

describe("tileModeFor", () => {
  it("production만 고정 판, 그 밖(개발·없음)은 최신", () => {
    expect(tileModeFor("production")).toBe("pinned");
    expect(tileModeFor("development")).toBe("latest");
    expect(tileModeFor("test")).toBe("latest");
    expect(tileModeFor(undefined)).toBe("latest");
  });
});

describe("boundsOf", () => {
  it("해변 좌표를 감싸는 [서남, 동북] 상자", () => {
    expect(
      boundsOf([
        { lat: 37.8, lng: 128.9 },
        { lat: 35.1, lng: 129.2 },
        { lat: 33.4, lng: 126.3 },
      ]),
    ).toEqual([
      [126.3, 33.4],
      [129.2, 37.8],
    ]);
  });

  it("해변이 없으면 남한 범위", () => {
    expect(boundsOf([])).toEqual(KOREA_BOUNDS);
  });

  it("숫자가 아니거나 범위 밖 좌표는 빼고, 남는 게 없으면 남한 범위", () => {
    expect(
      boundsOf([
        { lat: Number.NaN, lng: 128 },
        { lat: 37, lng: Number.POSITIVE_INFINITY },
        { lat: 95, lng: 128 },
      ]),
    ).toEqual(KOREA_BOUNDS);
    expect(
      boundsOf([
        { lat: Number.NaN, lng: 128 },
        { lat: 37.5, lng: 129 },
      ]),
    ).toEqual([
      [129, 37.5],
      [129, 37.5],
    ]);
  });
});

describe("mapLoadReducer", () => {
  const loading1: MapLoad = { phase: "loading", attempt: 1 };

  it("처음 보이면 1번째 시도로 불러오고, 다시 보여도 새로 시작하지 않는다", () => {
    const started = mapLoadReducer(initialMapLoad, { type: "visible" });
    expect(started).toEqual(loading1);
    expect(mapLoadReducer(started, { type: "visible" })).toBe(started);
  });

  it("보이기 전에는 성공·실패·다시 시도 알림을 받지 않는다", () => {
    expect(mapLoadReducer(initialMapLoad, { type: "ready", attempt: 0 })).toBe(
      initialMapLoad,
    );
    expect(mapLoadReducer(initialMapLoad, { type: "failed", attempt: 0 })).toBe(
      initialMapLoad,
    );
    expect(mapLoadReducer(initialMapLoad, { type: "retry" })).toBe(
      initialMapLoad,
    );
  });

  it("불러오는 중 → 성공 / 실패", () => {
    expect(mapLoadReducer(loading1, { type: "ready", attempt: 1 })).toEqual({
      phase: "ready",
      attempt: 1,
    });
    expect(mapLoadReducer(loading1, { type: "failed", attempt: 1 })).toEqual({
      phase: "failed",
      attempt: 1,
    });
  });

  it("다 그린 뒤 타일이 끊기면 지도만 실패 상태가 된다", () => {
    const ready = mapLoadReducer(loading1, { type: "ready", attempt: 1 });
    expect(mapLoadReducer(ready, { type: "failed", attempt: 1 })).toEqual({
      phase: "failed",
      attempt: 1,
    });
  });

  it("실패한 뒤 늦게 온 성공은 실패를 정상으로 바꾸지 않는다", () => {
    const failed = mapLoadReducer(loading1, { type: "failed", attempt: 1 });
    expect(mapLoadReducer(failed, { type: "ready", attempt: 1 })).toBe(failed);
  });

  it("다시 시도하면 새 시도 번호로 불러오고, 지난 시도의 늦은 알림은 무시한다", () => {
    const failed = mapLoadReducer(loading1, { type: "failed", attempt: 1 });
    const retry = mapLoadReducer(failed, { type: "retry" });
    expect(retry).toEqual({ phase: "loading", attempt: 2 });
    expect(mapLoadReducer(retry, { type: "ready", attempt: 1 })).toBe(retry);
    expect(mapLoadReducer(retry, { type: "failed", attempt: 1 })).toBe(retry);
    expect(mapLoadReducer(retry, { type: "ready", attempt: 2 })).toEqual({
      phase: "ready",
      attempt: 2,
    });
  });

  it("불러오는 중·성공 중에는 다시 시도를 받지 않는다(지도를 겹쳐 만들지 않음)", () => {
    expect(mapLoadReducer(loading1, { type: "retry" })).toBe(loading1);
    const ready = mapLoadReducer(loading1, { type: "ready", attempt: 1 });
    expect(mapLoadReducer(ready, { type: "retry" })).toBe(ready);
  });
});
