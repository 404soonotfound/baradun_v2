import type { MetadataRoute } from "next";
import { beachSlugParams } from "@/lib/beaches";
import { buildSitemap } from "@/lib/seo";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return buildSitemap(beachSlugParams().map((entry) => entry.slug));
}
