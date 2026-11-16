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

  // 재설계 화면(GH-218 · #529~#532): 정적 HTML의 자리 표시가 실제 내용으로 바뀌어도 밀리지 않음
  test.describe("탐색 · 목록 보기", () => {
    test.use({ exploreView: "list" });
    test("상태별 묶음이 들어와도 밀리지 않음", async ({ page }) => {
      await slowDown(page);
      await page.goto("/explore/");
      await expect(
        page.getByRole("region", { name: /^특보 없음 \d+곳$/ }),
      ).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      expect(await cls(page)).toBeLessThan(LIMIT);
    });
  });

  test("검색 · 입력 전", async ({ page }) => {
    await slowDown(page);
    await page.goto("/search/");
    await expect(
      page.getByRole("heading", { name: "지역으로 찾기" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    expect(await cls(page)).toBeLessThan(LIMIT);
  });

  test.describe("검색 · 결과(전국)", () => {
    test.use({ deviceRegion: null });
    test("주소의 검색어로 결과가 들어와도 밀리지 않음", async ({ page }) => {
      await slowDown(page);
      await page.goto("/search/?q=%EC%96%91%EC%96%91");
      await expect(
        page.getByRole("heading", { name: /‘양양’ 결과 \d+곳/ }),
      ).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      expect(await cls(page)).toBeLessThan(LIMIT);
    });
  });

  test("즐겨찾기 · 해변 4곳", async ({ page }) => {
    await page.addInitScript(() =>
      localStorage.setItem(
        "baradun:favorites",
        JSON.stringify(["b0001", "b0002", "b0003", "b0004"]),
      ),
    );
    await slowDown(page);
    await page.goto("/favorites/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForTimeout(3000);
    expect(await cls(page)).toBeLessThan(LIMIT);
  });

  test("데이터 문의 · 해변에서 들어옴", async ({ page }) => {
    await slowDown(page);
    await page.goto(`/settings/inquiry/?beach=${slugOf(CLEAR_ID)}`);
    await expect(page.getByRole("region", { name: "문의할 해변" })).toBeVisible(
      { timeout: 15_000 },
    );
    await page.waitForTimeout(1500);
    expect(await cls(page)).toBeLessThan(LIMIT);
  });
});
