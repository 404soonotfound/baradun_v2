import type { Page } from "@playwright/test";

import {
  CLEAR_ID,
  expect,
  expectNoA11yViolations,
  slugOf,
  test,
} from "./fixtures";

// 화면 출처 표시 (BRD-113 · 기상법 2026-09-18 시행 출처 표시 의무, 결정 19·20)
// 기상청 자료가 보이는 화면마다 그 화면 안에 글자로 '출처: 기상청'. 링크만으로는 출처 표시로 보지 않음
const KMA_STATUS_KO = "출처: 기상청 (특보·해양 관측 자료를 가공)";
const KMA_STATUS_EN =
  "Source: KMA (warnings and ocean observations, processed)";
const KMA_BUOY_KO = "출처: 기상청 (해양기상부이·파고부이 관측)";
const KMA_BUOY_EN = "Source: KMA (ocean and wave buoy observations)";
const TOUR_API = "https://www.data.go.kr/data/15101578/openapi.do";
const SURF_API = "https://www.data.go.kr/data/15142490/openapi.do";
const RIP_API = "https://www.data.go.kr/data/15156028/openapi.do";

// 화면에 보이는 그 글자(같은 화면의 숨은 자리·다른 보기는 세지 않음)
function visibleText(page: Page, text: string) {
  return page.getByText(text, { exact: true }).filter({ visible: true });
}

// 해변 사진은 바깥 주소라 fixtures가 막음. 이 파일에서만 1×1 PNG로 대신 줘서 사진·출처 줄이 보이게 함
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
async function servePhotos(page: Page) {
  await page.route("https://tong.visitkorea.or.kr/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG }),
  );
}

test.describe("기상청 출처 한 줄", () => {
  test("홈·탐색 목록 (한국어)", async ({ page }) => {
    await page.goto("/");
    await expect(visibleText(page, KMA_STATUS_KO)).toHaveCount(1);
    await page.goto("/explore/");
    await expect(visibleText(page, KMA_STATUS_KO)).toHaveCount(1);
  });

  test("홈·탐색 목록 (영어)", async ({ page }) => {
    await page.goto("/en/");
    await expect(visibleText(page, KMA_STATUS_EN)).toHaveCount(1);
    await page.goto("/en/explore/");
    await expect(visibleText(page, KMA_STATUS_EN)).toHaveCount(1);
  });

  test("상세: 측정값 줄의 기관과 24시간 파고 캡션", async ({ page }) => {
    await page.goto(`/spots/${slugOf(CLEAR_ID)}/`);
    await expect(visibleText(page, KMA_BUOY_KO)).toBeVisible();
    const sources = page.getByRole("region", { name: "정보 출처" });
    // 파도·바람·수온 줄: '기상청 · 측정소 n km · n분 전 측정'
    await expect(sources.getByText(/^기상청 · /)).not.toHaveCount(0);
    await page.goto(`/en/spots/${slugOf(CLEAR_ID)}/`);
    await expect(visibleText(page, KMA_BUOY_EN)).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Data sources" }).getByText(/^KMA · /),
    ).not.toHaveCount(0);
  });

  // 같은 화면의 국립해양조사원 자료(이안류)도 글자 출처 + 공공누리 제1유형 + 원문 링크(새 창 안내)
  test("상세: 이안류 출처 줄", async ({ page }) => {
    for (const [prefix, region, name, license] of [
      [
        "",
        "정보 출처",
        "국립해양조사원 「이안류 지수 조회」 (새 창에서 열림)",
        "공공누리 제1유형",
      ],
      [
        "/en",
        "Data sources",
        "KHOA “Rip Current Index” (Opens in a new window)",
        "KOGL Type 1",
      ],
    ] as const) {
      await page.goto(`${prefix}/spots/${slugOf(CLEAR_ID)}/`);
      const sources = page.getByRole("region", { name: region });
      const link = sources.getByRole("link", { name });
      await expect(link).toHaveAttribute("href", RIP_API);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(sources).toContainText(license);
    }
    await expectNoA11yViolations(page);
  });

  test.describe("로딩", () => {
    test.use({ scenario: "loading" });
    test("받은 자료가 없으면 출처 줄을 두지 않음", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByText("특보 없음", { exact: true })).toHaveCount(0);
      await expect(page.getByText(KMA_STATUS_KO)).toHaveCount(0);
    });
  });

  test.describe("데이터 없음", () => {
    test.use({ scenario: "noData" });
    test("처음부터 못 받으면 기상청 출처를 붙이지 않음", async ({ page }) => {
      await page.goto("/explore/");
      await expect(page.getByText("다시 시도").first()).toBeVisible();
      await expect(page.getByText(KMA_STATUS_KO)).toHaveCount(0);
    });
  });
});

test.describe("사진 출처 링크", () => {
  for (const [locale, name] of [
    ["ko", "한국관광공사 (새 창에서 열림)"],
    ["en", "Korea Tourism Organization (Opens in a new window)"],
  ] as const) {
    test(`공유 미리보기 사진의 출처 이름이 TourAPI 링크 (${locale})`, async ({
      page,
    }) => {
      await servePhotos(page);
      const prefix = locale === "en" ? "/en" : "";
      await page.goto(`${prefix}/spots/${slugOf(CLEAR_ID)}/`);
      await page
        .getByRole("button", { name: locale === "en" ? "Share" : "공유" })
        .first()
        .click();
      const link = page.getByRole("dialog").getByRole("link", { name });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", TOUR_API);
      await expect(link).toHaveAttribute("target", "_blank");
      // 시트 열림 움직임(투명도)이 끝난 뒤 대비를 봄(interaction.spec checkSheet와 같음)
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
    });
  }
});

test.describe("데이터 출처 화면", () => {
  test("한국어: 서핑지수 링크·공공누리, 해수부 근거, 지도 스타일 고지", async ({
    page,
  }) => {
    await page.goto("/about/data/");
    await expect(
      page.getByRole("link", { name: /^서핑지수 조회/ }),
    ).toHaveAttribute("href", SURF_API);
    const khoa = page.getByRole("region", { name: "국립해양조사원" });
    await expect(khoa).toContainText("「서핑지수 조회」(공공누리 제1유형)");
    // 데이터에 쓰지 않는 스킨스쿠버, 지수·등급·추천 표시는 없음(결정 20 · G1)
    await expect(page.locator("main")).not.toContainText("스킨스쿠버");
    await expect(page.locator("main")).not.toContainText("서핑 추천");
    await expect(
      page.getByRole("link", { name: /^해수욕장 개폐장일정 정보/ }),
    ).toHaveAttribute(
      "href",
      "https://www.data.go.kr/data/15056091/fileData.do",
    );
    await expect(
      page.getByRole("link", { name: /^해수욕장정보 서비스/ }),
    ).toHaveAttribute(
      "href",
      "https://www.data.go.kr/data/15058519/openapi.do",
    );
    await expect(page.locator("main")).not.toContainText("mof.go.kr");
    await expect(page.locator("main")).toContainText("'출처: 기상청'");
    const map = page.getByRole("region", { name: "지도" });
    await expect(map).toContainText("Copyright (c) 2015, CartoDB Inc.");
    await expect(map).toContainText("CC-BY 3.0");
    await expect(
      map.getByRole("link", { name: /^Positron 스타일 라이선스/ }),
    ).toBeVisible();
  });

  test("영어: 같은 출처와 링크", async ({ page }) => {
    await page.goto("/en/about/data/");
    await expect(
      page.getByRole("link", { name: /^Surfing Index/ }),
    ).toHaveAttribute("href", SURF_API);
    await expect(page.locator("main")).toContainText("“Source: KMA”");
    await expect(page.locator("main")).not.toContainText("skin-scuba");
    await expect(page.locator("main")).toContainText(
      "designed by Stamen and Paul Norman",
    );
  });
});
