import type { Metadata, MetadataRoute } from "next";
import { EMPTY_SLUG } from "@/lib/beaches";
import { localizedPath } from "@/lib/i18n";
import { isProductionSite } from "@/lib/site-env";
import { siteUrl } from "@/lib/site-url";

// 검색 결과·404·비운영 빌드는 색인을 막음 (BRD-144)
export const NOINDEX_ROBOTS: NonNullable<Metadata["robots"]> = {
  index: false,
  follow: false,
};

export function rootRobotsMetadata(): Metadata["robots"] | undefined {
  return isProductionSite() ? undefined : NOINDEX_ROBOTS;
}

export const INDEXABLE_STATIC_PATHS = [
  "/",
  "/explore/",
  "/guide/",
  "/about/data/",
  "/terms/",
] as const;

export function buildRobots(): MetadataRoute.Robots {
  if (!isProductionSite()) {
    return {
      rules: [{ userAgent: "*", disallow: "/" }],
    };
  }
  const origin = siteUrl().origin;
  return {
    // /search/는 Disallow로 막으면 noindex 메타를 읽지 못하므로 allow로 두고 페이지 메타의 noindex로 차단
    rules: [
      {
        userAgent: "*",
        allow: "/",
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
  };
}

export function buildSitemap(
  beachSlugs: readonly string[],
): MetadataRoute.Sitemap {
  if (!isProductionSite()) return [];
  const origin = siteUrl().origin;
  const paths = [
    ...INDEXABLE_STATIC_PATHS,
    ...beachSlugs
      .filter((slug) => slug !== EMPTY_SLUG)
      .map((slug) => `/spots/${slug}/`),
  ];

  const entries: MetadataRoute.Sitemap = [];
  for (const path of paths) {
    const koUrl = `${origin}${localizedPath("ko", path)}`;
    const enUrl = `${origin}${localizedPath("en", path)}`;
    const alternates = {
      languages: {
        ko: koUrl,
        en: enUrl,
        "x-default": koUrl,
      },
    };
    entries.push({ url: koUrl, alternates });
    entries.push({ url: enUrl, alternates });
  }
  return entries;
}
