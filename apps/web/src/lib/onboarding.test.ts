import { describe, expect, it, vi } from "vitest";

import {
  acknowledgeNotice,
  clearOnboarding,
  createOnboardingStore,
  locationDecided,
  NOTICE_VERSION,
  onboardingStep,
  parseRecord,
  showsResetNotice,
  type OnboardingRecord,
} from "./onboarding";

// 첫 실행 기록 (BRD-25)

const done: OnboardingRecord = {
  noticeVersion: NOTICE_VERSION,
  acknowledgedAt: "2026-10-27T05:00:00.000Z",
  locationStepDone: true,
};

describe("onboardingStep", () => {
  it("기록이 없거나 고지 버전이 다르면 고지(ON-1)부터", () => {
    expect(onboardingStep(null, "idle")).toBe("notice");
    expect(
      onboardingStep({ ...done, noticeVersion: NOTICE_VERSION - 1 }, "ready"),
    ).toBe("notice");
    expect(
      onboardingStep({ ...done, noticeVersion: NOTICE_VERSION + 1 }, "denied"),
    ).toBe("notice");
  });

  it("고지를 확인했고 위치를 아직 묻지 않았으면 위치 안내(ON-2)", () => {
    expect(onboardingStep({ ...done, locationStepDone: false }, "idle")).toBe(
      "location",
    );
  });

  it("권한을 확인하는 중이면 덮지 않고 기다림(앱을 열 때마다 잠깐 뜨지 않게)", () => {
    expect(
      onboardingStep({ ...done, locationStepDone: false }, "checking"),
    ).toBeNull();
    expect(onboardingStep(null, "checking")).toBe("notice");
  });

  it("위치 권한을 이미 정한 기기나 ON-2를 지난 기기는 덮지 않음", () => {
    const notDone = { ...done, locationStepDone: false };
    expect(onboardingStep(notDone, "denied")).toBeNull();
    expect(onboardingStep(notDone, "ready")).toBeNull();
    expect(onboardingStep(notDone, "locating")).toBeNull();
    expect(onboardingStep(notDone, "unavailable")).toBeNull();
    expect(onboardingStep(done, "idle")).toBeNull();
  });
});

describe("locationDecided", () => {
  it("받는 중·허용·거부·받을 수 없음은 정한 것, 확인 중·아직 안 물음은 아님", () => {
    expect(locationDecided("locating")).toBe(true);
    expect(locationDecided("ready")).toBe(true);
    expect(locationDecided("denied")).toBe(true);
    expect(locationDecided("unavailable")).toBe(true);
    expect(locationDecided("checking")).toBe(false);
    expect(locationDecided("idle")).toBe(false);
  });
});

describe("parseRecord", () => {
  it("모양이 맞으면 그대로", () => {
    expect(parseRecord(JSON.stringify(done))).toEqual(done);
  });

  it("깨졌거나 칸이 틀리면 null(고지를 다시 보여줌)", () => {
    expect(parseRecord(null)).toBeNull();
    expect(parseRecord("{")).toBeNull();
    expect(parseRecord("null")).toBeNull();
    expect(
      parseRecord(JSON.stringify({ ...done, noticeVersion: "1" })),
    ).toBeNull();
    expect(
      parseRecord(JSON.stringify({ ...done, noticeVersion: 1.5 })),
    ).toBeNull();
    expect(
      parseRecord(JSON.stringify({ ...done, acknowledgedAt: "어제" })),
    ).toBeNull();
    expect(
      parseRecord(JSON.stringify({ ...done, locationStepDone: "true" })),
    ).toBeNull();
  });
});

describe("createOnboardingStore", () => {
  it("확인하면 지금 버전과 시각을 저장하고, ON-2를 고르면 지남으로 바꿈", () => {
    let stored: string | null = null;
    vi.stubGlobal("localStorage", {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    });
    try {
      const store = createOnboardingStore("test:onboarding");
      store.acknowledge("2026-10-27T05:00:00.000Z");
      expect(store.read()).toEqual({ ...done, locationStepDone: false });
      store.finishLocationStep();
      expect(store.read()).toEqual(done);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("고지 버전이 바뀌어 다시 확인해도 ON-2를 지난 기록은 남김", () => {
    let stored: string | null = JSON.stringify({
      ...done,
      noticeVersion: NOTICE_VERSION - 1,
    });
    vi.stubGlobal("localStorage", {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    });
    try {
      const store = createOnboardingStore("test:onboarding");
      store.acknowledge("2026-10-27T06:00:00.000Z");
      expect(store.read()).toEqual({
        ...done,
        acknowledgedAt: "2026-10-27T06:00:00.000Z",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("고지 확인 기록이 없으면 ON-2를 지남으로 바꾸지 않음", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("호출되면 안 됨");
      },
    });
    try {
      const store = createOnboardingStore("test:onboarding");
      store.finishLocationStep();
      expect(store.read()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("읽기는 되고 쓰기만 막힌 저장소에서도 확인한 기록을 이번 방문 동안 유지(덮개가 닫힘)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    try {
      const store = createOnboardingStore("test:onboarding");
      store.acknowledge("2026-10-27T05:00:00.000Z");
      store.finishLocationStep();
      expect(store.read()).toEqual(done);
      expect(onboardingStep(store.read(), "idle")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("저장소를 아예 못 쓰면 memory 값을 읽음", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    });
    try {
      const store = createOnboardingStore("test:onboarding");
      expect(store.read()).toBeNull();
      store.acknowledge("2026-10-27T05:00:00.000Z");
      expect(store.read()).toEqual({ ...done, locationStepDone: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("저장된 글자가 같으면 같은 객체(화면이 불필요하게 다시 그려지지 않게)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify(done),
      setItem: () => {},
    });
    try {
      const store = createOnboardingStore("test:onboarding");
      expect(store.read()).toBe(store.read());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("기기 데이터 초기화 결과 알림 (BRD-36)", () => {
  it("초기화로 지우면 ON-1에 결과를 보이고, 확인하면 감춤. 다른 이유로 지우면 보이지 않음", () => {
    // 저장소를 못 써도(테스트 환경) 메모리로 이어감
    expect(showsResetNotice()).toBe(false);
    clearOnboarding({ afterReset: true });
    expect(showsResetNotice()).toBe(true);
    acknowledgeNotice();
    expect(showsResetNotice()).toBe(false);
    clearOnboarding({ afterReset: true });
    clearOnboarding();
    expect(showsResetNotice()).toBe(false);
  });
});
