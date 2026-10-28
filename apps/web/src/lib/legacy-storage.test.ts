import { afterEach, describe, expect, it, vi } from "vitest";

import { clearLegacyStorage, LEGACY_FAVORITE_SEEN_KEY } from "./legacy-storage";

// 출시에서 뺀 즐겨찾기 변경 표시의 지난 방문 기록 정리 (BRD-101)

function memoryStorage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("clearLegacyStorage", () => {
  it("키가 있으면 그 키만 지움", () => {
    const local = memoryStorage({
      [LEGACY_FAVORITE_SEEN_KEY]: '{"b0001":null}',
      "baradun:favorites": '["b0001"]',
    });
    clearLegacyStorage(() => local.storage);
    expect(Object.fromEntries(local.map)).toEqual({
      "baradun:favorites": '["b0001"]',
    });
  });

  it("키가 없어도, 여러 번 불러도 그대로 끝남", () => {
    const local = memoryStorage({ "baradun:recent": '["b0002"]' });
    clearLegacyStorage(() => local.storage);
    clearLegacyStorage(() => local.storage);
    expect(Object.fromEntries(local.map)).toEqual({
      "baradun:recent": '["b0002"]',
    });
  });

  it("저장소를 꺼내거나 지우다 실패해도 오류를 내지 않음", () => {
    expect(() =>
      clearLegacyStorage(() => {
        throw new Error("blocked");
      }),
    ).not.toThrow();
    expect(() =>
      clearLegacyStorage(() => ({
        removeItem: () => {
          throw new Error("blocked");
        },
      })),
    ).not.toThrow();
  });

  it("정리 뒤 즐겨찾기·최근 본을 쓰고 초기화해도 키가 다시 생기지 않음", async () => {
    const local = memoryStorage({ [LEGACY_FAVORITE_SEEN_KEY]: "{}" });
    vi.stubGlobal("localStorage", local.storage);
    vi.stubGlobal("sessionStorage", memoryStorage({}).storage);
    vi.stubGlobal("window", {
      localStorage: local.storage,
      sessionStorage: memoryStorage({}).storage,
    });

    clearLegacyStorage();
    const favorites = await import("./favorites");
    favorites.toggleFavorite("b0001");
    favorites.addRecent("b0002");
    favorites.removeRecent("b0002")();
    favorites.clearRecent()();
    favorites.clearFavoritesAndRecent();

    expect(local.map.has(LEGACY_FAVORITE_SEEN_KEY)).toBe(false);
    expect(local.map.get("baradun:favorites")).toBe("[]");
  });
});
