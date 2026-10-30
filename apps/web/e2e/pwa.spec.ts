import type { Page } from "@playwright/test";

import tokens from "../tokens/tokens.json";

import {
  chooseTheme,
  expect,
  expectNoA11yViolations,
  test,
} from "./fixtures";

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

// theme-color 줄 [media, content]. 그리기 전 스크립트는 media만 바꾸므로 React가 줄을 더 만들지 않아 늘 두 줄
function themeMetas(page: Page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
    ].map((meta) => [meta.media, meta.content]),
  );
}

// 줄이 두 개(라이트 색·다크 색 하나씩)이고 지금 쓰이는 색이 expected인지
async function expectThemeColor(page: Page, expected: string) {
  // React가 문서를 이어받은 뒤에 봄(줄이 늘어나는 일은 hydration 때 생김)
  await page.waitForFunction(() =>
    Object.keys(document.body).some((key) => key.startsWith("__reactFiber")),
  );
  await expect.poll(() => themeColor(page)).toBe(expected);
  const metas = await themeMetas(page);
  expect(metas.map(([, content]) => content)).toEqual([LIGHT, DARK]);
}

function storeTheme(page: Page, theme: "light" | "dark") {
  return page.addInitScript(
    ([key, value]) => localStorage.setItem(key!, value!),
    [THEME_KEY, theme],
  );
}

test.describe("theme-color", () => {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(`기기 ${scheme}`, () => {
      test.use({ colorScheme: scheme });

      test("고른 테마가 없으면 기기 설정을 따름", async ({ page }) => {
        await page.goto("/");
        await expectThemeColor(page, scheme === "dark" ? DARK : LIGHT);
      });

      for (const theme of ["light", "dark"] as const) {
        test(`고른 테마(${theme})를 기기 설정보다 앞서 따름`, async ({
          page,
        }) => {
          await storeTheme(page, theme);
          for (const url of ["/", "/en/explore/", "/no-such-page/"]) {
            await page.goto(url);
            await expectThemeColor(page, theme === "dark" ? DARK : LIGHT);
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
    await expectThemeColor(page, LIGHT);

    await chooseTheme(page, "어둡게");
    await expectThemeColor(page, DARK);
    // 어둡게를 고른 동안 기기가 바뀌어도(라이트 → 다크 → 라이트) 그대로
    await page.emulateMedia({ colorScheme: "dark" });
    await expectThemeColor(page, DARK);
    await page.emulateMedia({ colorScheme: "light" });
    await expectThemeColor(page, DARK);

    // 화면 이동(새로 불러오지 않음) 뒤에도 고른 테마
    await page.getByRole("link", { name: "홈" }).first().click();
    await expect(page).toHaveURL(/\/$/);
    await expectThemeColor(page, DARK);
    await page.getByRole("link", { name: "설정" }).first().click();
    await expect(page).toHaveURL(/\/settings\/$/);

    await chooseTheme(page, "밝게");
    await expectThemeColor(page, LIGHT);
    // 밝게를 고른 동안 기기가 다크로 바뀌어도 그대로
    await page.emulateMedia({ colorScheme: "dark" });
    await expectThemeColor(page, LIGHT);

    await chooseTheme(page, "기기 설정");
    await expectThemeColor(page, DARK);
    await page.emulateMedia({ colorScheme: "light" });
    await expectThemeColor(page, LIGHT);
  });

  test("영어 화면에도 viewport-fit=cover와 theme-color가 있음", async ({
    page,
  }) => {
    await page.goto("/en/");
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      "content",
      /viewport-fit=cover/,
    );
    await expectThemeColor(page, LIGHT);
  });
});

// 결정 29: 끊긴 동안 상세·검색 등을 열면 서비스 워커가 ?unavailable=1을 붙여 같은 언어 홈으로 보냄(워커 동작은 단위 테스트)
test.describe("열지 못한 화면 안내", () => {
  for (const [home, title] of [
    ["/", "그 화면을 열지 못해 홈으로 왔어요"],
    ["/en/", "Couldn't open that page, so you're on Home"],
  ] as const) {
    test(`표식이 있으면 무슨 일·영향·다음 행동을 알리고 주소에서 표식을 지움 ${home}`, async ({
      page,
    }) => {
      await page.goto(`${home}?unavailable=1`);
      const note = page.getByText(title, { exact: true }).filter({
        visible: true,
      });
      await expect(note).toBeVisible();
      await expect(
        page.getByRole("status").filter({ hasText: title }),
      ).toHaveCount(1);
      await expect
        .poll(() => {
          const url = new URL(page.url());
          return url.pathname + url.search;
        })
        .toBe(home);
      await expectNoA11yViolations(page);
    });
  }

  test("표식이 없으면 보이지 않음", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(
      page.getByText("그 화면을 열지 못해 홈으로 왔어요"),
    ).toHaveCount(0);
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
