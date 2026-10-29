import { describe, expect, it } from "vitest";

import { boundsOf, KOREA_BOUNDS } from "./bounds";
import {
  createTileErrorCounter,
  initialMapLoad,
  mapLoadReducer,
  TILE_ERROR_LIMIT,
  type MapLoad,
} from "./map-load";
import {
  buildMapStyle,
  OPENFREEMAP_TILEJSON,
  PINNED_TILES_VERSION,
  TILE_SOURCE_ID,
  tileModeFor,
} from "./style";
import tokens from "../../../tokens/tokens.json";
import darkStyle from "./style-dark.json";
import lightStyle from "./style-light.json";

// 지도 스타일·범위·불러오기 상태 (BRD-65 · 다크 BRD-44)

function labelFields(style: ReturnType<typeof buildMapStyle>) {
  return style.layers.flatMap((layer) =>
    layer.type === "symbol" && layer.layout?.["text-field"]
      ? [JSON.stringify(layer.layout["text-field"])]
      : [],
  );
}

describe.each(["light", "dark"] as const)("buildMapStyle(%s)", (theme) => {
  it("운영(pinned)은 검증한 타일 판 주소로 고정하고 TileJSON(최신)을 부르지 않는다", () => {
    const style = buildMapStyle({ locale: "ko", tiles: "pinned", theme });
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
    const style = buildMapStyle({ locale: "ko", tiles: "latest", theme });
    expect(style.sources[TILE_SOURCE_ID]).toEqual({
      type: "vector",
      url: OPENFREEMAP_TILEJSON,
    });
  });

  it("타일 출처는 OpenFreeMap 하나뿐이다(다른 지도 서버로 요청하지 않음)", () => {
    const style = buildMapStyle({ locale: "ko", tiles: "pinned", theme });
    expect(Object.keys(style.sources)).toEqual([TILE_SOURCE_ID]);
    expect(style.glyphs).toMatch(/^https:\/\/tiles\.openfreemap\.org\//);
    expect(String(style.sprite)).toMatch(
      /^https:\/\/tiles\.openfreemap\.org\//,
    );
  });

  it("한국어 라벨은 name:ko → name 순서", () => {
    const fields = labelFields(
      buildMapStyle({ locale: "ko", tiles: "pinned", theme }),
    );
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field).toBe('["coalesce",["get","name:ko"],["get","name"]]');
    }
  });

  it("영어 라벨은 name:en → name:latin → name 순서", () => {
    const fields = labelFields(
      buildMapStyle({ locale: "en", tiles: "pinned", theme }),
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
      theme,
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
    const before = JSON.stringify([lightStyle, darkStyle]);
    buildMapStyle({ locale: "en", tiles: "pinned", theme });
    expect(JSON.stringify([lightStyle, darkStyle])).toBe(before);
  });
});

// 다크 지도 (BRD-44): 라이트 포크와 같은 원칙(같은 레이어·라벨·출처), 색만 다름
// 라이트·다크 레이어 타입이 다를 수 있어(다크에만 있는 색 칸, 예: 도로 이름 halo) 공통 모양으로 받음
function withoutColors(layer: { paint?: object }) {
  const paint = Object.fromEntries(
    Object.entries(layer.paint ?? {}).filter(([key]) => !key.includes("color")),
  );
  return { ...layer, paint };
}

function luminance(hex: string) {
  const weights = [0.2126, 0.7152, 0.0722];
  return weights.reduce((sum, weight, index) => {
    const c = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    const linear = c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return sum + weight * linear;
  }, 0);
}
function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function paintColor(
  style: { layers: readonly { id: string; paint?: unknown }[] },
  id: string,
  key: string,
) {
  const layer = style.layers.find((item) => item.id === id);
  return (layer?.paint as Record<string, unknown> | undefined)?.[key] as string;
}

describe("style-dark.json", () => {
  it("라이트와 레이어 순서·필터·글자 설정·출처가 같고 색만 다르다", () => {
    expect(darkStyle.sources).toEqual(lightStyle.sources);
    expect(darkStyle.glyphs).toBe(lightStyle.glyphs);
    expect(darkStyle.sprite).toBe(lightStyle.sprite);
    expect(darkStyle.layers.map(withoutColors)).toEqual(
      lightStyle.layers.map(withoutColors),
    );
  });

  it("모든 색 칸을 다크 값으로 바꿨다(라이트 색이 남지 않음)", () => {
    lightStyle.layers.forEach((layer, index) => {
      const dark = darkStyle.layers[index]?.paint as Record<string, unknown>;
      for (const [key, value] of Object.entries(layer.paint ?? {})) {
        if (key.includes("color")) expect(dark[key]).not.toEqual(value);
      }
    });
  });

  it("다크 토큰 마커(상태 원·점선)가 다크 지도의 땅·바다 위에서 3:1 이상 보인다", () => {
    const land = paintColor(darkStyle, "background", "background-color");
    const water = paintColor(darkStyle, "water", "fill-color");
    const status = tokens.color.status;
    const dark = (token: { $extensions: { baradun: { dark: string } } }) =>
      token.$extensions.baradun.dark;
    // 채운 원(특보 없음·이용불가)은 채움 색, 판단불가 원은 점선 색이 지도와 떨어져 보여야 함
    for (const marker of [
      dark(status.clear.fg),
      dark(status.blocked.fg),
      dark(status.unknown.border),
      dark(status.stale.border),
    ]) {
      expect(contrast(marker, land)).toBeGreaterThanOrEqual(3);
      expect(contrast(marker, water)).toBeGreaterThanOrEqual(3);
    }
  });

  it("지명 글자는 다크 땅 위에서 4.5:1 이상", () => {
    const land = paintColor(darkStyle, "background", "background-color");
    for (const id of ["label_city", "label_town", "label_village"]) {
      expect(
        contrast(paintColor(darkStyle, id, "text-color"), land),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  // 결정 기록 12장 결정 9: 지금 다크 지도 색을 대비 검사 뒤 정식 값으로 확정. 값이 바뀌면 이 시험이 다시 확인함
  it("도로 이름은 가장 밝은 다크 도로 위에서도 글자 뒤 바탕(halo)과 4.5:1 이상", () => {
    // 도로 이름은 도로 선 위에 그려짐(symbol-placement: line) → 바탕은 땅이 아니라 도로 면.
    // halo(반투명 어두운 바탕)를 가장 밝은 도로(고속도로 안쪽 선) 위에 겹친 색과 비교함
    const halo = paintColor(darkStyle, "highway-name-major", "text-halo-color");
    const [r, g, b, alpha] = (halo.match(/[\d.]+/g) ?? []).map(Number);
    const motorway = darkStyle.layers.find(
      (layer) => layer.id === "highway_motorway_inner",
    )?.paint as Record<string, unknown[]>;
    const roads = [
      motorway["line-color"]!.at(-1) as string, // 확대했을 때 값
      paintColor(darkStyle, "highway_major_inner", "line-color"),
    ];
    for (const road of roads) {
      const mixed = `#${[r, g, b]
        .map((channel, index) => {
          const under = parseInt(road.slice(1 + index * 2, 3 + index * 2), 16);
          return Math.round(channel! * alpha! + under * (1 - alpha!))
            .toString(16)
            .padStart(2, "0");
        })
        .join("")}`;
      expect(
        contrast(
          paintColor(darkStyle, "highway-name-major", "text-color"),
          mixed,
        ),
        road,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("바다 이름은 다크 바다 위에서 4.5:1 이상", () => {
    const water = paintColor(darkStyle, "water", "fill-color");
    expect(
      contrast(
        paintColor(darkStyle, "water_name_point_label", "text-color"),
        water,
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("다크 땅·바다는 라이트 지도만큼 구분된다(밝기 차이가 라이트보다 작지 않음)", () => {
    // 라이트 원본(Positron)은 rgb() 표기라 16진수로 바꿔 비교
    const hex = (rgb: string) =>
      `#${(rgb.match(/\d+/g) ?? [])
        .slice(0, 3)
        .map((part) => Number(part).toString(16).padStart(2, "0"))
        .join("")}`;
    const light = contrast(
      hex(paintColor(lightStyle, "background", "background-color")),
      hex(paintColor(lightStyle, "water", "fill-color")),
    );
    const dark = contrast(
      paintColor(darkStyle, "background", "background-color"),
      paintColor(darkStyle, "water", "fill-color"),
    );
    expect(dark).toBeGreaterThanOrEqual(light - 0.01);
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

describe("createTileErrorCounter (그린 뒤 타일 오류)", () => {
  it("한두 번 끊긴 것은 실패로 보지 않고, 연달아 정한 횟수가 되면 한 번 실패로 알림", () => {
    const counter = createTileErrorCounter();
    const results = Array.from({ length: TILE_ERROR_LIMIT + 1 }, () =>
      counter.error(),
    );
    expect(results).toEqual([false, false, true, false]);
  });

  it("그사이 타일을 받으면 처음부터 다시 셈", () => {
    const counter = createTileErrorCounter(3);
    counter.error();
    counter.error();
    counter.loaded();
    expect(counter.error()).toBe(false);
    expect(counter.error()).toBe(false);
    expect(counter.error()).toBe(true);
  });
});
