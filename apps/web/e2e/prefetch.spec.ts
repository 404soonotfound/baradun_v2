import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// 해변 상세 링크 미리 받기 (GH-543)
// 보이기만 해서는 받지 않고(긴 목록을 내려도 CloudFront 요청이 늘지 않게), 마우스 올림·포커스 때만 받음.
// 미리 받기는 운영 빌드에서만 돌아서 정적 빌드(out/)를 쓰는 이 스위트에서 확인함

// 해변 상세의 미리 받기 요청(__next.*.txt)만 모음. 눌러서 이동할 때의 요청과 섞이지 않게 이동은 하지 않음
function watchSpotPrefetch(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith("/spots/") && pathname.endsWith(".txt")) {
      seen.push(pathname);
    }
  });
  return seen;
}

test.describe("해변 링크 미리 받기", () => {
  test.use({ exploreView: "list" });

  test("탐색 목록을 내려도 보이는 해변 링크를 미리 받지 않음", async ({
    page,
  }) => {
    const seen = watchSpotPrefetch(page);
    await page.goto("/explore/");
    const rows = page.locator('main a[href^="/spots/"]');
    await expect(rows.first()).toBeVisible();
    await page.mouse.wheel(0, 4000);
    // 미리 받기는 화면에 들어온 뒤 쉬는 시간에 시작하므로 잠시 기다린 뒤 셈
    await page.waitForTimeout(1500);
    expect(seen).toEqual([]);
  });

  test("해변 링크에 포커스하면 그 해변만 미리 받음", async ({ page }) => {
    const seen = watchSpotPrefetch(page);
    await page.goto("/explore/");
    const first = page.locator('main a[href^="/spots/"]').first();
    await expect(first).toBeVisible();
    const href = await first.getAttribute("href");
    await first.focus();
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    expect(seen.every((path) => path.startsWith(href ?? "-"))).toBe(true);
  });

  test("해변 링크에 손가락이 닿으면 그 해변만 미리 받음", async ({ page }) => {
    const seen = watchSpotPrefetch(page);
    await page.goto("/explore/");
    const first = page.locator('main a[href^="/spots/"]').first();
    await expect(first).toBeVisible();
    const href = await first.getAttribute("href");
    // 누르기까지 하면 이동 요청과 섞이므로 닿음(touchstart)만 보냄
    await first.dispatchEvent("touchstart");
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    expect(seen.every((path) => path.startsWith(href ?? "-"))).toBe(true);
  });
});
