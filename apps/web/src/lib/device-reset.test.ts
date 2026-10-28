import { afterEach, describe, expect, it, vi } from "vitest";

// 기기 데이터 초기화 (BRD-36 · 결정 기록 11장 10/27 ⑩)

// 키 → 값 메모리 저장소
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

describe("resetDeviceData", () => {
  it("해변 기록은 모두 지우고 화면·위치 설정과 마지막 바다 정보는 남김", async () => {
    const local = memoryStorage({
      "baradun:favorites": '["b0001"]',
      "baradun:recent": '["b0002"]',
      "baradun:recent-search": '[{"q":"경포","id":null}]',
      "baradun:favorite-seen": "{}", // 출시에서 뺀 변경 표시가 남긴 값(BRD-101)
      "baradun:region": '{"sido":"강원","sigungu":null}',
      "baradun:onboarding":
        '{"noticeVersion":1,"acknowledgedAt":"2026-10-28T00:00:00Z","locationStepDone":true}',
      "baradun:activity": "surfing",
      "baradun:explore-view": "map",
      "baradun:explore-sort": "second",
      "baradun:inquiry-draft":
        '{"kind":"mismatch","message":"파고가 달라요","savedAt":"2026-10-28T00:00:00.000Z"}',
      // 남길 것
      "baradun:theme": "dark",
      "baradun:motion": "off",
      "baradun:location-switch": "off",
      "baradun:last-snapshot": "{}",
    });
    const session = memoryStorage({
      "baradun:tabs": '{"urls":{"explore":"/search/?q=경포"}}',
      "baradun:scroll": '{"/":120}',
    });
    vi.stubGlobal("localStorage", local.storage);
    vi.stubGlobal("sessionStorage", session.storage);
    vi.stubGlobal("window", {
      localStorage: local.storage,
      sessionStorage: session.storage,
    });

    const { resetDeviceData } = await import("./device-reset");
    resetDeviceData();

    // 목록 저장소(즐겨찾기·최근 본·최근 검색)는 빈 목록으로 덮어 지움, 나머지는 키를 지움
    expect(Object.fromEntries([...local.map].sort())).toEqual({
      "baradun:favorites": "[]",
      "baradun:last-snapshot": "{}",
      "baradun:location-switch": "off",
      "baradun:motion": "off",
      "baradun:recent": "[]",
      "baradun:recent-search": "[]",
      "baradun:theme": "dark",
    });
    expect(session.map.size).toBe(0);
  });

  it("저장소를 못 써도 오류 없이 끝남(각 저장소가 메모리 값으로 이어감)", async () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("localStorage", broken);
    vi.stubGlobal("sessionStorage", broken);
    vi.stubGlobal("window", { localStorage: broken, sessionStorage: broken });

    const { resetDeviceData } = await import("./device-reset");
    expect(() => resetDeviceData()).not.toThrow();
  });
});
