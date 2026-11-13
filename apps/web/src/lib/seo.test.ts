import { afterEach, describe, expect, it } from "vitest";
import {
  buildRobots,
  buildSitemap,
  INDEXABLE_STATIC_PATHS,
  NOINDEX_ROBOTS,
  rootRobotsMetadata,
} from "@/lib/seo";
import { PRODUCTION_SITE_ORIGIN } from "@/lib/site-env";

const ORIGINAL_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

afterEach(() => {
  if (ORIGINAL_SITE_URL === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_SITE_URL;
});

describe("seo", () => {
  it("비운영 주소면 전체 noindex · robots Disallow · 빈 sitemap을 돌려줌", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://example.test";
    expect(rootRobotsMetadata()).toEqual(NOINDEX_ROBOTS);
    expect(buildRobots()).toEqual({
      rules: [{ userAgent: "*", disallow: "/" }],
    });
    expect(buildSitemap(["gangmun"])).toEqual([]);
  });

  it("운영 주소면 루트 noindex를 떼고 /search만 막으며 sitemap을 채움", () => {
    process.env.NEXT_PUBLIC_SITE_URL = PRODUCTION_SITE_ORIGIN;
    expect(rootRobotsMetadata()).toBeUndefined();
    expect(buildRobots()).toEqual({
      rules: [
        {
          userAgent: "*",
          allow: "/",
        },
      ],
      sitemap: `${PRODUCTION_SITE_ORIGIN}/sitemap.xml`,
    });

    const entries = buildSitemap(["gangmun", "_"]);
    const urls = entries.map((entry) => entry.url);
    expect(urls).toContain(`${PRODUCTION_SITE_ORIGIN}/`);
    expect(urls).toContain(`${PRODUCTION_SITE_ORIGIN}/en/`);
    expect(urls).toContain(`${PRODUCTION_SITE_ORIGIN}/spots/gangmun/`);
    expect(urls).toContain(`${PRODUCTION_SITE_ORIGIN}/en/spots/gangmun/`);
    expect(urls.some((url) => url.includes("/search/"))).toBe(false);
    expect(urls.some((url) => url.includes("/spots/_/"))).toBe(false);
    expect(entries).toHaveLength((INDEXABLE_STATIC_PATHS.length + 1) * 2);

    const beachKo = entries.find(
      (entry) => entry.url === `${PRODUCTION_SITE_ORIGIN}/spots/gangmun/`,
    );
    expect(beachKo?.alternates).toEqual({
      languages: {
        ko: `${PRODUCTION_SITE_ORIGIN}/spots/gangmun/`,
        en: `${PRODUCTION_SITE_ORIGIN}/en/spots/gangmun/`,
        "x-default": `${PRODUCTION_SITE_ORIGIN}/spots/gangmun/`,
      },
    });
  });
});
