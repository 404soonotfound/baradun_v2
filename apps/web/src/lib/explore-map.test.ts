import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isExploreView,
  readExploreViewForTest,
  resetExploreViewForTest,
  setExploreView,
} from "./explore-view";
import { shortName } from "./map/short-name";

// 탐색 지도(BRD-30): 마커 짧은 이름, [목록 | 지도] 기기 저장

describe("shortName", () => {
  it("해수욕장·해변·Beach 꼬리말을 뗀다", () => {
    expect(shortName("강문해수욕장")).toBe("강문");
    expect(shortName("인구해변")).toBe("인구");
    expect(shortName("Gangmun Beach")).toBe("Gangmun");
  });

  it("꼬리말이 없으면 그대로(앞뒤 공백만 정리)", () => {
    expect(shortName("문암2리")).toBe("문암2리");
    expect(shortName("  송정  ")).toBe("송정");
  });

  it("이름이 꼬리말뿐이면 빈 글자로 만들지 않는다", () => {
    expect(shortName("해수욕장")).toBe("해수욕장");
    expect(shortName("Beach")).toBe("Beach");
  });
});

// 메모리 저장소 흉내
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

describe("explore-view 저장", () => {
  beforeEach(() => resetExploreViewForTest());
  afterEach(() => vi.unstubAllGlobals());

  it("값 검사: list·map만", () => {
    expect(isExploreView("list")).toBe(true);
    expect(isExploreView("map")).toBe(true);
    expect(isExploreView("grid")).toBe(false);
    expect(isExploreView(null)).toBe(false);
  });

  it("저장한 값을 읽고, 저장값이 없거나 모르는 값이면 지도(처음 보기, BRD-128)", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(readExploreViewForTest()).toBe("map");
    setExploreView("list");
    expect(readExploreViewForTest()).toBe("list");

    resetExploreViewForTest();
    vi.stubGlobal(
      "localStorage",
      memoryStorage({ "baradun:explore-view": "grid" }),
    );
    expect(readExploreViewForTest()).toBe("map");
  });

  it("읽기가 막힌 환경이면 메모리 값", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readExploreViewForTest()).toBe("map");
    setExploreView("list");
    expect(readExploreViewForTest()).toBe("list");
  });

  it("쓰기가 실패하면 저장소의 옛 값이 방금 고른 값을 덮지 않는다", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => "map",
      setItem: () => {
        throw new Error("quota");
      },
    });
    setExploreView("list");
    expect(readExploreViewForTest()).toBe("list");
  });
});
