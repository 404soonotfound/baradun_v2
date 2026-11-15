import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GA_MEASUREMENT_ID,
  isProductionSite,
  isProductionSiteUrl,
  PRODUCTION_SITE_ORIGIN,
} from "./site-env";

// 운영 판별 (BRD-143 · BRD-144): 운영 주소와 origin이 같을 때만 운영. 그 밖은 모두 비운영
describe("isProductionSiteUrl", () => {
  it("운영 주소는 끝 슬래시가 있든 없든 운영", () => {
    expect(PRODUCTION_SITE_ORIGIN).toBe("https://www.baradun.app");
    expect(isProductionSiteUrl("https://www.baradun.app")).toBe(true);
    expect(isProductionSiteUrl("https://www.baradun.app/")).toBe(true);
  });

  it("테스트 주소·로컬 주소는 비운영", () => {
    expect(isProductionSiteUrl("https://example.test")).toBe(false);
    expect(isProductionSiteUrl("http://localhost:3000")).toBe(false);
    expect(isProductionSiteUrl("http://127.0.0.1:3109")).toBe(false);
  });

  it("scheme·호스트·포트가 다르면 비운영", () => {
    expect(isProductionSiteUrl("http://www.baradun.app")).toBe(false);
    // 루트 주소는 V1 Vercel이 www로 넘기는 주소라 운영 빌드 주소가 아님
    expect(isProductionSiteUrl("https://baradun.app")).toBe(false);
    // 전환 전 운영 배포 주소(CloudFront 기본 주소)도 비운영
    expect(isProductionSiteUrl("https://d1gam1q4z69v8c.cloudfront.net")).toBe(
      false,
    );
    expect(isProductionSiteUrl("https://www.baradun.app:8443")).toBe(false);
    expect(isProductionSiteUrl("https://www.baradun.app.example")).toBe(false);
  });

  it("빈 값·잘못된 값은 운영으로 보지 않음", () => {
    expect(isProductionSiteUrl(undefined)).toBe(false);
    expect(isProductionSiteUrl("")).toBe(false);
    expect(isProductionSiteUrl("   ")).toBe(false);
    expect(isProductionSiteUrl("www.baradun.app")).toBe(false);
    expect(isProductionSiteUrl(" https://www.baradun.app")).toBe(false);
    expect(isProductionSiteUrl("https://www.baradun.app/v2")).toBe(false);
    expect(isProductionSiteUrl("https://www.baradun.app/?a=1")).toBe(false);
    expect(isProductionSiteUrl("https://user:pw@www.baradun.app")).toBe(false);
  });

  it("측정 ID는 GA4 형식(G-)", () => {
    expect(GA_MEASUREMENT_ID).toMatch(/^G-[A-Z0-9]{6,}$/);
  });
});

describe("isProductionSite", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("NEXT_PUBLIC_SITE_URL이 운영 주소일 때만 운영", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://www.baradun.app");
    expect(isProductionSite()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://d1gam1q4z69v8c.cloudfront.net");
    expect(isProductionSite()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://example.test");
    expect(isProductionSite()).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", undefined);
    expect(isProductionSite()).toBe(false);
  });
});
