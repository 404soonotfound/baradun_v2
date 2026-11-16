import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeFavorite, toggleFavorite } from "./favorites";

// 즐겨찾기 빼기·되돌리기 (GH-530)

let stored: Record<string, string> = {};

beforeEach(() => {
  stored = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored[key] ?? null,
    setItem: (key: string, value: string) => {
      stored[key] = value;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function favorites(): string[] {
  return JSON.parse(stored["baradun:favorites"] ?? "[]") as string[];
}

describe("removeFavorite", () => {
  it("되돌리면 뺀 해변이 원래 자리로 돌아옴", () => {
    stored["baradun:favorites"] = '["b0001","b0002","b0003"]';
    const undo = removeFavorite("b0002");
    expect(favorites()).toEqual(["b0001", "b0003"]);
    undo();
    expect(favorites()).toEqual(["b0001", "b0002", "b0003"]);
  });

  it("토스트가 떠 있는 동안 넣은 해변을 되돌리기가 지우지 않음", () => {
    stored["baradun:favorites"] = '["b0001","b0002"]';
    const undo = removeFavorite("b0001");
    toggleFavorite("b0009"); // 최근 본 탭 빈 별로 넣기 = 맨 앞
    undo();
    expect(favorites()).toEqual(["b0001", "b0009", "b0002"]);
  });

  it("그사이 다시 넣었으면 되돌리기는 아무것도 하지 않음", () => {
    stored["baradun:favorites"] = '["b0001","b0002"]';
    const undo = removeFavorite("b0002");
    toggleFavorite("b0002");
    undo();
    expect(favorites()).toEqual(["b0002", "b0001"]);
  });

  it("목록에 없는 해변은 빼지도 되돌리지도 않음", () => {
    stored["baradun:favorites"] = '["b0001"]';
    const undo = removeFavorite("b0005");
    undo();
    expect(favorites()).toEqual(["b0001"]);
  });
});
