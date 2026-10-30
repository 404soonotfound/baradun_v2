import { describe, expect, it, vi } from "vitest";

import {
  createLocationStore,
  deviceLocationGuide,
  locationBlocked,
  locationGuide,
  locationRetrying,
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

  it("스위치를 다시 켜 새 권한 객체가 오면 이전 객체의 변경 처리기는 뗌", async () => {
    type Status = { state: PermissionState; onchange: null | (() => void) };
    const statuses: Status[] = [];
    const fake = fakeNavigator({
      query: () => {
        const status: Status = { state: "prompt", onchange: null };
        statuses.push(status);
        return Promise.resolve(status);
      },
    });
    vi.stubGlobal("navigator", fake.navigator);
    try {
      const store = createLocationStore(() => fakeSwitch().storage);
      store.subscribe(() => {});
      await flush();
      store.setEnabled(false);
      store.setEnabled(true);
      await flush();
      expect(statuses).toHaveLength(2);
      expect(statuses[0]!.onchange).toBeNull();
      expect(statuses[1]!.onchange).toBeTypeOf("function");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("꺼짐이면 다시 시도도 요청하지 않음", async () => {
    const fake = fakeNavigator({
      query: () => Promise.resolve({ state: "denied", onchange: null }),
    });
    vi.stubGlobal("navigator", fake.navigator);
    try {
      const store = createLocationStore(() => fakeSwitch("off").storage);
      store.subscribe(() => {});
      await flush();
      store.retry();
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

describe("거부 상태의 다시 시도 (BRD-139)", () => {
  type Answer =
    | { kind: "allow"; latitude: number; longitude: number }
    | { kind: "fail"; code: 1 | 2 | 3 };
  // 권한 확인은 거부, 위치 요청의 답은 answers 순서대로. hold면 pending에 쌓아 두고 나중에 답함
  function deniedNavigator(answers: Answer[], hold = false) {
    const status: { state: PermissionState; onchange: null | (() => void) } = {
      state: "denied",
      onchange: null,
    };
    const pending: (() => void)[] = [];
    const getCurrentPosition = vi.fn(
      (
        success: (position: {
          coords: { latitude: number; longitude: number };
        }) => void,
        failure: (error: { code: number; PERMISSION_DENIED: 1 }) => void,
      ) => {
        const next = answers.shift();
        const answer = () => {
          if (next?.kind === "allow") success({ coords: next });
          else if (next?.kind === "fail")
            failure({ code: next.code, PERMISSION_DENIED: 1 });
        };
        if (hold) pending.push(answer);
        else answer();
      },
    );
    return {
      navigator: {
        permissions: { query: () => Promise.resolve(status) },
        geolocation: { getCurrentPosition },
      },
      status,
      getCurrentPosition,
      pending,
    };
  }

  async function deniedStore(fake: ReturnType<typeof deniedNavigator>) {
    vi.stubGlobal("navigator", fake.navigator);
    const store = createLocationStore(() => fakeSwitch().storage);
    store.subscribe(() => {});
    await flush();
    expect(store.getState().status).toBe("denied");
    return store;
  }

  it("앱을 열고 권한을 확인할 때는 거부면 요청하지 않음(다시 시도를 눌러야 요청)", async () => {
    const fake = deniedNavigator([]);
    try {
      const store = await deniedStore(fake);
      store.request(); // 위치 버튼·정렬 탭·'내 주변'이 부르는 요청
      fake.status.onchange?.(); // 권한 변경 알림(여전히 거부)
      await flush();
      expect(fake.getCurrentPosition).not.toHaveBeenCalled();
      expect(store.getState()).toEqual({ status: "denied", coords: null });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("거부 → 다시 시도 → 허용이면 위치를 받음", async () => {
    const fake = deniedNavigator([
      { kind: "allow", latitude: 37.79, longitude: 128.91 },
    ]);
    try {
      const store = await deniedStore(fake);
      store.retry();
      expect(fake.getCurrentPosition).toHaveBeenCalledTimes(1);
      expect(store.getState()).toEqual({
        status: "ready",
        coords: { lat: 37.79, lng: 128.91 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("거부 → 다시 시도 → 또 거부면 거부로 두고 '다시 시도했는데도 거부'를 알림", async () => {
    const fake = deniedNavigator([{ kind: "fail", code: 1 }]);
    try {
      const store = await deniedStore(fake);
      store.retry();
      expect(store.getState()).toEqual({
        status: "denied",
        coords: null,
        retry: "denied",
      });
      expect(locationBlocked(store.getState().status)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("다시 시도가 위치를 알 수 없음·시간 초과로 끝나면 받을 수 없음(unavailable)", async () => {
    for (const code of [2, 3] as const) {
      const fake = deniedNavigator([{ kind: "fail", code }]);
      try {
        const store = await deniedStore(fake);
        store.retry();
        expect(store.getState()).toEqual({
          status: "unavailable",
          coords: null,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("답을 기다리는 동안은 두 번 요청하지 않고, 권한 변경 알림도 덮지 않음", async () => {
    const fake = deniedNavigator(
      [{ kind: "allow", latitude: 1, longitude: 2 }],
      true,
    );
    try {
      const store = await deniedStore(fake);
      store.retry();
      expect(locationRetrying(store.getState())).toBe(true);
      expect(store.getState().status).toBe("denied"); // 화면은 답이 오기 전까지 거부 그대로
      store.retry();
      store.request();
      // 묻는 창에서 허용하면 오는 알림. 여기서 또 요청하지 않음
      fake.status.state = "granted";
      fake.status.onchange?.();
      expect(fake.getCurrentPosition).toHaveBeenCalledTimes(1);
      fake.pending.forEach((answer) => answer());
      expect(store.getState()).toEqual({
        status: "ready",
        coords: { lat: 1, lng: 2 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("다시 시도로 위치를 받았을 때만 성공 처리를 한 번 부름(또 거부·받을 수 없음은 부르지 않음)", async () => {
    const allowed = deniedNavigator([
      { kind: "allow", latitude: 1, longitude: 2 },
    ]);
    try {
      const store = await deniedStore(allowed);
      const onSucceeded = vi.fn();
      store.retry(onSucceeded);
      expect(store.getState().status).toBe("ready");
      expect(onSucceeded).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
    for (const code of [1, 2, 3] as const) {
      const failed = deniedNavigator([{ kind: "fail", code }]);
      try {
        const store = await deniedStore(failed);
        const onSucceeded = vi.fn();
        store.retry(onSucceeded);
        expect(onSucceeded).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("다시 시도 중에 위치 사용을 끄면 늦게 온 위치는 버리고 성공 처리도 부르지 않음", async () => {
    const fake = deniedNavigator(
      [{ kind: "allow", latitude: 1, longitude: 2 }],
      true,
    );
    try {
      const store = await deniedStore(fake);
      const onSucceeded = vi.fn();
      store.retry(onSucceeded);
      store.setEnabled(false);
      fake.pending.forEach((answer) => answer());
      expect(store.getState().status).toBe("off");
      expect(onSucceeded).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("다시 시도 중에 위치 사용을 끄면 늦게 온 위치가 꺼짐을 덮지 않음", async () => {
    const fake = deniedNavigator(
      [{ kind: "allow", latitude: 1, longitude: 2 }],
      true,
    );
    try {
      const store = await deniedStore(fake);
      store.retry();
      store.setEnabled(false);
      fake.pending.forEach((answer) => answer());
      expect(store.getState()).toEqual({ status: "off", coords: null });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("거부가 아니면 다시 시도는 아무것도 안 함", async () => {
    const fake = fakeNavigator({
      query: () => Promise.resolve({ state: "prompt", onchange: null }),
    });
    vi.stubGlobal("navigator", fake.navigator);
    try {
      const store = createLocationStore(() => fakeSwitch().storage);
      store.subscribe(() => {});
      await flush();
      expect(store.getState().status).toBe("idle");
      store.retry();
      expect(fake.getCurrentPosition).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("locationGuide (BRD-139 · 사용자 결정 10/30)", () => {
  const IOS =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const IPAD =
    "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";

  it("아이폰·아이패드는 브라우저 종류와 상관없이 기기 설정 안내", () => {
    for (const ua of [
      `${IOS} Version/18.0 Mobile/15E148 Safari/604.1`, // Safari
      `${IOS} CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1`, // Chrome
      `${IOS} FxiOS/132.0 Mobile/15E148 Safari/605.1.15`, // Firefox
      `${IOS} EdgiOS/130.0.2849.80 Version/18.0 Mobile/15E148 Safari/604.1`, // Edge
      `${IOS} Version/18.0 Mobile/15E148 Safari/604.1 OPT/5.1.0`, // Opera
      `${IOS} Mobile/15E148 KAKAOTALK 25.0.0`, // 카카오톡 앱 안 브라우저
      `${IOS} Mobile/15E148 Safari/605.1 NAVER(inapp; search; 2000; 12.10.0)`, // 네이버 앱 안 브라우저
      `${IOS} Mobile/15E148`, // 홈 화면에 추가한 앱
      `${IPAD} Version/18.0 Mobile/15E148 Safari/604.1`, // 아이패드 모바일 보기
    ]) {
      expect(locationGuide(ua, 5), ua).toBe("ios");
    }
    // 아이패드 데스크톱 보기(Mac처럼 보이지만 터치가 됨): Safari·Chrome
    expect(locationGuide(`${MAC} Version/18.0 Safari/605.1.15`, 5)).toBe("ios");
    expect(
      locationGuide(`${MAC} CriOS/130.0 Version/18.0 Safari/604.1`, 5),
    ).toBe("ios");
  });

  it("Mac·안드로이드·Windows·빈 값은 브라우저 사이트 설정 안내", () => {
    expect(locationGuide(`${MAC} Version/18.0 Safari/605.1.15`, 0)).toBe(
      "browser",
    );
    expect(
      locationGuide(
        "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
        5,
      ),
    ).toBe("browser");
    expect(
      locationGuide(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        10,
      ),
    ).toBe("browser");
    expect(locationGuide("", 0)).toBe("browser");
  });

  it("navigator를 못 읽으면 일반 안내", () => {
    vi.stubGlobal("navigator", undefined);
    try {
      expect(deviceLocationGuide()).toBe("browser");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
