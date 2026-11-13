import { expect, test, CLEAR_ID, slugOf } from "./fixtures";

const STATUS_WORDS =
  /특보 없음|이용불가|판단불가|안전해요|수영 추천|No active advisories|Unavailable|Uncertain/i;

test.describe("SEO · 메타 · 크롤링 제어 (BRD-144)", () => {
  test("비운영(E2E) 빌드에서는 robots.txt가 전체 차단이고 sitemap.xml이 비어 있음", async ({
    request,
  }) => {
    const robots = await request.get("/robots.txt");
    expect(robots.ok()).toBe(true);
    const robotsText = await robots.text();
    expect(robotsText).toContain("Disallow: /");
    expect(robotsText).not.toContain("Sitemap:");

    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.ok()).toBe(true);
    const sitemapXml = await sitemap.text();
    expect(sitemapXml).toContain("<urlset");
    expect(sitemapXml).not.toContain("<url>");
  });

  const slug = slugOf(CLEAR_ID);
  const indexablePages = [
    { path: "/", ko: "/", en: "/en/" },
    { path: "/en/", ko: "/", en: "/en/" },
    { path: "/explore/", ko: "/explore/", en: "/en/explore/" },
    {
      path: `/spots/${slug}/`,
      ko: `/spots/${slug}/`,
      en: `/en/spots/${slug}/`,
    },
    {
      path: `/en/spots/${slug}/`,
      ko: `/spots/${slug}/`,
      en: `/en/spots/${slug}/`,
    },
  ];

  for (const item of indexablePages) {
    test(`${item.path} 는 canonical · hreflang · OG가 있고 상태·안전 문구가 없음`, async ({
      page,
    }) => {
      await page.goto(item.path);
      const title = await page.title();
      expect(title).not.toBe("");
      expect(title).not.toMatch(STATUS_WORDS);

      const robotsMeta = await page
        .locator('meta[name="robots"]')
        .getAttribute("content");
      expect(robotsMeta).toContain("noindex");

      const description = await page
        .locator('meta[name="description"]')
        .getAttribute("content");
      expect(description).toBeTruthy();
      expect(description).not.toMatch(STATUS_WORDS);

      const canonical = await page
        .locator('link[rel="canonical"]')
        .getAttribute("href");
      expect(canonical).toMatch(new RegExp(`${item.path}$`));

      const koHref = await page
        .locator('link[rel="alternate"][hreflang="ko"]')
        .getAttribute("href");
      const enHref = await page
        .locator('link[rel="alternate"][hreflang="en"]')
        .getAttribute("href");
      const xDefault = await page
        .locator('link[rel="alternate"][hreflang="x-default"]')
        .getAttribute("href");
      expect(koHref).toMatch(new RegExp(`${item.ko}$`));
      expect(enHref).toMatch(new RegExp(`${item.en}$`));
      expect(xDefault).toBe(koHref);

      const ogTitle = await page
        .locator('meta[property="og:title"]')
        .getAttribute("content");
      const ogImage = await page
        .locator('meta[property="og:image"]')
        .getAttribute("content");
      expect(ogTitle).toBeTruthy();
      expect(ogTitle).not.toMatch(STATUS_WORDS);
      expect(ogImage).toMatch(/^https?:\/\//);
    });
  }

  for (const path of ["/search/", "/en/search/", "/no-such-page/"]) {
    test(`${path} 는 항상 noindex 메타가 있음`, async ({ page }) => {
      await page.goto(path);
      const robotsMeta = await page
        .locator('meta[name="robots"]')
        .getAttribute("content");
      expect(robotsMeta).toContain("noindex");
    });
  }
});
