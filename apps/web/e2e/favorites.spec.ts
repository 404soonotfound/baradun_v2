import type { Page } from "@playwright/test";

import {
  CLEAR_ID,
  DELAYED_ID,
  expect,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  NO_STATION_ID,
  test,
  UNKNOWN_ID,
  WARNING_ID,
} from "./fixtures";

// 즐겨찾기 시안 B: PC 비교 표·모바일 해변별 덩어리·최근 본·빈 상태·정렬·포커스 (GH-530)

async function seedFavorites(
  page: Page,
  {
    favorites = [],
    recent = [],
    visits = {},
    sort,
  }: {
    favorites?: string[];
    recent?: string[];
    visits?: Record<string, { at: string; activity: null }>;
    sort?: "status" | "added";
  },
) {
  await page.addInitScript(
    ({ favorites, recent, visits, sort }) => {
      if (sessionStorage.getItem("e2e:fav-seeded")) return;
      sessionStorage.setItem("e2e:fav-seeded", "1");
      localStorage.setItem("baradun:favorites", JSON.stringify(favorites));
      localStorage.setItem("baradun:recent", JSON.stringify(recent));
      localStorage.setItem("baradun:recent-visits", JSON.stringify(visits));
      if (sort) localStorage.setItem("baradun:favorites-sort", sort);
    },
    { favorites, recent, visits, sort },
  );
}

// 현재 보이는 해변 링크 제목 순서 (PC 표는 table 안, 모바일은 ul 안 첫 줄)
async function visibleBeachNames(page: Page, desktop: boolean) {
  const selector = desktop
    ? "main table tbody tr th a[href*='/spots/'] .text-title-s"
    : "main ul li a[href*='/spots/'] > span:first-child .text-title-s";
  return page.locator(selector).allTextContents();
}

test.describe("빈 상태", () => {
  test("즐겨찾기가 비고 최근 본이 있으면 탐색·최근 본 보기 버튼을 함께 보여줌", async ({
    page,
  }) => {
    await seedFavorites(page, {
      favorites: [],
      recent: [CLEAR_ID, WARNING_ID],
    });
    await page.goto("/favorites/");
    await expect(page.getByText("아직 즐겨찾기한 해변이 없어요")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "탐색에서 해변 찾기" }),
    ).toHaveAttribute("href", "/explore/");
    const viewRecent = page.getByRole("button", {
      name: "최근 본 해변 2곳 보기",
    });
    await expect(viewRecent).toBeVisible();
    await expect(
      page.getByText(/즐겨찾기와 최근 본 해변은 이 기기에만 저장돼요/),
    ).toBeVisible();
    await expectNoA11yViolations(page);
    await expectNoHorizontalScroll(page);

    await viewRecent.click();
    await expect(page).toHaveURL(/\/favorites\/\?tab=recent$/);
    await expect(
      page.getByRole("button", { name: "최근 본", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByText("강문해수욕장").filter({ visible: true }),
    ).toBeVisible();
  });

  test("최근 본도 비어 있으면 최근 본 보기 버튼이 없고 다크 모드 axe도 통과함", async ({
    page,
  }) => {
    await seedFavorites(page, { favorites: [], recent: [] });
    await page.goto("/favorites/");
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await expect(page.getByText("아직 즐겨찾기한 해변이 없어요")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /최근 본 해변/ }),
    ).toHaveCount(0);
    await expectNoA11yViolations(page);
  });
});

test.describe("비교 표·덩어리·정렬·상태", () => {
  test("상태 먼저 정렬(이용불가→판단불가→특보 없음), 측정소 없음·관측 지연·사진·다크 밝기, 넣은 순서 전환", async ({
    page,
  }, info) => {
    const desktop = info.project.name === "desktop";
    await seedFavorites(page, {
      favorites: [CLEAR_ID, NO_STATION_ID, DELAYED_ID, WARNING_ID],
    });
    await page.goto("/favorites/");

    // 상태 먼저: 경포(풍랑주의보) → 사근진(관측 지연) → 강문·도직(특보 없음, 넣은 순 유지)
    await expect
      .poll(() => visibleBeachNames(page, desktop))
      .toEqual([
        "경포해수욕장",
        "사근진해수욕장",
        "강문해수욕장",
        "도직해수욕장",
      ]);

    // 요약 줄과 PC 표 접근성 이름·열 머리 scope
    await expect(page.getByText("4곳", { exact: true })).toBeVisible();
    await expect(
      page.getByText("출처: 기상청 (특보·해양 관측 자료를 가공)"),
    ).toBeVisible();
    await expect(
      page
        .locator("main")
        .getByText(/최종 판단은 현장 통제와 안전요원 안내가 우선이에요/),
    ).toBeVisible();

    if (desktop) {
      const table = page.getByRole("table", {
        name: "즐겨찾기 해변 상태 비교 표",
      });
      await expect(table).toBeVisible();
      await expect(table.locator('thead th[scope="col"]')).toHaveCount(8);
      // 측정소 없는 도직해수욕장은 파고~측정 4칸을 합침
      const dojikRow = table.locator("tbody tr", { hasText: "도직해수욕장" });
      await expect(dojikRow.locator('td[colspan="4"]')).toHaveText(
        "가까운 관측 없음",
      );
    } else {
      await expect(
        page.getByText("가까운 관측 없음").filter({ visible: true }),
      ).toBeVisible();
    }

    // 관측 지연 해변은 지연 파고 값(0.9m)을 숨기고 '늦어짐'·'측정이 늦어지고 있어요'를 보임
    await expect(page.getByText(/0\.9\s*m/)).toHaveCount(0);
    await expect(
      page.getByText("늦어짐").filter({ visible: true }),
    ).toBeVisible();

    // 사진 있는 해변(강문)은 1×1 이미지 + 다크 90% 밝기, 사진 없는 해변(도직)은 해변 그림
    const visibleImg = page
      .locator("main img")
      .filter({ visible: true })
      .first();
    await expect(visibleImg).toBeVisible();
    await expect
      .poll(() =>
        visibleImg.evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await expect(visibleImg).toHaveCSS("filter", "brightness(0.9)");
    await expectNoA11yViolations(page);

    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "light"),
    );
    await expectNoA11yViolations(page);
    await expectNoHorizontalScroll(page);

    // 정렬 변경: 상태 먼저 → 넣은 순서 (기기 저장·새로고침 유지)
    const sortButton = page.getByRole("button", { name: /정렬 상태 먼저/ });
    await sortButton.click();
    await page.getByRole("button", { name: "넣은 순서" }).click();
    await expect
      .poll(() => visibleBeachNames(page, desktop))
      .toEqual([
        "강문해수욕장",
        "도직해수욕장",
        "사근진해수욕장",
        "경포해수욕장",
      ]);
    expect(
      await page.evaluate(() => localStorage.getItem("baradun:favorites-sort")),
    ).toBe("added");

    await page.reload();
    await expect
      .poll(() => visibleBeachNames(page, desktop))
      .toEqual([
        "강문해수욕장",
        "도직해수욕장",
        "사근진해수욕장",
        "경포해수욕장",
      ]);
  });
});

test.describe("사진 받기 실패", () => {
  test.use({ photos: "fail" });

  test("사진을 받지 못하면 해변 그림으로 바꿈", async ({ page }) => {
    await seedFavorites(page, { favorites: [CLEAR_ID, UNKNOWN_ID] });
    await page.goto("/favorites/");
    await expect(
      page.getByText("강문해수욕장").filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page.locator("main img").filter({ visible: true }),
    ).toHaveCount(0);
    await expectNoA11yViolations(page);
  });
});

test.describe("별로 빼기·넣기·최근 본 지우기", () => {
  test("별로 빼면 포커스가 다음 줄 별로 옮겨지고, 토스트 되돌리기로 복구됨", async ({
    page,
  }, info) => {
    const desktop = info.project.name === "desktop";
    await seedFavorites(page, { favorites: [WARNING_ID, DELAYED_ID] });
    await page.goto("/favorites/");
    await expect
      .poll(() => visibleBeachNames(page, desktop))
      .toEqual(["경포해수욕장", "사근진해수욕장"]);

    const firstStar = page
      .getByRole("button", { name: "경포해수욕장 즐겨찾기에서 빼기" })
      .filter({ visible: true });
    await firstStar.focus();
    await page.keyboard.press("Enter");

    await expect(
      page.getByText("경포해수욕장").filter({ visible: true }),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole("button", { name: "사근진해수욕장 즐겨찾기에서 빼기" })
        .filter({ visible: true }),
    ).toBeFocused();

    // 되돌리기
    const toast = page
      .getByRole("status")
      .filter({ hasText: "즐겨찾기에서 뺐어요" });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "되돌리기" }).click();
    await expect
      .poll(() => visibleBeachNames(page, desktop))
      .toEqual(["경포해수욕장", "사근진해수욕장"]);
    // 토스트 버튼이 사라져도 포커스는 되돌린 해변의 별로
    await expect(
      page
        .getByRole("button", { name: "경포해수욕장 즐겨찾기에서 빼기" })
        .filter({ visible: true }),
    ).toBeFocused();

    // 마지막 항목까지 빼면 포커스가 제목으로 옮겨지고 빈 상태가 됨
    await page
      .getByRole("button", { name: "경포해수욕장 즐겨찾기에서 빼기" })
      .filter({ visible: true })
      .click();
    await page
      .getByRole("button", { name: "사근진해수욕장 즐겨찾기에서 빼기" })
      .filter({ visible: true })
      .click();
    await expect(page.getByText("아직 즐겨찾기한 해변이 없어요")).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "즐겨찾기" }),
    ).toBeFocused();
  });

  test("최근 본: 본 시각 표시 · 빈 별로 넣기 · 모두 지우기 및 되돌리기", async ({
    page,
  }, info) => {
    const desktop = info.project.name === "desktop";
    const visitedIso = new Date(Date.now() - 5 * 60_000).toISOString();
    await seedFavorites(page, {
      favorites: [CLEAR_ID],
      recent: [WARNING_ID, CLEAR_ID],
      visits: {
        [WARNING_ID]: { at: visitedIso, activity: null },
        [CLEAR_ID]: { at: visitedIso, activity: null },
      },
    });
    await page.goto("/favorites/?tab=recent");

    // 최근에 본 순(경포 → 강문) + 본 시각
    await expect
      .poll(() => visibleBeachNames(page, desktop))
      .toEqual(["경포해수욕장", "강문해수욕장"]);
    await expect(page.getByText("최근 본 2곳")).toBeVisible();
    await expect(page.getByText("최근에 본 순")).toBeVisible();
    await expect(
      page
        .getByText(/(?:오늘|어제) \d{2}:\d{2} 봄/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    // 즐겨찾기 아닌 경포해수욕장의 빈 별 누르면 즐겨찾기에 들어가고 포커스 유지
    const addStar = page
      .getByRole("button", { name: "경포해수욕장 즐겨찾기에 넣기" })
      .filter({ visible: true });
    await addStar.focus();
    await page.keyboard.press("Enter");

    const addedStar = page
      .getByRole("button", { name: "경포해수욕장 즐겨찾기에서 빼기" })
      .filter({ visible: true });
    await expect(addedStar).toBeVisible();
    await expect(addedStar).toBeFocused();
    await expect(
      page.getByRole("button", { name: "즐겨찾기 2" }),
    ).toBeVisible();

    await expectNoA11yViolations(page);

    // 모두 지우기 + 되돌리기
    await page
      .getByRole("button", { name: "최근 본 기록 모두 지우기" })
      .click();
    await expect(page.getByText("아직 본 해변이 없어요")).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: "즐겨찾기" }),
    ).toBeFocused();

    const toast = page
      .getByRole("status")
      .filter({ hasText: "최근 본 목록을 지웠어요" });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "되돌리기" }).click();
    await expect
      .poll(() => visibleBeachNames(page, desktop))
      .toEqual(["경포해수욕장", "강문해수욕장"]);
    await expect(
      page.getByRole("heading", { level: 1, name: "즐겨찾기" }),
    ).toBeFocused();
  });
});

test.describe("영어 · 오래된 정보 · 터치 영역", () => {
  test("영어 화면 즐겨찾기·최근 본과 접근성", async ({ page }) => {
    const visitedIso = new Date(Date.now() - 5 * 60_000).toISOString();
    await seedFavorites(page, {
      favorites: [WARNING_ID, CLEAR_ID, NO_STATION_ID],
      recent: [WARNING_ID, CLEAR_ID],
      visits: {
        [WARNING_ID]: { at: visitedIso, activity: null },
        [CLEAR_ID]: { at: visitedIso, activity: null },
      },
    });
    await page.goto("/en/favorites/");
    await expect(page.getByText("3 beaches")).toBeVisible();
    await expect(
      page.getByText("No nearby observation").filter({ visible: true }),
    ).toBeVisible();
    await expectNoA11yViolations(page);

    await page
      .getByRole("button", { name: "Recently viewed", exact: true })
      .click();
    await expect(page.getByText("2 recently viewed")).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("오프라인으로 오래된 정보가 섞이면 요약 줄과 목록에 이후 확인 못 함을 붙임", async ({
    page,
    context,
    data,
  }) => {
    await seedFavorites(page, { favorites: [WARNING_ID, CLEAR_ID] });
    await page.goto("/favorites/");
    await expect(page.getByText("2곳", { exact: true })).toBeVisible();

    data.set("noData");
    await context.setOffline(true);
    await expect(
      page
        .getByText(/\d{2}:\d{2} 확인 · 이후 확인 못 함/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("모바일 목록 상태에서도 버튼·별 누르는 영역이 44px 이상임", async ({
    page,
  }, info) => {
    test.skip(info.project.name !== "mobile");
    await seedFavorites(page, {
      favorites: [WARNING_ID, CLEAR_ID],
      recent: [WARNING_ID, CLEAR_ID],
    });
    await page.goto("/favorites/");
    await expect(
      page.getByText("경포해수욕장").filter({ visible: true }),
    ).toBeVisible();

    for (const locator of [
      page.getByRole("button", { name: /정렬 상태 먼저/ }),
      page
        .getByRole("button", { name: "경포해수욕장 즐겨찾기에서 빼기" })
        .filter({ visible: true }),
      page
        .getByRole("button", { name: "강문해수욕장 즐겨찾기에서 빼기" })
        .filter({ visible: true }),
    ]) {
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    await page.getByRole("button", { name: "최근 본", exact: true }).click();
    const clearBox = await page
      .getByRole("button", { name: "최근 본 기록 모두 지우기" })
      .boundingBox();
    expect(clearBox).not.toBeNull();
    expect(clearBox!.width).toBeGreaterThanOrEqual(44);
    expect(clearBox!.height).toBeGreaterThanOrEqual(44);
  });
});
