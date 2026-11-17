import { isProductionSiteUrl } from "../src/lib/site-env";
import { expect, test, CLEAR_ID, slugOf } from "./fixtures";

// 배포 워크플로는 실제로 올릴 빌드에 E2E를 돌리고 E2E_SITE_URL로 빌드에 넣은 주소를 알려 줌(analytics.spec과 같음)
// 운영 주소(www) 빌드면 색인을 열어 두는 쪽을, 그 밖(CI의 example.test 등)이면 막는 쪽을 검사함(GH-341 전환 4단계에서 확인)
const PRODUCTION_BUILD = isProductionSiteUrl(process.env.E2E_SITE_URL);

const STATUS_WORDS =
  /특보 없음|이용불가|판단불가|안전해요|수영 추천|No active advisories|Unavailable|Uncertain/i;

test.describe("SEO · 메타 · 크롤링 제어 (BRD-144)", () => {
  test("비운영(E2E) 빌드에서는 robots.txt가 전체 차단이고 sitemap.xml이 비어 있음", async ({
    request,
  }) => {
    test.skip(PRODUCTION_BUILD, "운영 빌드는 아래 운영 전용 검사에서 봄");
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

  test("운영 빌드에서는 robots.txt가 색인을 열고 sitemap.xml에 주소가 있음", async ({
    request,
  }) => {
    test.skip(!PRODUCTION_BUILD, "운영 주소로 빌드한 배포에서만 봄");
    const robots = await request.get("/robots.txt");
    expect(robots.ok()).toBe(true);
    const robotsText = await robots.text();
    expect(robotsText).toContain("Allow: /");
    expect(robotsText).not.toMatch(/^Disallow: \/$/m);
    expect(robotsText).toContain(
      `Sitemap: ${new URL(process.env.E2E_SITE_URL!).origin}/sitemap.xml`,
    );

    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.ok()).toBe(true);
    expect(await sitemap.text()).toContain("<url>");
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

      // 색인 대상 페이지: 비운영 빌드는 noindex로 막고, 운영 빌드는 막지 않음
      const robotsMeta = await page
        .locator('meta[name="robots"]')
        .getAttribute("content");
      if (PRODUCTION_BUILD) expect(robotsMeta ?? "").not.toContain("noindex");
      else expect(robotsMeta).toContain("noindex");

      const description = await page
        .locator('meta[name="description"]')
        .getAttribute("content");
      expect(description).toBeTruthy();
      expect(description).not.toMatch(STATUS_WORDS);

      const canonical = await page
        .locator('link[rel="canonical"]')
        .getAttribute("href");
      expect(new URL(canonical!).pathname).toBe(item.path);

      const koHref = await page
        .locator('link[rel="alternate"][hreflang="ko"]')
        .getAttribute("href");
      const enHref = await page
        .locator('link[rel="alternate"][hreflang="en"]')
        .getAttribute("href");
      const xDefault = await page
        .locator('link[rel="alternate"][hreflang="x-default"]')
        .getAttribute("href");
      expect(new URL(koHref!).pathname).toBe(item.ko);
      expect(new URL(enHref!).pathname).toBe(item.en);
      expect(xDefault).toBe(koHref);

      const ogTitle = await page
        .locator('meta[property="og:title"]')
        .getAttribute("content");
      const ogDescription = await page
        .locator('meta[property="og:description"]')
        .getAttribute("content");
      const ogImage = await page
        .locator('meta[property="og:image"]')
        .getAttribute("content");
      const twitterTitle = await page
        .locator('meta[name="twitter:title"]')
        .getAttribute("content");
      const twitterDescription = await page
        .locator('meta[name="twitter:description"]')
        .getAttribute("content");
      expect(ogTitle).toBeTruthy();
      expect(ogTitle).not.toMatch(STATUS_WORDS);
      expect(ogDescription).toBeTruthy();
      expect(ogDescription).not.toMatch(STATUS_WORDS);
      expect(ogImage).toMatch(/^https?:\/\//);
      if (twitterTitle) expect(twitterTitle).not.toMatch(STATUS_WORDS);
      if (twitterDescription)
        expect(twitterDescription).not.toMatch(STATUS_WORDS);
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
