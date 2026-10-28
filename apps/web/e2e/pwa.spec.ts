import type { Page } from "@playwright/test";

import tokens from "../tokens/tokens.json";

import { expect, test } from "./fixtures";

// 앱 아이콘·theme-color (BRD-106 결정 28·35). 서비스 워커 저장 범위(결정 29)는 scripts/service-worker.test.ts
const LIGHT = tokens.color.bg.page.$value;
const DARK = tokens.color.bg.page.$extensions.baradun.dark;
const THEME_KEY = "baradun:theme";

// 브라우저가 고르는 theme-color: media 조건이 맞는 첫 <meta name="theme-color">의 content(HTML 표준 순서)
function themeColor(page: Page) {
  return page.evaluate(() => {
    for (const meta of document.querySelectorAll<HTMLMetaElement>(
      'meta[name="theme-color"]',
    )) {
      if (meta.media && !matchMedia(meta.media).matches) continue;
      if (meta.content) return meta.content;
    }
    return null;
  });
}

function storeTheme(page: Page, theme: "light" | "dark") {
  return page.addInitScript(
    ([key, value]) => localStorage.setItem(key!, value!),
    [THEME_KEY, theme],
  );
}

// 테마 고르기: 라디오는 화면에 숨기고(sr-only) 감싼 label을 누름
async function chooseTheme(page: Page, name: string) {
  await page.locator("label", { hasText: name }).click();
  await expect(page.getByRole("radio", { name })).toBeChecked();
}

test.describe("theme-color", () => {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`기기 ${scheme}`, () => {
      test.use({ colorScheme: scheme });

      test("고른 테마가 없으면 기기 설정을 따름", async ({ page }) => {
        await page.goto("/");
        await expect
          .poll(() => themeColor(page))
          .toBe(scheme === "dark" ? DARK : LIGHT);
      });

      for (const theme of ["light", "dark"] as const) {
        test(`고른 테마(${theme})를 기기 설정보다 앞서 따름`, async ({
          page,
        }) => {
          await storeTheme(page, theme);
          for (const url of ["/", "/en/explore/", "/no-such-page/"]) {
            await page.goto(url);
            await expect
              .poll(() => themeColor(page))
              .toBe(theme === "dark" ? DARK : LIGHT);
          }
        });
      }
    });
  }

  test("설정에서 바꾸면 바로 바뀌고, 기기 설정을 고르면 기기 변경을 따라감", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/settings/");
    await expect.poll(() => themeColor(page)).toBe(LIGHT);

    await chooseTheme(page, "어둡게");
    await expect.poll(() => themeColor(page)).toBe(DARK);
    // 어둡게를 고른 동안 기기가 바뀌어도 그대로
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => themeColor(page)).toBe(DARK);

    // 화면 이동(새로 불러오지 않음) 뒤에도 고른 테마
    await page.getByRole("link", { name: "홈" }).first().click();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => themeColor(page)).toBe(DARK);
    await page.getByRole("link", { name: "설정" }).first().click();
    await expect(page).toHaveURL(/\/settings\/$/);

    await chooseTheme(page, "밝게");
    await expect.poll(() => themeColor(page)).toBe(LIGHT);

    await chooseTheme(page, "기기 설정");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => themeColor(page)).toBe(DARK);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => themeColor(page)).toBe(LIGHT);
  });

  test("영어 화면에도 viewport-fit=cover와 theme-color가 있음", async ({
    page,
  }) => {
    await page.goto("/en/");
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      "content",
      /viewport-fit=cover/,
    );
    await expect.poll(() => themeColor(page)).toBe(LIGHT);
  });
});

test.describe("앱 아이콘", () => {
  for (const url of ["/", "/en/", "/no-such-page/"]) {
    test(`<head>에 favicon·Apple touch 아이콘 ${url}`, async ({ page }) => {
      await page.goto(url);
      const hrefs = await page.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLLinkElement>(
            'link[rel="icon"], link[rel="apple-touch-icon"]',
          ),
        ].map((link) => `${link.rel} ${link.getAttribute("href")}`),
      );
      expect(hrefs).toEqual([
        "icon /favicon.ico",
        "apple-touch-icon /icons/apple-touch-icon.png",
      ]);
    });
  }

  test("매니페스트 아이콘 파일을 모두 받을 수 있음", async ({ page }) => {
    const manifest = await (
      await page.request.get("/manifest.webmanifest")
    ).json();
    const icons = manifest.icons as { src: string; purpose: string }[];
    expect(icons.map((icon) => icon.purpose)).toEqual([
      "any",
      "any",
      "maskable",
    ]);
    for (const src of [
      ...icons.map((icon) => icon.src),
      "/favicon.ico",
      "/icons/apple-touch-icon.png",
    ]) {
      const response = await page.request.get(src);
      expect(response.status(), src).toBe(200);
      expect(response.headers()["content-type"], src).toMatch(/^image\//);
    }
  });
});
