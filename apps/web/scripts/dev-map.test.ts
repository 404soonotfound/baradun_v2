import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
} from "next/constants";
import { describe, expect, it } from "vitest";

import config from "../next.config";
import { DEFAULT_DEV_MAP_ORIGIN, devMapOrigin } from "./dev-map.mjs";

// 개발 서버·Storybook 지도 판 파일 (D19-1 · #392)

describe("devMapOrigin", () => {
  it("값이 없거나 비면 운영 사이트 주소", () => {
    expect(devMapOrigin(undefined)).toBe(DEFAULT_DEV_MAP_ORIGIN);
    expect(devMapOrigin("")).toBe(DEFAULT_DEV_MAP_ORIGIN);
  });

  it("https 사이트 주소는 끝의 /를 떼고 받음", () => {
    expect(devMapOrigin("https://d123.cloudfront.net/")).toBe(
      "https://d123.cloudfront.net",
    );
  });

  it.each([
    "http://d123.cloudfront.net",
    "https://d123.cloudfront.net/map",
    "https://user:pw@d123.cloudfront.net",
    "https://d123.cloudfront.net/?v=1",
    "https://d123.cloudfront.net/#map",
    "not a url",
  ])(
    "주소가 아니거나 http·경로·사용자 정보·쿼리가 있으면 멈춤: %s",
    (value) => {
      expect(() => devMapOrigin(value)).toThrow(/BARADUN_DEV_MAP_ORIGIN/);
    },
  );
});

describe("next.config", () => {
  it("빌드(정적 내보내기)에는 rewrites가 없다", () => {
    expect(config(PHASE_PRODUCTION_BUILD).rewrites).toBeUndefined();
  });

  it("개발 서버는 /map/만 운영 CloudFront로 넘긴다", async () => {
    const rewrites = await config(PHASE_DEVELOPMENT_SERVER).rewrites?.();
    expect(rewrites).toEqual([
      {
        source: "/map/:path*",
        destination: `${devMapOrigin()}/map/:path*`,
      },
    ]);
  });
});
