import type { Page } from "@playwright/test";

import {
  CLEAR_ID,
  expect,
  expectNoA11yViolations,
  slugOf,
  test,
  WARNING_ID,
} from "./fixtures";

// 화면 출처 표시 (BRD-113 · 기상법 2026-09-18 시행 출처 표시 의무, 결정 19·20)
// 기상청 자료가 보이는 화면마다 그 화면 안에 글자로 '출처: 기상청'. 링크만으로는 출처 표시로 보지 않음
const KMA_STATUS_KO = "출처: 기상청 (특보·해양 관측 자료를 가공)";
const KMA_STATUS_EN =
  "Source: KMA (warnings and ocean observations, processed)";
const KMA_BUOY_KO = "출처: 기상청 (해양기상부이·파고부이 관측)";
const KMA_BUOY_EN = "Source: KMA (ocean and wave buoy observations)";
const FINAL_CALL = "최종 판단은 현장 통제와 안전요원 안내가 우선이에요";
const TOUR_API = "https://www.data.go.kr/data/15101578/openapi.do";
const SURF_API = "https://www.data.go.kr/data/15142490/openapi.do";
const BOUNDARY_SOURCE =
  "https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=NA&dsId=21";
const CC_BY_2_KR = "https://creativecommons.org/licenses/by/2.0/kr/";
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
    // 파도·바람·수온 줄: '기상청 측정소 n km'(시각은 같은 줄 오른쪽·다음 줄, BRD-129)
    await expect(sources.getByText(/^기상청 /)).not.toHaveCount(0);
    await page.goto(`/en/spots/${slugOf(CLEAR_ID)}/`);
    await expect(visibleText(page, KMA_BUOY_EN)).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Data sources" }).getByText(/^KMA /),
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

  // 상세 판단 카드: 현장 우선 문구 다음 줄에 가공 표기 출처(배지가 기상청 자료로 만든 분류)
  test("상세: 판단 카드의 현장 우선 문구 아래 출처", async ({ page }) => {
    await page.goto(`/spots/${slugOf(CLEAR_ID)}/`);
    const finalCall = page
      .getByText(FINAL_CALL, { exact: true })
      .filter({ visible: true })
      .first();
    await expect(finalCall).toBeVisible();
    // 같은 묶음 안에서 바로 다음 줄
    await expect(finalCall.locator("xpath=following-sibling::p[1]")).toHaveText(
      KMA_STATUS_KO,
    );
  });

  test("특보 시트: 확인 기관 그대로 출처 줄 (한·영)", async ({ page }) => {
    for (const [prefix, opener, text] of [
      ["", "특보 상세 보기", "출처: 기상청"],
      ["/en", "Warning details", "Source: KMA"],
    ] as const) {
      await page.goto(`${prefix}/spots/${slugOf(WARNING_ID)}/`);
      await page.getByRole("button", { name: opener }).first().click();
      await expect(
        page.getByRole("dialog").getByText(text, { exact: true }),
      ).toBeVisible();
    }
  });

  // 받은 자료가 없는 화면: 앱이 실제로 데이터를 요청한(하이드레이션된) 뒤 로딩 표시가 보이는 것까지 기다린 다음 확인
  test.describe("로딩", () => {
    test.use({ scenario: "loading" });
    for (const [url, loading] of [
      ["/", loadingText("해상 특보를 불러오고 있어요")],
      ["/explore/", loadingText("해변 정보를 불러오고 있어요")],
      [`/spots/${slugOf(CLEAR_ID)}/`, busy()],
    ] as const) {
      test(`받은 자료가 없으면 출처를 두지 않음 ${url}`, async ({
        page,
        data,
      }) => {
        await page.goto(url);
        await expect
          .poll(() =>
            data.requests.some((path) => path === "/data/manifest.json"),
          )
          .toBe(true);
        await expect(loading(page)).toBeVisible();
        await expectNoKmaSource(page);
      });
    }
  });

  test.describe("데이터 없음", () => {
    test.use({ scenario: "noData" });
    for (const url of ["/", "/explore/", `/spots/${slugOf(CLEAR_ID)}/`]) {
      test(`처음부터 못 받으면 출처를 두지 않음 ${url}`, async ({ page }) => {
        await page.goto(url);
        await expect(
          page.getByText("새 정보를 불러오지 못했어요").first(),
        ).toBeVisible();
        await expectNoKmaSource(page);
      });
    }
  });
});

// 로딩 표시 찾기(글자 또는 aria-busy 자리)
function loadingText(text: string) {
  return (page: Page) => page.getByText(text).filter({ visible: true }).first();
}
function busy() {
  return (page: Page) =>
    page.locator("[aria-busy='true']").filter({ visible: true }).first();
}

// 화면 어디에도 기상청·국립해양조사원 출처가 없음(정보 출처 줄의 '기상청 · 측정소' 포함)
async function expectNoKmaSource(page: Page) {
  await expect(page.getByText(/출처: 기상청/)).toHaveCount(0);
  await expect(page.getByText(/^기상청 /)).toHaveCount(0);
  await expect(page.getByText(/국립해양조사원 「/)).toHaveCount(0);
}

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
    // 법정 읍면동 경계: CC BY 2.0 KR 저작자·제목·출처·라이선스·변경 여부 표시(BRD-126)
    const boundary = page.getByRole("region", { name: "국토교통부" });
    await expect(boundary).toContainText(
      "국토교통부(국가공간정보센터)의 '법정구역정보'",
    );
    await expect(boundary).toContainText("경계는 바꾸지 않았고");
    await expect(
      boundary.getByRole("link", { name: /^법정구역정보\(브이월드\)/ }),
    ).toHaveAttribute("href", BOUNDARY_SOURCE);
    await expect(
      boundary.getByRole("link", { name: /^CC BY 2\.0 KR 라이선스/ }),
    ).toHaveAttribute("href", CC_BY_2_KR);
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
    const boundary = page.getByRole("region", {
      name: "Ministry of Land, Infrastructure and Transport (MOLIT)",
    });
    await expect(boundary).toContainText("CC BY 2.0 KR");
    await expect(
      boundary.getByRole("link", { name: /^Legal District Information/ }),
    ).toHaveAttribute("href", BOUNDARY_SOURCE);
    await expect(
      boundary.getByRole("link", { name: /^CC BY 2\.0 KR license/ }),
    ).toHaveAttribute("href", CC_BY_2_KR);
  });
});
