import { describe, expect, it, vi } from "vitest";

import {
  createLocationStore,
  locationBlocked,
  permissionAction,
  type SwitchStorage,
} from "./location";

// 위치 권한 상태 (BRD-25·26)

// 권한 확인 결과를 테스트에서 정하는 가짜 navigator
function fakeNavigator(options: {
  query?: () => Promise<{ state: PermissionState; onchange: unknown }>;
  position?: { latitude: number; longitude: number };
  // true면 답을 바로 주지 않고 pending에 쌓아 둠(늦게 온 답 시험용)
  hold?: boolean;
}) {
  const pending: (() => void)[] = [];
  const getCurrentPosition = vi.fn(
    (
      success: (position: {
        coords: { latitude: number; longitude: number };
      }) => void,
    ) => {
      const answer = () => {
        if (options.position) success({ coords: options.position });
      };
      if (options.hold) pending.push(answer);
      else answer();
    },
  );
  return {
    navigator: {
      permissions: options.query ? { query: options.query } : undefined,
      geolocation: { getCurrentPosition },
    },
    getCurrentPosition,
    pending,
  };
}

// 스위치 저장소(메모리). throws면 모든 접근이 오류
function fakeSwitch(initial: string | null = null, throws = false) {
  let value = initial;
  const storage: SwitchStorage = {
    getItem: () => {
      if (throws) throw new Error("blocked");
      return value;
    },
    setItem: (_key, next) => {
      if (throws) throw new Error("blocked");
      value = next;
    },
    removeItem: () => {
      if (throws) throw new Error("blocked");
      value = null;
    },
  };
  return { storage, get: () => value };
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

describe("위치 사용 스위치 (BRD-36)", () => {
  it("거부·꺼짐은 다시 묻지 않는 상태", () => {
    expect(locationBlocked("denied")).toBe(true);
    expect(locationBlocked("off")).toBe(true);
    expect(locationBlocked("idle")).toBe(false);
    expect(locationBlocked("unavailable")).toBe(false);
  });

  it("저장값이 꺼짐이면 권한을 확인하지도 위치를 받지도 않음", async () => {
    const query = vi.fn(() =>
      Promise.resolve({ state: "granted" as PermissionState, onchange: null }),
    );
    const fake = fakeNavigator({
      query,
      position: { latitude: 1, longitude: 2 },
    });
    vi.stubGlobal("navigator", fake.navigator);
    try {
      const sw = fakeSwitch("off");
      const store = createLocationStore(() => sw.storage);
      store.subscribe(() => {});
      await flush();
      expect(store.getState().status).toBe("off");
      expect(query).not.toHaveBeenCalled();
      store.request(); // 버튼을 눌러도 묻지 않음
      expect(fake.getCurrentPosition).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("끄면 받은 위치를 버리고 저장, 켜면 권한만 다시 확인", async () => {
    const fake = fakeNavigator({
      query: () => Promise.resolve({ state: "granted", onchange: null }),
      position: { latitude: 37.79, longitude: 128.91 },
    });
    vi.stubGlobal("navigator", fake.navigator);
    try {
      const sw = fakeSwitch();
      const store = createLocationStore(() => sw.storage);
      store.subscribe(() => {});
      await flush();
      expect(store.getState().status).toBe("ready");

      store.setEnabled(false);
      expect(store.getState()).toEqual({ status: "off", coords: null });
      expect(sw.get()).toBe("off"); // LOCATION_SWITCH_KEY에 "off"

      store.setEnabled(true);
      expect(sw.get()).toBeNull();
      expect(store.getState().status).toBe("checking");
      await flush();
      expect(store.getState().status).toBe("ready");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("받는 중에 끄면 늦게 온 위치가 꺼짐을 덮지 않음", async () => {
    const fake = fakeNavigator({
      query: () => Promise.resolve({ state: "prompt", onchange: null }),
      position: { latitude: 1, longitude: 2 },
      hold: true,
    });
    vi.stubGlobal("navigator", fake.navigator);
    try {
      const store = createLocationStore(() => fakeSwitch().storage);
      store.subscribe(() => {});
      await flush();
      store.request();
      expect(store.getState().status).toBe("locating");
      store.setEnabled(false);
      fake.pending.forEach((answer) => answer());
      expect(store.getState().status).toBe("off");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("꺼 둔 동안 권한 변경 알림이 와도 위치를 받지 않음", async () => {
    const status: { state: PermissionState; onchange: null | (() => void) } = {
      state: "prompt",
      onchange: null,
    };
    const fake = fakeNavigator({
      query: () => Promise.resolve(status),
      position: { latitude: 1, longitude: 2 },
    });
    vi.stubGlobal("navigator", fake.navigator);
    try {
      const store = createLocationStore(() => fakeSwitch().storage);
      store.subscribe(() => {});
      await flush();
      store.setEnabled(false);
      status.state = "granted";
      status.onchange?.();
      expect(store.getState().status).toBe("off");
      expect(fake.getCurrentPosition).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("저장소를 못 써도 이번 방문 동안은 고른 값을 따름", async () => {
    const fake = fakeNavigator({});
    vi.stubGlobal("navigator", fake.navigator);
    try {
      const store = createLocationStore(() => fakeSwitch(null, true).storage);
      store.subscribe(() => {});
      expect(store.getState().status).toBe("idle");
      store.setEnabled(false);
      expect(store.getState().status).toBe("off");
      store.request();
      expect(fake.getCurrentPosition).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
