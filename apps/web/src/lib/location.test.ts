import { describe, expect, it, vi } from "vitest";

import { createLocationStore, permissionAction } from "./location";

// 위치 권한 상태 (BRD-25·26)

// 권한 확인 결과를 테스트에서 정하는 가짜 navigator
function fakeNavigator(options: {
  query?: () => Promise<{ state: PermissionState; onchange: unknown }>;
  position?: { latitude: number; longitude: number };
}) {
  const getCurrentPosition = vi.fn(
    (
      success: (position: {
        coords: { latitude: number; longitude: number };
      }) => void,
    ) => {
      if (options.position) success({ coords: options.position });
    },
  );
  return {
    navigator: {
      permissions: options.query ? { query: options.query } : undefined,
      geolocation: { getCurrentPosition },
    },
    getCurrentPosition,
  };
}

// 끝나지 않은 Promise 처리를 모두 돌림
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("permissionAction", () => {
  it("거부는 언제나 거부", () => {
    expect(permissionAction("checking", "denied")).toBe("denied");
    expect(permissionAction("ready", "denied")).toBe("denied");
  });

  it("확인 중에 허용이면 위치를 받고, 아직 안 물었으면 idle", () => {
    expect(permissionAction("checking", "granted")).toBe("locate");
    expect(permissionAction("checking", "prompt")).toBe("idle");
  });

  it("받는 중·받은 위치는 권한 변경 알림이 덮지 않음", () => {
    expect(permissionAction("locating", "granted")).toBe("keep");
    expect(permissionAction("locating", "prompt")).toBe("keep");
    expect(permissionAction("ready", "granted")).toBe("keep");
  });
});

describe("createLocationStore", () => {
  it("처음은 확인 중. 권한 확인 기능이 없으면 구독하자마자 idle", () => {
    const fake = fakeNavigator({});
    vi.stubGlobal("navigator", fake.navigator);
    try {
      const store = createLocationStore();
      expect(store.getState().status).toBe("checking");
      store.subscribe(() => {});
      expect(store.getState().status).toBe("idle");
      expect(fake.getCurrentPosition).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("권한 확인이 실패해도 확인 중으로 남지 않음(idle)", async () => {
    const fake = fakeNavigator({
      query: () => Promise.reject(new Error("TypeError")),
    });
    vi.stubGlobal("navigator", fake.navigator);
    try {
      const store = createLocationStore();
      store.subscribe(() => {});
      await flush();
      expect(store.getState().status).toBe("idle");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("이미 허용한 기기는 묻지 않고 위치를 받음", async () => {
    const fake = fakeNavigator({
      query: () => Promise.resolve({ state: "granted", onchange: null }),
      position: { latitude: 37.79, longitude: 128.91 },
    });
    vi.stubGlobal("navigator", fake.navigator);
    try {
      const store = createLocationStore();
      store.subscribe(() => {});
      await flush();
      expect(store.getState()).toEqual({
        status: "ready",
        coords: { lat: 37.79, lng: 128.91 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("거부한 기기는 버튼을 눌러도 다시 묻지 않음", async () => {
    const fake = fakeNavigator({
      query: () => Promise.resolve({ state: "denied", onchange: null }),
    });
    vi.stubGlobal("navigator", fake.navigator);
    try {
      const store = createLocationStore();
      store.subscribe(() => {});
      await flush();
      expect(store.getState().status).toBe("denied");
      store.request();
      expect(fake.getCurrentPosition).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("권한 확인 답이 오지 않으면 확인 중으로 남지 않음(idle)", () => {
    vi.useFakeTimers();
    const fake = fakeNavigator({ query: () => new Promise(() => {}) });
    vi.stubGlobal("navigator", fake.navigator);
    try {
      const store = createLocationStore();
      store.subscribe(() => {});
      expect(store.getState().status).toBe("checking");
      vi.advanceTimersByTime(3_000);
      expect(store.getState().status).toBe("idle");
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("권한 확인이 바로 오류를 던져도 idle", () => {
    const fake = fakeNavigator({
      query: () => {
        throw new TypeError("unsupported");
      },
    });
    vi.stubGlobal("navigator", fake.navigator);
    try {
      const store = createLocationStore();
      store.subscribe(() => {});
      expect(store.getState().status).toBe("idle");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
