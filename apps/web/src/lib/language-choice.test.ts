import { describe, expect, it } from "vitest";

import {
  basePath,
  deviceLocale,
  languageSwitchHref,
  noticeTarget,
} from "./language-choice";

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

describe("languageSwitchHref", () => {
  it("언어 접두어만 바꾸고 검색어(?q=)를 그대로 둠", () => {
    expect(languageSwitchHref("en", "/search/", "q=%EA%B2%BD%ED%8F%AC")).toBe(
      "/en/search/?q=%EA%B2%BD%ED%8F%AC",
    );
    expect(languageSwitchHref("ko", "/en/search/", "q=gyeongpo")).toBe(
      "/search/?q=gyeongpo",
    );
  });

  it("문의 화면의 해변·활동 맥락 등 매개변수 여러 개를 순서대로 둠", () => {
    expect(
      languageSwitchHref(
        "en",
        "/settings/inquiry/",
        "beach=gangmun&activity=swim",
      ),
    ).toBe("/en/settings/inquiry/?beach=gangmun&activity=swim");
  });

  it("매개변수가 없거나 '?'만 오면 '?'를 붙이지 않음", () => {
    expect(languageSwitchHref("en", "/", "")).toBe("/en/");
    expect(languageSwitchHref("ko", "/en", "")).toBe("/");
    expect(languageSwitchHref("en", "/explore/", "?")).toBe("/en/explore/");
  });

  it("앞에 '?'가 붙은 값도 한 번만 붙임", () => {
    expect(languageSwitchHref("en", "/favorites/", "?tab=recent")).toBe(
      "/en/favorites/?tab=recent",
    );
  });
});
