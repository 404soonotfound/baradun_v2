import type { Page } from "@playwright/test";

import {
  CLEAR_ID,
  DELAYED_ID,
  expect,
  slugOf,
  test,
  WARNING_ID,
} from "./fixtures";

// 화면 밀림(CLS) 회귀 (BRD-39 · Core Web Vitals CLS 0.1)
// 정적 HTML이 먼저 그려진 뒤 수화·바다 정보 도착으로 바뀌는 자리(그리기 전 힌트 lib/layout-hints.ts, 상세 자리 상자)를 봄.
// 로컬은 너무 빨라 수화가 정적 화면과 거의 같이 그려져 밀림이 드러나지 않음 → CPU 4배 감속, 화면 코드 1.5초·바다 정보 0.6초 늦춤(느린 망 흉내)
// 고치기 전 빌드에서는 홈 0.2·상세 0.38~0.66으로 실패하는 것을 확인함. 실험실 값이라 실기기 값과 다를 수 있음

const LIMIT = 0.1;

async function slowDown(page: Page) {
  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  // CPU 4배 느리게(모바일 실험실 기준). 수화가 정적 화면보다 늦게 끝나야 밀림이 드러남
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.route("**/_next/static/chunks/**", async (route) => {
    await wait(1500);
    await route.fallback();
  });
  await page.route("**/data/**", async (route) => {
    await wait(600);
    await route.fallback();
  });
  await page.addInitScript(() => {
    const store = window as unknown as { __shifts: number[][] };
    store.__shifts = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[]) {
        if (!entry.hadRecentInput)
          store.__shifts.push([entry.startTime, entry.value]);
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
}

// 세션 창(1초 간격·최대 5초)마다 더해 가장 큰 값 = CLS
async function cls(page: Page): Promise<number> {
  const shifts = await page.evaluate(
    () => (window as unknown as { __shifts: number[][] }).__shifts,
  );
  let max = 0;
  let sum = 0;
  let start = -Infinity;
  let last = -Infinity;
  for (const [time, value] of shifts as [number, number][]) {
    if (time - last > 1000 || time - start > 5000) {
      sum = 0;
      start = time;
    }
    sum += value;
    last = time;
    max = Math.max(max, sum);
  }
  return max;
}

test.describe("화면 밀림", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "모바일 기준(390×844)");
  });

  test.describe("홈 · 처음 방문(기본 지역 없음)", () => {
    test.use({ deviceRegion: null });
    test("'위치 없이 보고 있어요'·전국 목록이 들어와도 밀리지 않음", async ({
      page,
    }) => {
      await slowDown(page);
      await page.goto("/");
      await expect(page.getByText("위치 없이 보고 있어요")).toBeVisible();
      await page.waitForTimeout(1500);
      expect(await cls(page)).toBeLessThan(LIMIT);
    });
  });

  test("홈 · 기본 지역을 고른 기기", async ({ page }) => {
    await slowDown(page);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "강원 강릉시 바다" }),
    ).toBeVisible();
    await page.waitForTimeout(1500);
    expect(await cls(page)).toBeLessThan(LIMIT);
  });

  test("장소 상세 · 불러오는 동안 옮긴 포커스가 바다 정보가 온 뒤에도 같은 항목에 남음", async ({
    page,
  }) => {
    await slowDown(page);
    await page.goto(`/spots/${slugOf(WARNING_ID)}/`);
    const call = page.locator('a[href="tel:119"]');
    await call.focus();
    await expect(page.locator("section[aria-busy='true']")).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(call).toBeFocused();
  });

  for (const [name, id] of [
    ["특보 없음", CLEAR_ID],
    ["이용불가", WARNING_ID],
    ["판단불가", DELAYED_ID],
  ] as const) {
    test(`장소 상세 · ${name}: 바다 정보가 와도 밀리지 않음`, async ({
      page,
    }) => {
      await slowDown(page);
      await page.goto(`/spots/${slugOf(id)}/`);
      await expect(page.locator("section[aria-busy='true']")).toHaveCount(0, {
        timeout: 10_000,
      });
      await page.waitForTimeout(1500);
      expect(await cls(page)).toBeLessThan(LIMIT);
    });
  }

  // 주소(?tab·?q·?beach)를 읽는 화면은 정적 HTML에 짧은 대기 화면만 그려짐. 바닥글이 첫 화면에 보였다가 밀리지 않아야 함
  // (본문 최소 높이 app-shell. 탐색은 요약 줄 세 줄 높이. 고치기 전 탐색 0.76·즐겨찾기 0.27로 실패 확인)
  test.describe("탐색 목록", () => {
    test.use({ exploreView: "list" });
    test("요약 줄·목록이 들어와도 밀리지 않음", async ({ page }) => {
      await slowDown(page);
      await page.goto("/explore/");
      await expect(page.getByText(/업데이트/).first()).toBeVisible({
        timeout: 10_000,
      });
      await page.waitForTimeout(1500);
      expect(await cls(page)).toBeLessThan(LIMIT);
    });
  });

  test("즐겨찾기 · 해변 3곳", async ({ page }) => {
    await page.addInitScript(
      (ids) => localStorage.setItem("baradun:favorites", JSON.stringify(ids)),
      [WARNING_ID, CLEAR_ID, DELAYED_ID],
    );
    await slowDown(page);
    await page.goto("/favorites/");
    await expect(
      page.getByRole("button", { name: /즐겨찾기에서 빼기/ }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1500);
    expect(await cls(page)).toBeLessThan(LIMIT);
  });

  // 검색·문의는 모바일 기기 흉내(isMobile)를 켜면 Chromium이 이 밀림을 layout-shift로 기록하지 않음(같은 빌드에서 0건)
  // 같은 390×844 창에서 기기 흉내만 끄고 잼(고치기 전 검색 0.21·문의 0.45로 실패 확인)
  test.describe("주소를 읽는 화면", () => {
    test.use({ isMobile: false, hasTouch: false });

    test("검색 · 입력 전(최근 본 해변 있음)", async ({ page }) => {
      await page.addInitScript(
        (ids) => localStorage.setItem("baradun:recent", JSON.stringify(ids)),
        [WARNING_ID, CLEAR_ID],
      );
      await slowDown(page);
      await page.goto("/search/");
      await expect(page.getByRole("combobox").first()).toBeVisible({
        timeout: 10_000,
      });
      await page.waitForTimeout(1500);
      expect(await cls(page)).toBeLessThan(LIMIT);
    });

    test("데이터 문의 · 해변 자동 채움", async ({ page }) => {
      await slowDown(page);
      await page.goto(`/settings/inquiry/?beach=${slugOf(WARNING_ID)}`);
      await expect(page.getByRole("button", { name: "보내기" })).toBeVisible({
        timeout: 10_000,
      });
      await page.waitForTimeout(1500);
      expect(await cls(page)).toBeLessThan(LIMIT);
    });
  });
});
