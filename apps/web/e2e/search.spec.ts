import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Beach } from "@baradun/contracts";
import type { Page } from "@playwright/test";

import { expect, expectNoA11yViolations, test } from "./fixtures";

// 검색 v5 (GH-531 · 결정 기록 29장 D29-5·D29-7): 입력 전 · 입력 중 제안(키보드) · 결과(정렬·거르기) · 결과 없음(범위 때문)
// 시험 기기의 찾는 범위는 강원 강릉시(fixtures 기본 지역). '양양'은 범위 밖이라 결과 없음 → 전국에서 찾기로 결과

const BEACHES = readdirSync(path.join(__dirname, "../../../data/beaches"))
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
  .filter((beach) => !beach.hidden);
const YANGYANG = BEACHES.filter(
  (beach) =>
    beach.region.sido.ko === "강원" && beach.region.sigungu.ko === "양양군",
);
const YANGYANG_OBSERVED = YANGYANG.filter(
  (beach) => beach.stations.waterTemp !== null,
).length;

const input = (page: Page) =>
  page.getByRole("combobox", { name: "해변·지역 검색" });

test.describe("검색 v5", () => {
  test("입력 전: 제목 · 찾는 범위 · 지역으로 찾기 · 안내, 비어 있는 최근 검색·최근 본은 숨김", async ({
    page,
  }) => {
    await page.goto("/search/");
    await expect(
      page.getByRole("heading", { level: 1, name: "검색" }),
    ).toBeVisible();
    await expect(page.getByText("찾는 범위", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "강원 강릉시 범위 빼기" }),
    ).toBeVisible();
    await expect(input(page)).toBeFocused();
    await expect(
      page.getByRole("heading", { name: "지역으로 찾기" }),
    ).toBeVisible();
    await expect(
      page.getByText(`해변 ${BEACHES.length}곳 · 지역 옆 숫자는 해변 수`),
    ).toBeVisible();
    await expect(
      page.getByText("최근 검색과 최근 본 해변은 이 기기에만 저장돼요"),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "최근 검색" })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("heading", { name: "최근 본 해변" }),
    ).toHaveCount(0);
    await expectNoA11yViolations(page);
  });

  test("결과 없음(찾는 범위 때문): 무슨 일 → 맞는 수 → 전국에서 찾기 · 데이터 문의", async ({
    page,
  }) => {
    await page.goto("/search/?q=%EC%96%91%EC%96%91"); // ?q=양양
    await expect(
      page.getByRole("heading", {
        name: "강원 강릉시에서는 ‘양양’에 맞는 해변이 없어요",
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        `찾는 범위가 강원 강릉시로 정해져 있어서 다른 지역 해변은 빠졌어요. 범위를 풀면 ${YANGYANG.length}곳이 나와요`,
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "범위를 강원 양양군으로" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: "데이터 문의로 해변 추가를 요청해 주세요",
      }),
    ).toHaveAttribute("href", "/settings/inquiry/");
    await expectNoA11yViolations(page);

    // 전국에서 찾기: 이 화면에서만 범위를 풂(저장된 지역은 그대로)
    await page.getByRole("button", { name: "전국에서 찾기" }).click();
    await expect(
      page.getByRole("heading", {
        name: new RegExp(`‘양양’ 결과 ${YANGYANG.length}곳`),
      }),
    ).toBeVisible();
    await expect(page.getByText("지역 강원 양양군과 맞음")).toBeVisible();
    // 머리의 찾는 범위가 '전국' + '범위 정하기'로 바뀜(이 화면에서만 풂)
    await expect(
      page.getByRole("button", { name: "범위 정하기" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "강원 강릉시 범위 빼기" }),
    ).toHaveCount(0);
  });

  test("결과: 8곳 + 더 보기, 거르기 '가까운 관측 있음', 이름 순", async ({
    page,
  }) => {
    await page.goto("/search/?q=%EC%96%91%EC%96%91");
    await page.getByRole("button", { name: "전국에서 찾기" }).click();
    const rows = page
      .getByRole("list")
      .filter({ has: page.locator('a[href^="/spots/"]') })
      .first()
      .getByRole("listitem");
    await expect(rows).toHaveCount(8);
    await page
      .getByRole("button", { name: `${YANGYANG.length - 8}곳 더 보기` })
      .click();
    await expect(rows).toHaveCount(YANGYANG.length);

    // 활동으로는 거르지 않음: 거르기는 '전체' · '가까운 관측 있음' 두 가지뿐
    const filters = page.getByRole("group", { name: "결과 거르기" });
    await expect(filters.getByRole("button")).toHaveCount(2);
    await filters
      .getByRole("button", { name: `가까운 관측 있음 ${YANGYANG_OBSERVED}` })
      .click();
    await expect(
      filters.getByRole("button", { name: /가까운 관측 있음/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(rows).toHaveCount(Math.min(YANGYANG_OBSERVED, 8));
    await expect(rows.filter({ hasText: "가까운 관측 없음" })).toHaveCount(0);

    await page
      .getByRole("group", { name: "결과 보기 방식" })
      .getByRole("button", { name: "이름순" })
      .click();
    const names = await rows.locator(".text-title-s").allTextContents();
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "ko")));
    await expectNoA11yViolations(page);
  });

  test("입력 중 제안: 지역 먼저 · 해변 4곳 · 모두 보기, ↑↓ · Enter · Esc", async ({
    page,
  }) => {
    await page.goto("/search/");
    await page.getByRole("button", { name: "강원 강릉시 범위 빼기" }).click();
    await input(page).pressSequentially("양양");
    const list = page.getByRole("listbox", { name: "검색 제안" });
    await expect(list).toBeVisible();
    await expect(input(page)).toHaveAttribute("aria-expanded", "true");
    const options = list.getByRole("option");
    // 지역 1 + 해변 4 + 모두 보기 1
    await expect(options).toHaveCount(6);
    await expect(options.first()).toContainText("강원 양양군");
    await expect(options.first()).toContainText(`해변 ${YANGYANG.length}곳`);
    await expect(options.last()).toContainText(
      `‘양양’ 결과 ${YANGYANG.length}곳 모두 보기`,
    );
    // 제안의 '특보 없음' 칩 근거(범위 · 기관 · 확인 시각)가 제안 안에 함께 보임
    await expect(
      list
        .locator("xpath=..")
        // 확인 시각이 어제면 'M/D HH:MM'(kstStamp). 자정 직후 실행에도 맞게 날짜 앞자리를 허용
        .getByText(
          /^특보 없음 \d+곳 · .+ · 기상청 (?:\d{1,2}\/\d{1,2} )?\d{2}:\d{2} 확인$/,
        ),
    ).toBeVisible();
    await expectNoA11yViolations(page);

    // ↓ 두 번 → 둘째 줄(첫 해변)이 고른 줄
    await input(page).press("ArrowDown");
    await input(page).press("ArrowDown");
    const second = options.nth(1);
    await expect(second).toHaveAttribute("aria-selected", "true");
    await expect(input(page)).toHaveAttribute(
      "aria-activedescendant",
      (await second.getAttribute("id"))!,
    );

    // Esc → 닫힘(검색어는 남음), 다시 ↓ → 열림, 마지막 줄(모두 보기)에서 Enter → 결과
    await input(page).press("Escape");
    await expect(list).toHaveCount(0);
    await expect(input(page)).toHaveValue("양양");
    await input(page).press("ArrowUp");
    await expect(options.last()).toHaveAttribute("aria-selected", "true");
    await input(page).press("Enter");
    await expect(list).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: new RegExp(`‘양양’ 결과 ${YANGYANG.length}곳`),
      }),
    ).toBeVisible();

    // 해변 줄 Enter → 상세로 이동
    await input(page).fill("");
    await input(page).pressSequentially("양양");
    await input(page).press("ArrowDown");
    await input(page).press("ArrowDown");
    await input(page).press("Enter");
    await expect(page).toHaveURL(/\/spots\/[^/]+\/$/);
  });

  test("별칭 검색은 지금처럼 '다른 이름이에요' 안내", async ({ page }) => {
    // 이름에는 없는 다른 이름(예: 승공 → 상맹방해수욕장)이어야 이름 일치가 아니라 별칭 일치가 됨
    const file = JSON.parse(
      readFileSync(
        path.join(__dirname, "../../../data/beach-meta.json"),
        "utf8",
      ),
    ) as { beaches: Record<string, { aliases?: string[] }> };
    const squash = (text: string) => text.replace(/\s+/g, "").toLowerCase();
    const picked = BEACHES.flatMap((beach) =>
      (file.beaches[beach.id]?.aliases ?? [])
        .filter(
          (alias) =>
            !squash(beach.name.ko).includes(squash(alias)) &&
            !squash(beach.name.en).includes(squash(alias)),
        )
        .map((alias) => ({ beach, alias })),
    )[0];
    test.skip(!picked, "이름에 없는 다른 이름이 있는 공개 해변 없음");
    await page.goto(`/search/?q=${encodeURIComponent(picked!.alias)}`);
    // 결과 또는 결과 없음이 그려진 뒤에 봄(범위 밖 해변이면 전국에서 찾기)
    const empty = page.getByRole("heading", { name: /에 맞는 해변이 없어요$/ });
    const results = page.getByRole("heading", { name: /결과 \d+곳/ });
    await expect(empty.or(results)).toBeVisible();
    if (await empty.isVisible()) {
      await page.getByRole("button", { name: "전국에서 찾기" }).click();
    }
    await expect(
      page
        .getByText(`${picked!.beach.name.ko}의 다른 이름이에요`, {
          exact: false,
        })
        .first(),
    ).toBeVisible();
  });
});
