import { describe, expect, it } from "vitest";
import { parseTheme, readStoredTheme, writeStoredTheme } from "./theme";
import { THEME_STORAGE_KEY } from "./theme-init";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    map,
  };
}

describe("parseTheme", () => {
  it("light와 dark만 그대로 돌려준다", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
  });

  it("system과 잘못된 값·빈 값은 모두 system으로 처리한다", () => {
    expect(parseTheme("system")).toBe("system");
    expect(parseTheme(null)).toBe("system");
    expect(parseTheme(undefined)).toBe("system");
    expect(parseTheme("")).toBe("system");
    expect(parseTheme("LIGHT")).toBe("system");
    expect(parseTheme("sepia")).toBe("system");
  });
});

describe("readStoredTheme", () => {
  it("저장소에 저장된 light·dark를 읽고, 없거나 잘못된 값은 system을 돌려준다", () => {
    expect(readStoredTheme(memoryStorage())).toBe("system");
    expect(
      readStoredTheme(memoryStorage({ [THEME_STORAGE_KEY]: "light" })),
    ).toBe("light");
    expect(
      readStoredTheme(memoryStorage({ [THEME_STORAGE_KEY]: "dark" })),
    ).toBe("dark");
    expect(
      readStoredTheme(memoryStorage({ [THEME_STORAGE_KEY]: "invalid" })),
    ).toBe("system");
  });

  it("저장소 접근이 실패하면 system을 돌려준다", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(readStoredTheme(broken)).toBe("system");
    expect(readStoredTheme(null)).toBe("system");
  });
});

describe("writeStoredTheme", () => {
  it("light·dark는 저장하고, system이면 키를 지운다", () => {
    const store = memoryStorage();
    expect(writeStoredTheme("dark", store)).toBe(true);
    expect(store.map.get(THEME_STORAGE_KEY)).toBe("dark");

    expect(writeStoredTheme("light", store)).toBe(true);
    expect(store.map.get(THEME_STORAGE_KEY)).toBe("light");

    expect(writeStoredTheme("system", store)).toBe(true);
    expect(store.map.has(THEME_STORAGE_KEY)).toBe(false);
  });

  it("저장소 쓰기가 실패하면 false를 돌려준다", () => {
    const broken = {
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("quota");
      },
    };
    expect(writeStoredTheme("dark", broken)).toBe(false);
    expect(writeStoredTheme("system", broken)).toBe(false);
    expect(writeStoredTheme("light", null)).toBe(false);
  });
});
