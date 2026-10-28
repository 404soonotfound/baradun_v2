import {
  CLEAR_ID,
  DELAYED_ID,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  slugOf,
  test,
  UNKNOWN_ID,
  WARNING_ID,
} from "./fixtures";

// 전 화면 접근성 자동 검사 (BRD-39 · WCAG 2.2 AA, 대비는 라이트·다크 모두)
// 크기는 프로젝트(모바일 390×844 · PC 1280)가 정함. 화면마다 라이트·다크 둘 다 axe와 가로 스크롤을 봄
const SCREENS = [
  "/",
  "/explore/",
  "/search/",
  `/spots/${slugOf(CLEAR_ID)}/`,
  `/spots/${slugOf(WARNING_ID)}/`,
  `/spots/${slugOf(DELAYED_ID)}/`,
  `/spots/${slugOf(UNKNOWN_ID)}/`,
  "/favorites/",
  "/settings/",
  "/settings/inquiry/",
  "/guide/",
  "/about/data/",
  "/terms/",
  "/no-such-page/",
];

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme}`, () => {
    test.use({ colorScheme: scheme });
    for (const locale of ["ko", "en"] as const) {
      test.describe(locale, () => {
        test.use({ deviceLanguage: locale });
        for (const screen of SCREENS) {
          const url = locale === "en" ? `/en${screen}` : screen;
          test(`${url}`, async ({ page }) => {
            await page.goto(url);
            await page.locator("main").first().waitFor();
            // 바다 정보가 들어온 뒤(로딩 표시가 사라진 뒤) 검사
            await page
              .locator("[aria-busy='true']")
              .first()
              .waitFor({ state: "detached", timeout: 5_000 })
              .catch(() => {});
            await expectNoA11yViolations(page);
            await expectNoHorizontalScroll(page);
          });
        }
      });
    }
  });
}
