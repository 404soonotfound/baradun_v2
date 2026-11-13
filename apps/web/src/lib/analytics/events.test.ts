import { afterEach, describe, expect, it, vi } from "vitest";
import { queryLengthBucket, trackEvent } from "./events";

describe("queryLengthBucket", () => {
  it("검색어 원문 대신 길이 구간만 반환함", () => {
    expect(queryLengthBucket("")).toBe("1");
    expect(queryLengthBucket("강")).toBe("1");
    expect(queryLengthBucket("강문")).toBe("2_3");
    expect(queryLengthBucket(" 해운 ")).toBe("2_3");
    expect(queryLengthBucket("해운대해수욕장")).toBe("4_plus");
  });
});

describe("trackEvent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("window.gtag가 없으면 전역 객체를 만들지 않고 조용히 끝남", () => {
    const win: Record<string, unknown> = {};
    vi.stubGlobal("window", win);

    trackEvent("select_activity", { activity: "surfing", surface: "home" });
    expect("gtag" in win).toBe(false);
    expect("dataLayer" in win).toBe(false);
  });

  it("window.gtag가 있으면 undefined 속성을 빼고 이벤트를 전송함", () => {
    const gtag = vi.fn();
    vi.stubGlobal("window", { gtag });

    trackEvent("inquiry_sent", {
      inquiry_type: "data_error",
      has_beach_context: false,
      activity: undefined,
    });

    expect(gtag).toHaveBeenCalledTimes(1);
    expect(gtag).toHaveBeenCalledWith("event", "inquiry_sent", {
      inquiry_type: "data_error",
      has_beach_context: false,
    });
  });

  it("gtag 호출이 예외를 던져도 화면 흐름으로 전파하지 않음", () => {
    const gtag = vi.fn(() => {
      throw new Error("gtag failed");
    });
    vi.stubGlobal("window", { gtag });

    expect(() =>
      trackEvent("change_setting", { setting: "reset_data" }),
    ).not.toThrow();
  });
});
