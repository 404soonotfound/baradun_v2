import { afterEach, describe, expect, it, vi } from "vitest";

import { parseSiteUrl, siteUrl } from "./site-url";

// 사이트 주소 필수 (BRD-102 결정 14): 운영 기본값 없이, 틀린 값은 빌드를 멈춤
describe("parseSiteUrl", () => {
  it("사이트 루트 절대 주소를 받는다", () => {
    expect(parseSiteUrl("https://example.test").href).toBe(
      "https://example.test/",
    );
    expect(parseSiteUrl("https://example.test/").href).toBe(
      "https://example.test/",
    );
    expect(parseSiteUrl("http://localhost:3000").href).toBe(
      "http://localhost:3000/",
    );
  });

  it("값이 없거나 비어 있으면 기본 주소로 바꾸지 않고 실패한다", () => {
    expect(() => parseSiteUrl(undefined)).toThrow(
      /NEXT_PUBLIC_SITE_URL이 비어 있음/,
    );
    expect(() => parseSiteUrl("")).toThrow(/비어 있음/);
    expect(() => parseSiteUrl("   ")).toThrow(/비어 있음/);
  });

  it("절대 주소가 아니면 실패한다", () => {
    expect(() => parseSiteUrl("example.test")).toThrow(/절대 주소가 아님/);
    expect(() => parseSiteUrl("/ko")).toThrow(/절대 주소가 아님/);
    expect(() => parseSiteUrl("https://")).toThrow(/절대 주소가 아님/);
  });

  it("http(s)가 아니면 실패한다", () => {
    expect(() => parseSiteUrl("ftp://example.test")).toThrow(/http\(s\)/);
    expect(() => parseSiteUrl("file:///tmp/site")).toThrow(/http\(s\)/);
    expect(() => parseSiteUrl("javascript:alert(1)")).toThrow(/http\(s\)/);
  });

  it("앞뒤 공백·사용자 정보·경로·검색어·조각이 있으면 실패한다", () => {
    expect(() => parseSiteUrl(" https://example.test")).toThrow(/공백/);
    expect(() => parseSiteUrl("https://example.test\n")).toThrow(/공백/);
    expect(() => parseSiteUrl("https://user:pw@example.test")).toThrow(
      /사용자 정보/,
    );
    expect(() => parseSiteUrl("https://example.test/v2")).toThrow(
      /사이트 루트/,
    );
    expect(() => parseSiteUrl("https://example.test/?a=1")).toThrow(
      /사이트 루트/,
    );
    expect(() => parseSiteUrl("https://example.test/#top")).toThrow(
      /사이트 루트/,
    );
  });

  it("빈 검색어·조각 표시는 떼어 루트 주소만 남긴다", () => {
    expect(parseSiteUrl("https://example.test/?").href).toBe(
      "https://example.test/",
    );
    expect(parseSiteUrl("https://example.test/#").href).toBe(
      "https://example.test/",
    );
  });
});

describe("siteUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("NEXT_PUBLIC_SITE_URL 값을 쓴다", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.test");
    expect(siteUrl().href).toBe("https://example.test/");
  });

  it("NEXT_PUBLIC_SITE_URL이 없으면 실패한다", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
    expect(() => siteUrl()).toThrow(/비어 있음/);
  });
});
