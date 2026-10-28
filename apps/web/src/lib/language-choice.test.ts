import { describe, expect, it } from "vitest";

import { basePath, deviceLocale, noticeTarget } from "./language-choice";

// 첫 방문 언어 안내 (BRD-48 · 디자인 시스템 8절): 자동 이동 없이 한 번만 안내
describe("deviceLocale", () => {
  it("첫 번째 기기 언어의 앞부분으로 지원 언어를 고름", () => {
    expect(deviceLocale(["en-US", "ko-KR"])).toBe("en");
    expect(deviceLocale(["ko-KR", "en-US"])).toBe("ko");
    expect(deviceLocale(["EN"])).toBe("en");
  });

  it("지원하지 않는 언어가 먼저면 안내하지 않음(두 번째 언어로 넘어가지 않음)", () => {
    expect(deviceLocale(["ja-JP", "en-US"])).toBeNull();
  });

  it("기기 언어 목록이 비었거나 빈 글자면 모름", () => {
    expect(deviceLocale([])).toBeNull();
    expect(deviceLocale([""])).toBeNull();
  });
});

describe("noticeTarget", () => {
  it("기기 언어와 주소 언어가 다르고 아직 고르지 않았으면 기기 언어로 안내", () => {
    expect(noticeTarget("ko", "en", null)).toBe("en");
    expect(noticeTarget("en", "ko", null)).toBe("ko");
  });

  it("같은 언어면 안내하지 않음", () => {
    expect(noticeTarget("ko", "ko", null)).toBeNull();
  });

  it("한 번 고른 뒤(어느 언어든)에는 다시 안내하지 않음", () => {
    expect(noticeTarget("ko", "en", "ko")).toBeNull();
    expect(noticeTarget("ko", "en", "en")).toBeNull();
  });

  it("기기 언어를 모르면(서버 렌더·지원 안 함) 안내하지 않음", () => {
    expect(noticeTarget("ko", null, null)).toBeNull();
  });
});

describe("basePath", () => {
  it("영어 주소의 /en 접두어를 뺌", () => {
    expect(basePath("/en/spots/gangmun/")).toBe("/spots/gangmun/");
    expect(basePath("/en/")).toBe("/");
    expect(basePath("/en")).toBe("/");
  });

  it("한국어 주소는 그대로, /en으로 시작하는 다른 단어는 건드리지 않음", () => {
    expect(basePath("/explore/")).toBe("/explore/");
    expect(basePath("/english/")).toBe("/english/");
  });
});
