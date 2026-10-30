import type { Locator, Page } from "@playwright/test";

import {
  CLEAR_ID,
  coordsOf,
  expect,
  expectNoA11yViolations,
  test,
} from "./fixtures";

// 위치 거부 상태의 '다시 시도' (BRD-139 · 2026-10-30 사용자 결정 A안)
// 거부여도 사용자가 누른 '다시 시도'만 한 번 더 요청. 앱을 열 때·정렬 탭은 묻지 않음, 꺼짐이면 버튼 없음
// 또 거부면 기기별 설정 경로(아이폰 Safari · 그 밖). 홈 배너·설정·탐색 '가까운 순' 안내가 같은 버튼

// 다시 시도의 답. allow = 시험용 좌표(강릉 시험 해변 위치, 사용자 위치 아님) · deny = 또 거부
type Answer = "allow" | "deny";
const coords = coordsOf(CLEAR_ID);

// 권한 확인은 늘 거부(아이폰 Safari처럼 사이트 설정이 '묻기'여도 거부를 주는 기기)
// 위치 요청은 answer대로 답하고 횟수를 셈. hold면 window.e2eRelease()를 부를 때까지 답하지 않음
async function deniedDevice(
  page: Page,
  answer: Answer,
  options: { hold?: boolean } = {},
) {
  await page.addInitScript(
    ({ answer, hold, coords }) => {
      const w = window as unknown as {
        e2eAsked: number;
        e2eRelease: () => void;
      };
      w.e2eAsked = 0;
      const status = {
        state: "denied",
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
      };
      Object.defineProperty(navigator.permissions, "query", {
        value: () => Promise.resolve(status),
      });
      Object.defineProperty(navigator.geolocation, "getCurrentPosition", {
        value: (
          ok: (position: unknown) => void,
          fail: (error: unknown) => void,
        ) => {
          w.e2eAsked += 1;
          const reply = () =>
            answer === "allow"
              ? ok({ coords: { latitude: coords.lat, longitude: coords.lng } })
              : fail({ code: 1, PERMISSION_DENIED: 1, message: "denied" });
          if (hold) w.e2eRelease = reply;
          else reply();
        },
      });
    },
    { answer, hold: options.hold ?? false, coords: coords! },
  );
}

const asked = (page: Page) =>
  page.evaluate(() => (window as unknown as { e2eAsked: number }).e2eAsked);

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const BROWSER_GUIDE =
  "다시 시도했지만 위치 권한이 허용되지 않아 가까운 바다와 거리를 보여드릴 수 없어요. 브라우저 설정에서 이 사이트의 위치 권한을 허용한 뒤 다시 시도해 주세요.";
const IOS_GUIDE =
  "다시 시도했지만 위치 권한이 허용되지 않아 가까운 바다와 거리를 보여드릴 수 없어요. 설정 → 개인정보 보호 및 보안 → 위치 서비스 → Safari 웹사이트에서 '앱을 사용하는 동안'으로 바꾼 뒤 다시 시도해 주세요.";

const homeBanner = (page: Page) =>
  page.getByRole("status").filter({ hasText: "위치 없이 보고 있어요" });
const retryButton = (scope: Page | Locator) =>
  scope.getByRole("button", { name: "다시 시도", exact: true });

test.describe("홈 위치 배너", () => {
  test.use({ deviceRegion: null });

  test("앱을 열 때는 묻지 않고, 다시 시도 → 허용이면 가까운 바다", async ({
    page,
  }) => {
    await deniedDevice(page, "allow");
    await page.goto("/");
    await expect(page.locator("#home-near")).toHaveText("전국 바다");
    await expect(retryButton(homeBanner(page))).toBeVisible();
    expect(await asked(page)).toBe(0);

    await retryButton(homeBanner(page)).click();
    await expect(page.locator("#home-near")).toHaveText("가까운 바다");
    await expect(homeBanner(page)).toHaveCount(0);
    expect(await asked(page)).toBe(1);
  });

  test("다시 시도 → 또 거부면 거부 그대로 + 브라우저 설정 안내", async ({
    page,
  }) => {
    await deniedDevice(page, "deny");
    await page.goto("/");
    await retryButton(homeBanner(page)).click();
    await expect(homeBanner(page).getByText(BROWSER_GUIDE)).toBeVisible();
    await expect(page.locator("#home-near")).toHaveText("전국 바다");
    // 사용자가 다시 누르면 또 요청(자동 요청은 없음)
    await expect(retryButton(homeBanner(page))).toBeFocused();
    expect(await asked(page)).toBe(1);
    await expectNoA11yViolations(page);
  });

  test("답을 기다리는 동안은 버튼을 막아 두 번 요청하지 않음", async ({
    page,
  }) => {
    await deniedDevice(page, "allow", { hold: true });
    await page.goto("/");
    await retryButton(homeBanner(page)).click();
    const pending = homeBanner(page).getByRole("button", {
      name: "위치 확인 중…",
    });
    await expect(pending).toHaveAttribute("aria-disabled", "true");
    await expect(pending).toBeFocused();
    // Playwright는 aria-disabled 버튼의 click을 기다리기만 해서, 포커스된 버튼을 키보드로 한 번 더 누름
    await page.keyboard.press("Enter");
    expect(await asked(page)).toBe(1);
    // 답을 기다리는 동안 화면은 그대로(전국 · 배너)
    await expect(page.locator("#home-near")).toHaveText("전국 바다");

    await page.evaluate(() =>
      (window as unknown as { e2eRelease: () => void }).e2eRelease(),
    );
    await expect(page.locator("#home-near")).toHaveText("가까운 바다");
    expect(await asked(page)).toBe(1);
  });
});

test.describe("아이폰 Safari", () => {
  test.use({ deviceRegion: null, userAgent: IPHONE_SAFARI });

  test("또 거부면 기기 설정 경로(위치 서비스 → Safari 웹사이트)", async ({
    page,
  }) => {
    await deniedDevice(page, "deny");
    await page.goto("/");
    await retryButton(homeBanner(page)).click();
    await expect(homeBanner(page).getByText(IOS_GUIDE)).toBeVisible();
    await expect(page.getByText(BROWSER_GUIDE)).toHaveCount(0);
  });
});

test.describe("설정 브라우저 위치 권한", () => {
  const permissionValue = (page: Page) =>
    page
      .getByText("브라우저 위치 권한", { exact: true })
      .locator("xpath=following-sibling::span[1]");

  test("거부 안내의 다시 시도 → 허용이면 허용됨", async ({ page }) => {
    await deniedDevice(page, "allow");
    await page.goto("/settings/");
    await expect(permissionValue(page).first()).toHaveText("허용 안 함");
    await expect(
      page.getByText(
        "위치 권한이 허용되지 않아 가까운 바다와 거리를 보여드릴 수 없어요. 다시 시도를 누르면 브라우저에 한 번 더 요청해요.",
      ),
    ).toBeVisible();
    expect(await asked(page)).toBe(0);

    await retryButton(page).click();
    await expect(permissionValue(page).first()).toHaveText("허용됨");
    await expect(retryButton(page)).toHaveCount(0);
    expect(await asked(page)).toBe(1);
  });

  test("다시 시도 → 또 거부면 안내 자리에 브라우저 설정 경로", async ({
    page,
  }) => {
    await deniedDevice(page, "deny");
    await page.goto("/settings/");
    await retryButton(page).click();
    await expect(page.getByText(BROWSER_GUIDE)).toBeVisible();
    await expect(permissionValue(page).first()).toHaveText("허용 안 함");
    expect(await asked(page)).toBe(1);
    await expectNoA11yViolations(page);
  });

  test("위치 사용을 끄면 다시 시도 버튼이 없고 요청하지 않음", async ({
    page,
  }) => {
    await deniedDevice(page, "allow");
    await page.goto("/settings/");
    await expect(retryButton(page)).toBeVisible();
    await page.getByRole("switch", { name: "내 주변 탐색 사용" }).click();
    await expect(permissionValue(page).first()).toHaveText("꺼짐");
    await expect(retryButton(page)).toHaveCount(0);
    expect(await asked(page)).toBe(0);
  });
});

test.describe("탐색 가까운 순", () => {
  test.use({ exploreView: "list" });
  const sortNear = (page: Page) =>
    page
      .getByRole("group", { name: "목록 보기 방식" })
      .getByRole("button", { name: "가까운 순" });
  const notice = (page: Page) =>
    page.getByRole("status").filter({ hasText: "위치 권한이 꺼져 있어요" });

  test("가까운 순을 눌러도 묻지 않고, 안내의 다시 시도 → 허용이면 거리 순", async ({
    page,
  }) => {
    await deniedDevice(page, "allow");
    await page.goto("/explore/");
    await sortNear(page).click();
    await expect(retryButton(notice(page))).toBeVisible();
    expect(await asked(page)).toBe(0);

    await retryButton(notice(page)).click();
    await expect(notice(page)).toHaveCount(0);
    await expect(
      page.locator("main li").filter({ hasText: /km/ }).first(),
    ).toBeVisible();
    expect(await asked(page)).toBe(1);
  });

  test("다시 시도 → 또 거부면 이름 순 그대로 + 브라우저 설정 안내", async ({
    page,
  }) => {
    await deniedDevice(page, "deny");
    await page.goto("/explore/");
    await sortNear(page).click();
    await retryButton(notice(page)).click();
    await expect(notice(page).getByText(BROWSER_GUIDE)).toBeVisible();
    await expect(page.locator("main li").filter({ hasText: /km/ })).toHaveCount(
      0,
    );
    expect(await asked(page)).toBe(1);
    await expectNoA11yViolations(page);
  });
});
