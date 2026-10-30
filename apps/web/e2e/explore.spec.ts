import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Beach } from "@baradun/contracts";
import type { Page } from "@playwright/test";

import { expect, expectNoA11yViolations, test } from "./fixtures";

// 탐색 지역 버튼·정렬·처음 보기 (BRD-128 · 2026-10-30 사용자 결정)
// 1. 활동으로 거르지 않음(활동 칩 없음, 숨은 필터 없음) 2. 지역은 버튼 하나 → 홈과 같은 지역 시트
// 3. '상태별 | 가까운 순'. 위치가 없으면 이름 순 + 위치 안내 4. 모바일 처음 보기는 지도(고른 보기는 기억)

// 시험 기기의 기본 지역(강원 강릉시)에 노출 중인 해변 수. 활동 정보와 관계없이 전부
const GANGNEUNG_COUNT = readdirSync(
  path.join(__dirname, "../../../data/beaches"),
)
  .filter((file) => file.endsWith(".json"))
  .map(
    (file) =>
      JSON.parse(
        readFileSync(
          path.join(__dirname, "../../../data/beaches", file),
          "utf8",
        ),
      ) as Beach,
  )
  .filter(
    (beach) =>
      !beach.hidden &&
      beach.region.sido.ko === "강원" &&
      beach.region.sigungu.ko === "강릉시",
  ).length;

const viewGroup = (page: Page) =>
  page.getByRole("group", { name: "목록·지도 보기" });
const sortGroup = (page: Page) =>
  page.getByRole("group", { name: "목록 보기 방식" });
// 모바일 목록 보기는 개수 줄이 보기 줄 아래, PC·지도 보기는 보기 줄 안이라 보이는 것만 셈
const countText = (page: Page) =>
  page
    .getByText(`전체 ${GANGNEUNG_COUNT}곳`, { exact: true })
    .filter({ visible: true });
const rowNames = (page: Page) =>
  page.locator("main li .text-title-s").allTextContents();

// 위치 권한을 아직 묻지 않은 기기에서, 묻는 창의 결과를 code로 정함(1 거부 · 2 위치를 알 수 없음 · 3 시간 초과)
// 실제 위치는 쓰지 않음
async function locationFailsWith(page: Page, code: 1 | 2 | 3) {
  await page.addInitScript((code) => {
    const status = {
      state: "prompt",
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
    };
    Object.defineProperty(navigator.permissions, "query", {
      value: () => Promise.resolve(status),
    });
    Object.defineProperty(navigator.geolocation, "getCurrentPosition", {
      value: (_ok: unknown, fail: (error: unknown) => void) =>
        fail({
          code,
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
          message: "test",
        }),
    });
  }, code);
}

test.describe("처음 보기", () => {
  test("모바일은 지도로 시작하고, 고른 보기는 기억함 · PC는 목록과 지도를 함께", async ({
    page,
  }, info) => {
    await page.goto("/explore/");
    if (info.project.name === "desktop") {
      await expect(viewGroup(page)).toBeHidden();
      await expect(sortGroup(page)).toBeVisible();
      await expect(countText(page)).toBeVisible();
      return;
    }
    await expect(
      viewGroup(page).getByRole("button", { name: "지도" }),
    ).toHaveAttribute("aria-pressed", "true");
    // 지도 보기 위쪽: 지역 버튼 · 개수 · 보기 전환(Figma 174:894). 정렬·목록은 숨김
    await expect(
      page.getByRole("button", { name: "지역 고르기, 지금 강원 강릉시" }),
    ).toBeVisible();
    await expect(countText(page)).toBeVisible();
    await expect(sortGroup(page)).toBeHidden();
    await expectNoA11yViolations(page);

    await viewGroup(page).getByRole("button", { name: "목록" }).click();
    await expect(sortGroup(page)).toBeVisible();
    await page.reload();
    await expect(
      viewGroup(page).getByRole("button", { name: "목록" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("활동으로 거르지 않음", () => {
  test.use({ exploreView: "list" });

  test("홈에서 서핑을 골라 둬도 탐색·검색은 고른 지역의 모든 해변", async ({
    page,
  }) => {
    await page.addInitScript(() =>
      localStorage.setItem("baradun:activity", "surfing"),
    );
    await page.goto("/explore/");
    await expect(countText(page)).toBeVisible();
    // 활동 칩 묶음·활동 안내 문구 없음
    await expect(page.getByRole("group", { name: "활동" })).toHaveCount(0);
    await expect(page.getByText(/활동 정보가 확인된/)).toHaveCount(0);

    // 검색 범위도 지역만("서핑 · 강원 강릉시"가 아님). 수영만 있는 강문해변도 찾음
    await page.goto("/search/?q=강문");
    await expect(
      page.getByRole("button", { name: "강원 강릉시 범위 빼기" }),
    ).toBeVisible();
    await expect(page.getByText(/서핑/)).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: /강문해수욕장/ }),
    ).toBeVisible();
  });
});

test.describe("지역 버튼", () => {
  test.use({ exploreView: "list" });

  test("버튼 하나로 홈과 같은 지역 시트를 열고, 고르면 저장하고 닫힘", async ({
    page,
  }) => {
    await page.goto("/explore/");
    // 지역 칩 줄 없음
    await expect(page.getByRole("group", { name: "지역" })).toHaveCount(0);
    await page
      .getByRole("button", { name: "지역 고르기, 지금 강원 강릉시" })
      .click();
    const dialog = page.getByRole("dialog", { name: "지역 고르기" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "강원 전체" }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("button", { name: "지역 고르기, 지금 강원" }),
    ).toBeFocused();
    expect(
      await page.evaluate(() => localStorage.getItem("baradun:region")),
    ).toBe(JSON.stringify({ sido: "강원", sigungu: null }));
  });
});

test.describe("가까운 순", () => {
  test.use({ exploreView: "list" });

  for (const [name, code, title] of [
    ["거부", 1, "위치 권한이 꺼져 있어요"],
    ["위치를 알 수 없음", 2, "위치를 확인하지 못했어요"],
    ["시간 초과", 3, "위치를 확인하지 못했어요"],
  ] as const) {
    test(`위치 요청이 ${name}로 끝나면 이름 순 + 안내`, async ({ page }) => {
      await locationFailsWith(page, code);
      await page.goto("/explore/");
      // 버튼 이름은 위치와 관계없이 늘 '가까운 순'
      const near = sortGroup(page).getByRole("button", { name: "가까운 순" });
      await expect(near).toBeVisible();
      await expect(page.getByText(title)).toHaveCount(0);

      await near.click();
      await expect(near).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByText(title)).toBeVisible();
      await expect(
        page.getByText("거리 없이 이름 순으로 보여드려요"),
      ).toBeVisible();
      await expect(
        page.locator("main li").filter({ hasText: /km/ }),
      ).toHaveCount(0);
      const names = await rowNames(page);
      expect(names.length).toBe(GANGNEUNG_COUNT);
      expect(names).toEqual(
        [...names].sort((a, b) => a.localeCompare(b, "ko")),
      );
      await expectNoA11yViolations(page);
    });
  }

  test("아직 묻지 않았으면 상태별에서는 묻지 않고 안내도 없음", async ({
    page,
  }) => {
    let asked = 0;
    await page.exposeFunction("e2eAsked", () => (asked += 1));
    await page.addInitScript(() => {
      Object.defineProperty(navigator.permissions, "query", {
        value: () =>
          Promise.resolve({
            state: "prompt",
            onchange: null,
            addEventListener() {},
            removeEventListener() {},
          }),
      });
      Object.defineProperty(navigator.geolocation, "getCurrentPosition", {
        value: () => (window as unknown as { e2eAsked: () => void }).e2eAsked(),
      });
    });
    await page.goto("/explore/");
    await expect(
      sortGroup(page).getByRole("button", { name: "상태별" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/특보 없음 \d+곳/)).toBeVisible();
    await expect(page.getByText("위치를 쓰지 않고 있어요")).toHaveCount(0);
    expect(asked).toBe(0);
  });
});
