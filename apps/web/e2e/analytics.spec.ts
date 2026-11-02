import { CLEAR_ID, expect, slugOf, test } from "./fixtures";

// Google Analytics는 운영 빌드에만 들어감 (BRD-143, lib/site-env.ts isProductionSite)
// E2E 빌드는 NEXT_PUBLIC_SITE_URL=https://example.test라 비운영 → gtag.js 요청·태그·전역 객체가 전혀 없어야 함
// (외부 요청은 fixtures가 막지만 요청 시도 자체가 page.on("request")에 잡히므로 0건을 확인함)
const GA_HOSTS = /googletagmanager\.com|google-analytics\.com/;

test.describe("비운영 빌드에는 Google Analytics가 없다 (BRD-143)", () => {
  for (const pathname of [
    "/",
    "/search/?q=test",
    `/spots/${slugOf(CLEAR_ID)}/`,
    "/en/",
    "/not-found-page-test/",
  ]) {
    test(`${pathname}: gtag 요청·스크립트·전역 객체 없음`, async ({ page }) => {
      const requests: string[] = [];
      page.on("request", (request) => {
        if (GA_HOSTS.test(request.url())) requests.push(request.url());
      });
      await page.goto(pathname);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);

      expect(requests).toEqual([]);
      await expect(
        page.locator('script[src*="googletagmanager.com"]'),
      ).toHaveCount(0);
      const globals = await page.evaluate(() => ({
        gtag: "gtag" in window,
        dataLayer: "dataLayer" in window,
      }));
      expect(globals).toEqual({ gtag: false, dataLayer: false });
    });
  }

  // page_view는 경로가 바뀔 때 보내므로 화면 이동 뒤에도 요청이 없어야 함
  test("화면 이동(홈 → 탐색) 뒤에도 gtag 요청이 없다", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (GA_HOSTS.test(request.url())) requests.push(request.url());
    });
    await page.goto("/");
    await page.getByRole("link", { name: "탐색" }).first().click();
    await page.waitForURL("**/explore/");
    await page.waitForTimeout(500);
    expect(requests).toEqual([]);
    expect(await page.evaluate(() => "dataLayer" in window)).toBe(false);
  });

  test("빌드한 HTML에 gtag 스크립트 태그가 없다", async ({ request }) => {
    for (const pathname of ["/", "/en/", `/spots/${slugOf(CLEAR_ID)}/`]) {
      const html = await (await request.get(pathname)).text();
      expect(html, pathname).not.toContain("googletagmanager.com/gtag/js");
    }
  });
});
