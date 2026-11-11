import type { Page } from "@playwright/test";

import {
  CLEAR_ID,
  expect,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  NO_STATION_ID,
  slugOf,
  test,
  WARNING_ID,
} from "./fixtures";

// 상세 날씨 카드 (BRD-185 · 결정 기록 18장 D18-1·D18-2, 노션 3장 WeatherCard)
// 날씨는 참고 정보: 못 받아도 특보·측정값은 그대로, 받은 값만 그림(0·맑음으로 채우지 않음)
const DETAIL = `/spots/${slugOf(CLEAR_ID)}/`;

function card(page: Page) {
  return page.getByRole("region", { name: "날씨", exact: true });
}

test.describe("상세 날씨 카드", () => {
  test("시간 줄·바람 줄·출처 줄, 펼치면 이후 4일", async ({ page }) => {
    await page.goto(DETAIL);
    const weather = card(page);
    await expect(weather).toBeVisible();
    // 자정 직후에는 관측·발표 시각이 전날이라 날짜가 붙음(kstStamp: "11/05 23:59")
    await expect(
      weather.getByText(/^지금 14°C · (\d{2}\/\d{2} )?\d{2}:\d{2} 기준$/),
    ).toBeVisible();
    await expect(
      weather.getByText(
        /기상청 단기예보 · (\d{2}\/\d{2} )?\d{2}:\d{2} 발표 · 3시간 간격/,
      ),
    ).toBeVisible();
    // 칸마다 읽는 글(그림 줄은 aria-hidden)
    const cells = weather.locator("ol.sr-only > li");
    expect(await cells.count()).toBeGreaterThan(0);
    await expect(cells.first()).toHaveText(
      /^(오늘|내일) \d{1,2}시 .+, 기온 \d+°C, 강수확률 \d+%, 바람 \d+m\/s$/,
    );
    await expect(weather.getByText("바람 m/s")).toBeVisible();
    await expect(
      weather.getByText("날씨는 참고 정보예요. 특보 판단에는 쓰지 않아요."),
    ).toBeVisible();

    const toggle = weather.getByRole("button", { name: /이후 4일 날씨 보기/ });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(
      weather.getByRole("button", { name: "이후 날씨 접기" }),
    ).toHaveAttribute("aria-expanded", "true");
    // 두 구간 제목(노션 D18-2): 글피 단기예보 / 그 뒤 중기예보(넓은 지역 · 발표 시각)
    await expect(
      weather.getByRole("heading", {
        name: /^.(~.)? · 단기예보 · 하루 최저 \/ 최고$/,
      }),
    ).toBeVisible();
    await expect(
      weather.getByRole("heading", {
        name: /^.~. · .+\(넓은 지역\) · 기상청 중기예보 (\d{2}\/\d{2} )?\d{2}:\d{2} 발표$/,
      }),
    ).toBeVisible();
    const days = weather.locator("li[aria-label]");
    await expect(days).toHaveCount(4);
    await expect(days.first()).toHaveAttribute(
      "aria-label",
      /^. \d{1,2}\/\d{1,2} 흐림, 강수확률 30%, 최저 6°C, 최고 13°C$/,
    );

    // 정보 출처 '날씨' 줄: 단기·중기 출처와 발표 시각(화면 문구에 '이 해변'을 쓰지 않음)
    const source = page
      .getByText(
        "기상청 단기예보(해변 위치 5km 격자) · 4일째부터 기상청 중기예보(강원 영동)",
      )
      .filter({ visible: true });
    await expect(source).toHaveCount(1);
    await expect(
      page.getByText("이 해변", { exact: false }).filter({ visible: true }),
    ).toHaveCount(0);

    await expectNoHorizontalScroll(page);
    await expectNoA11yViolations(page);
  });

  test("중기예보만 못 받음: 펼친 곳에 안내, 글피는 그대로", async ({
    page,
    data,
  }) => {
    data.setWeather("midFailed");
    await page.goto(DETAIL);
    const weather = card(page);
    await weather.getByRole("button", { name: /이후 4일 날씨 보기/ }).click();
    await expect(weather.locator("li[aria-label]")).toHaveCount(1);
    await expect(
      weather.getByText("이후 날씨를 확인하지 못했어요"),
    ).toBeVisible();
    // 받지 않은 중기 출처는 출처 줄에 적지 않음
    await expect(
      page
        .getByText("기상청 단기예보(해변 위치 5km 격자)", { exact: true })
        .filter({ visible: true }),
    ).toHaveCount(1);
  });

  test("전부 못 받음: 카드 자리에 안내 한 줄, 특보·측정값은 그대로", async ({
    page,
    data,
  }) => {
    data.setWeather("failed");
    await page.goto(`/spots/${slugOf(WARNING_ID)}/`);
    const weather = card(page);
    await expect(
      weather.getByText(
        /날씨를 확인하지 못했어요\. 기상청 예보를 받지 못했어요\./,
      ),
    ).toBeVisible();
    await expect(weather.getByRole("button")).toHaveCount(0);
    // 판단 카드의 특보는 날씨와 상관없이 보임
    await expect(
      page.getByText("풍랑주의보").filter({ visible: true }).first(),
    ).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("측정소 없는 해변: 측정값은 '가까운 관측 없음', 날씨 카드는 그대로", async ({
    page,
  }) => {
    await page.goto(`/spots/${slugOf(NO_STATION_ID)}/`);
    // 측정값 카드('지금 바다') 안의 파고·파주기 값 자리
    const sea = page.getByRole("region", { name: "지금 바다" });
    await expect(
      sea.getByText("가까운 관측 없음").filter({ visible: true }).first(),
    ).toBeVisible();
    const weather = card(page);
    await expect(weather).toBeVisible();
    await expect(
      weather.getByText(/^지금 14°C · (\d{2}\/\d{2} )?\d{2}:\d{2} 기준$/),
    ).toBeVisible();
    await expect(
      weather.getByText(
        /기상청 단기예보 · (\d{2}\/\d{2} )?\d{2}:\d{2} 발표 · 3시간 간격/,
      ),
    ).toBeVisible();
    await expectNoA11yViolations(page);
  });
});

test.describe("홈 날씨 줄", () => {
  test("수영 카드 '오늘 날씨 줄': 최저·최고·지금 기온·예보 시각과 읽는 글", async ({
    page,
  }) => {
    await page.goto("/");
    const region = page.getByRole("region", { name: "강원 강릉시 바다" });
    await expect(region).toBeVisible();
    // 카드 안의 오늘 기온 줄과 스크린리더용 읽는 글(role="img")
    // 21시(한국 시각) 뒤에는 오늘 남은 3시간 칸이 없어 하늘·강수확률이 빠짐(가짜 데이터가 실제 시각 기준)
    await expect(
      region
        .getByText(
          /오늘 기온 · 지금 14°C\((\d{2}\/\d{2} )?\d{2}:\d{2}\) · 예보 (\d{2}\/\d{2} )?\d{2}:\d{2} 발표/,
        )
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    const img = region
      .getByRole("img", {
        name: /^강원 강릉시 오늘 날씨( .+)?, 지금 14°C\(.+ 기준\), 최저 9°C, 최고 16°C(, 강수확률 \d+%)?, 기상청 예보 .+ 발표$/,
      })
      .filter({ visible: true })
      .first();
    await expect(img).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("수영 카드 예보 못 받음: 날씨 실패 안내, 특보·측정값은 그대로", async ({
    page,
    data,
  }) => {
    data.setWeather("failed");
    await page.goto("/");
    const region = page.getByRole("region", { name: "강원 강릉시 바다" });
    await expect(
      region
        .getByText(
          "오늘 날씨를 확인하지 못했어요 · 특보와 측정값은 위에서 확인하세요",
        )
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    // 같은 카드의 특보 배지와 측정값(수온 18.4°C)은 그대로 보임
    const cardLink = region
      .locator(`a[href$="/spots/${slugOf(CLEAR_ID)}/"]`)
      .filter({ visible: true })
      .first();
    await expect(
      cardLink.getByText("특보 없음", { exact: true }),
    ).toBeVisible();
    await expect(cardLink.getByText("18.4", { exact: true })).toBeVisible();
    await expectNoA11yViolations(page);
  });
});
