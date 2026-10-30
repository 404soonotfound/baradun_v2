import type { Page } from "@playwright/test";

import {
  CLEAR_ID,
  coordsOf,
  expect,
  expectNoA11yViolations,
  PUBLIC_BEACH_COUNT,
  test,
} from "./fixtures";

// 홈 지역 고르기 '전국'과 기본값 전국 (BRD-127 · 2026-10-29 사용자 요청)
// 저장값이 없고 위치도 없으면 전국, 고른 지역은 그대로, 위치를 허용하면 가까운 바다(위치 흐름 그대로)

const TEXT = {
  ko: {
    home: "/",
    explore: "/explore/",
    sheet: "지역 고르기",
    opener: (region: string) => `지역 고르기, 지금 ${region}`,
    nationwide: "전국",
    nationwideSea: "전국 바다",
    nationwideCount: `전국 해변 ${PUBLIC_BEACH_COUNT}곳 지금 상태`,
    // PC는 개수 카드 대신 히어로 요약 줄(BRD-129, Figma 181:789)
    nationwideSummary: `전국 바다 ${PUBLIC_BEACH_COUNT}곳의 특보·측정 상태예요`,
    offTitle: "위치 없이 보고 있어요",
    offDefault:
      "전국 해변을 이름 순으로 보여드려요. 위치를 켜면 가까운 바다를 보여드려요.",
    offChosen:
      "전국 해변을 이름 순으로 보여드려요. 위치를 켜면 거리도 함께 보여드려요.",
    offRegion:
      "고른 지역 해변을 보여드려요. 위치를 켜면 거리도 함께 보여드려요.",
    gangwon: "강원",
    gangwonAll: "강원 전체",
    gangwonSea: "강원 바다",
    gangneungSea: "강원 강릉시 바다",
    back: "시·도 다시 고르기",
    nearby: "내 주변",
    nearSea: "가까운 바다",
    all: "전체 보기",
    settings: "/settings/",
    defaultRegion: "기본 지역",
    clearRegion: "기본 지역 지우기",
    gangneung: "강원 강릉시",
    sortNear: "가까운 순",
  },
  en: {
    home: "/en/",
    explore: "/en/explore/",
    sheet: "Choose a region",
    opener: (region: string) => `Choose region, now ${region}`,
    nationwide: "All Korea",
    nationwideSea: "Seas across Korea",
    nationwideCount: `${PUBLIC_BEACH_COUNT} beaches across Korea right now`,
    nationwideSummary: `Warnings and measurements for ${PUBLIC_BEACH_COUNT} beaches in All Korea`,
    offTitle: "Viewing without location",
    offDefault:
      "Showing beaches across Korea by name. Turn on location to see nearby beaches.",
    offChosen:
      "Showing beaches across Korea by name. Turn on location to see distances too.",
    offRegion:
      "Showing beaches in your chosen region. Turn on location to see distances too.",
    gangwon: "Gangwon",
    gangwonAll: "All of Gangwon",
    gangwonSea: "Seas in Gangwon",
    gangneungSea: "Seas in Gangwon Gangneung",
    back: "Choose province again",
    nearby: "Near me",
    nearSea: "Nearby beaches",
    all: "See all",
    settings: "/en/settings/",
    defaultRegion: "Default region",
    clearRegion: "Clear default region",
    gangneung: "Gangwon Gangneung",
    sortNear: "Nearest",
  },
} as const;

type Text = (typeof TEXT)[keyof typeof TEXT];

const savedRegion = (page: Page) =>
  page.evaluate(() => localStorage.getItem("baradun:region"));

// 가까운 바다 묶음의 제목(h2)
const seaHeading = (page: Page) => page.locator("#home-near");

// current: 지역 버튼이 말하는 지금 범위. null이면 이름은 보지 않음(가까운 해변 지역은 좌표에 따라 다름)
async function openSheet(page: Page, text: Text, current: string | null) {
  const name =
    current === null ? new RegExp(`^${text.opener("")}`) : text.opener(current);
  await page.getByRole("button", { name }).click();
  const dialog = page.getByRole("dialog", { name: text.sheet });
  await expect(dialog).toBeVisible();
  return dialog;
}

// 위치 권한을 거부한 기기처럼(묻는 창 없이 거부). 실제 위치는 쓰지 않음
async function denyLocation(page: Page) {
  await page.addInitScript(() => {
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
      value: (_ok: unknown, fail: (error: unknown) => void) =>
        fail({ code: 1, PERMISSION_DENIED: 1, message: "denied" }),
    });
  });
}

// 전국 해변 수: 모바일은 상태별 개수 카드(링크), PC는 히어로 요약 줄(BRD-129 · 개수 카드는 모바일만)
async function expectNationwideCount(
  page: Page,
  text: (typeof TEXT)[keyof typeof TEXT],
) {
  if (test.info().project.name === "desktop") {
    await expect(
      page.getByText(new RegExp(text.nationwideSummary)),
    ).toBeVisible();
  } else {
    await expect(
      page.getByRole("link", { name: new RegExp(text.nationwideCount) }),
    ).toBeVisible();
  }
}

for (const locale of ["ko", "en"] as const) {
  const text = TEXT[locale];

  test.describe(`${locale} · 저장값 없음`, () => {
    test.use({ deviceLanguage: locale, deviceRegion: null });

    test("처음 방문하면 전국 바다와 전국 개수, 저장값은 쓰지 않음", async ({
      page,
    }) => {
      await page.goto(text.home);
      await expect(
        page.getByRole("heading", { level: 2, name: text.nationwideSea }),
      ).toBeVisible();
      await expectNationwideCount(page, text);
      await expect(
        page.getByRole("button", { name: text.opener(text.nationwide) }),
      ).toBeVisible();
      // 위치를 아직 묻지 않은 기기: 무슨 일(위치 없이) → 영향(전국 이름 순) → 다음 행동(위치 켜기)
      await expect(page.getByText(text.offTitle)).toBeVisible();
      await expect(page.getByText(text.offDefault)).toBeVisible();
      expect(await savedRegion(page)).toBeNull();
      await expectNoA11yViolations(page);
    });

    test("시트 맨 앞 전국 ↔ 시·도 전환, 새로고침 뒤 유지", async ({ page }) => {
      await page.goto(text.home);
      let dialog = await openSheet(page, text, text.nationwide);
      // 시·도 단계 칩(닫기 버튼 제외). 맨 앞은 전국(기본값이라 선택됨). '내 주변'은 그다음
      const chips = dialog.locator(".flex-wrap > button");
      await expect(chips.first()).toHaveAccessibleName(text.nationwide);
      await expect(chips.first()).toHaveAttribute("aria-pressed", "true");
      await expect(chips.nth(1)).toHaveAccessibleName(text.nearby);
      await expect(
        dialog.getByRole("button", { name: text.nearby }),
      ).toHaveAttribute("aria-pressed", "false");
      // 열림 움직임(투명도)이 끝난 뒤 대비를 봄(interaction.spec.ts checkSheet와 같음)
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.playState !== "running" ||
              animation.effect?.getTiming().iterations === Infinity,
          ),
      );
      await expectNoA11yViolations(page);

      await dialog.getByRole("button", { name: text.gangwon }).click();
      await dialog.getByRole("button", { name: text.gangwonAll }).click();
      await expect(dialog).toBeHidden();
      await expect(seaHeading(page)).toHaveText(text.gangwonSea);
      await expect(page.getByText(text.offRegion)).toBeVisible();

      await page.reload();
      await expect(seaHeading(page)).toHaveText(text.gangwonSea);

      dialog = await openSheet(page, text, text.gangwon);
      await dialog.getByRole("button", { name: text.back }).click();
      const nationwide = dialog.getByRole("button", { name: text.nationwide });
      await expect(nationwide).toHaveAttribute("aria-pressed", "false");
      await nationwide.click();
      await expect(dialog).toBeHidden();
      await expect(seaHeading(page)).toHaveText(text.nationwideSea);
      await expect(page.getByText(text.offChosen)).toBeVisible();
      expect(await savedRegion(page)).toBe('"nationwide"');

      await page.reload();
      await expect(seaHeading(page)).toHaveText(text.nationwideSea);
    });

    test("전체 보기는 탐색 전국으로 이어짐", async ({ page }) => {
      await page.goto(text.home);
      await expect(seaHeading(page)).toHaveText(text.nationwideSea);
      await page
        .getByRole("region", { name: text.nationwideSea })
        .getByRole("link", { name: text.all })
        .click();
      await expect(page).toHaveURL(new RegExp(`${text.explore}$`));
      // 탐색 지역 버튼(BRD-128)도 전국이고, 시트의 '전국'이 고른 것으로 보임
      const dialog = await openSheet(page, text, text.nationwide);
      await expect(
        dialog.getByRole("button", { name: text.nationwide, exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      // 탐색 시트에는 '내 주변'이 없음(가까운 해변은 정렬 '가까운 순')
      await expect(
        dialog.getByRole("button", { name: text.nearby }),
      ).toHaveCount(0);
    });
  });

  test.describe(`${locale} · 이미 고른 지역`, () => {
    test.use({ deviceLanguage: locale });

    test("저장된 지역은 그대로 보여주고 저장값을 바꾸지 않음", async ({
      page,
    }) => {
      await page.goto(text.home);
      await expect(seaHeading(page)).toHaveText(text.gangneungSea);
      expect(await savedRegion(page)).toBe(
        JSON.stringify({ sido: "강원", sigungu: "강릉시" }),
      );
    });
  });

  test.describe(`${locale} · 위치 거부`, () => {
    test.use({ deviceLanguage: locale, deviceRegion: null });

    test("고르기 전은 전국, 고른 뒤는 그 지역. '내 주변'은 없고 위치를 다시 묻지 않음", async ({
      page,
    }) => {
      await denyLocation(page);
      await page.goto(text.home);
      await expect(seaHeading(page)).toHaveText(text.nationwideSea);
      await expect(page.getByText(text.offDefault)).toBeVisible();

      const dialog = await openSheet(page, text, text.nationwide);
      await expect(
        dialog.getByRole("button", { name: text.nearby }),
      ).toHaveCount(0);
      await expect(
        dialog.getByRole("button", { name: text.nationwide }),
      ).toHaveAttribute("aria-pressed", "true");
      await dialog.getByRole("button", { name: text.gangwon }).click();
      await dialog.getByRole("button", { name: text.gangwonAll }).click();
      await expect(seaHeading(page)).toHaveText(text.gangwonSea);
      await expect(page.getByText(text.offRegion)).toBeVisible();
    });
  });

  test.describe(`${locale} · 위치 허용`, () => {
    // 시험용 좌표(강릉 시험 해변 위치, 사용자 위치 아님)
    const coords = coordsOf(CLEAR_ID);
    test.use({
      deviceLanguage: locale,
      deviceRegion: null,
      permissions: ["geolocation"],
      ...(coords && {
        geolocation: { latitude: coords.lat, longitude: coords.lng },
      }),
    });

    test("저장값이 없으면 가까운 바다, 전국을 고르면 위치가 있어도 전국, '내 주변'으로 돌아감", async ({
      page,
    }) => {
      await page.goto(text.home);
      await expect(seaHeading(page)).toHaveText(text.nearSea);
      await expect(page.getByText(text.offTitle)).toHaveCount(0);

      let dialog = await openSheet(page, text, null);
      await expect(
        dialog.getByRole("button", { name: text.nearby }),
      ).toHaveAttribute("aria-pressed", "true");
      await dialog.getByRole("button", { name: text.nationwide }).click();
      await expect(seaHeading(page)).toHaveText(text.nationwideSea);
      await expectNationwideCount(page, text);

      dialog = await openSheet(page, text, text.nationwide);
      await dialog.getByRole("button", { name: text.nearby }).click();
      await expect(seaHeading(page)).toHaveText(text.nearSea);
      expect(await savedRegion(page)).toBeNull();
    });
  });

  // 설정 '기본 지역'(10/29 사용자 결정: 저장값이 없으면 '고르지 않음' 대신 '전국')
  test.describe(`${locale} · 설정 기본 지역`, () => {
    // '기본 지역' 줄 바로 아래 값
    const regionValue = (page: Page) =>
      page
        .getByText(text.defaultRegion, { exact: true })
        .locator("xpath=following-sibling::p[1]");

    test.describe("저장값 없음", () => {
      test.use({ deviceLanguage: locale, deviceRegion: null });
      test("전국으로 보이고 지울 값이 없어 지우기 버튼이 없음", async ({
        page,
      }) => {
        await page.goto(text.settings);
        await expect(regionValue(page)).toHaveText(text.nationwide);
        await expect(
          page.getByRole("button", { name: text.clearRegion }),
        ).toHaveCount(0);
        expect(await savedRegion(page)).toBeNull();
      });
    });

    test.describe("고른 전국", () => {
      test.use({ deviceLanguage: locale, deviceRegion: '"nationwide"' });
      test("전국으로 보이고, 지우면 저장값 없이 그대로 전국", async ({
        page,
      }) => {
        await page.goto(text.settings);
        await expect(regionValue(page)).toHaveText(text.nationwide);
        await page.getByRole("button", { name: text.clearRegion }).click();
        await expect(regionValue(page)).toHaveText(text.nationwide);
        await expect(
          page.getByRole("button", { name: text.clearRegion }),
        ).toHaveCount(0);
        expect(await savedRegion(page)).toBeNull();
      });
    });

    test.describe("고른 지역", () => {
      test.use({ deviceLanguage: locale });
      test("고른 지역 이름 그대로", async ({ page }) => {
        await page.goto(text.settings);
        await expect(regionValue(page)).toHaveText(text.gangneung);
        await expect(
          page.getByRole("button", { name: text.clearRegion }),
        ).toBeVisible();
      });
    });
  });

  // 탐색 '전국' = 전국을 고름(10/29 결정 B). 홈도 위치와 관계없이 전국, '내 주변'으로 가까운 바다
  // 탐색 지역은 버튼 하나 → 홈과 같은 지역 시트(BRD-128). 저장된 강릉시면 시·군 단계로 열려 시·도로 돌아가 '전국'
  async function pickNationwideInExplore(page: Page) {
    const dialog = await openSheet(page, text, text.gangneung);
    await dialog.getByRole("button", { name: text.back }).click();
    const nationwide = dialog.getByRole("button", {
      name: text.nationwide,
      exact: true,
    });
    await expect(nationwide).toHaveAttribute("aria-pressed", "false");
    await nationwide.click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("button", { name: text.opener(text.nationwide) }),
    ).toBeVisible();
    expect(await savedRegion(page)).toBe('"nationwide"');
  }

  test.describe(`${locale} · 탐색 전국 · 위치 허용`, () => {
    const coords = coordsOf(CLEAR_ID);
    test.use({
      deviceLanguage: locale,
      // 정렬은 목록 보기에 있음(모바일 처음 보기는 지도)
      exploreView: "list",
      permissions: ["geolocation"],
      ...(coords && {
        geolocation: { latitude: coords.lat, longitude: coords.lng },
      }),
    });

    test("탐색에서 전국 → 가까운 순 그대로 → 홈 전국(새로고침 뒤 유지) → '내 주변'으로 가까운 바다", async ({
      page,
    }) => {
      await page.goto(text.explore);
      await pickNationwideInExplore(page);
      // 위치가 있으면 가까운 순이고 행마다 거리가 나옴
      await page.getByRole("button", { name: text.sortNear }).click();
      await expect(page.locator("main li").first()).toContainText("km");

      await page.goto(text.home);
      await expect(seaHeading(page)).toHaveText(text.nationwideSea);
      await page.reload();
      await expect(seaHeading(page)).toHaveText(text.nationwideSea);

      const dialog = await openSheet(page, text, text.nationwide);
      await dialog.getByRole("button", { name: text.nearby }).click();
      await expect(seaHeading(page)).toHaveText(text.nearSea);
      expect(await savedRegion(page)).toBeNull();
      await page.reload();
      await expect(seaHeading(page)).toHaveText(text.nearSea);
    });
  });

  test.describe(`${locale} · 탐색 전국 · 위치 거부`, () => {
    test.use({ deviceLanguage: locale });

    test("탐색에서 전국 → 홈 전국(고른 전국 문구), 새로고침 뒤 유지", async ({
      page,
    }) => {
      await denyLocation(page);
      await page.goto(text.explore);
      await pickNationwideInExplore(page);

      await page.goto(text.home);
      await expect(seaHeading(page)).toHaveText(text.nationwideSea);
      await expect(page.getByText(text.offChosen)).toBeVisible();
      await page.reload();
      await expect(seaHeading(page)).toHaveText(text.nationwideSea);
    });
  });
}
