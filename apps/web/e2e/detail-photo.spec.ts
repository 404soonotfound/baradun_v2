import {
  CLEAR_ID,
  expect,
  expectNoA11yViolations,
  slugOf,
  test,
  UNKNOWN_ID,
} from "./fixtures";

// 상세 사진 커버 (GH-528 · 결정 기록 29장 D29-1·D29-8)
// 사진 있음 = 판단 카드 위 커버(참고 사진 표시 + 출처), 사진 없음·받기 실패 = 커버 없이 D안 그대로
// 시험 해변: CLEAR_ID(강문, 사진 있음) · UNKNOWN_ID(사천진, 사진 없음)

const cover = (page: import("@playwright/test").Page) =>
  page.getByRole("img", { name: /참고 사진$/ });
const FINAL_CALL = "최종 판단은 현장 통제와 안전요원 안내가 우선이에요";

test.describe("상세 사진 커버", () => {
  test("사진 있음: 판단 카드 위 커버 + 참고 사진 표시 + 출처 링크, 판단 내용 그대로", async ({
    page,
  }, info) => {
    await page.goto(`/spots/${slugOf(CLEAR_ID)}/`);
    const image = cover(page);
    await expect(image).toBeVisible();
    // 받은 사진(실패 그림 아님)
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    const figure = page.locator("figure", { has: image });
    await expect(
      figure.getByText("참고 사진 · 지금 바다 모습 아님"),
    ).toBeVisible();
    // 공공누리 유형 이름은 사진 옆에 두지 않음(GH-541 · D29-10, /about/data에만)
    await expect(figure.getByText(/공공누리/)).toHaveCount(0);
    // 출처 링크(새 창). 링크 안 링크가 아님
    const link = figure.getByRole("link", { name: /한국관광공사/ });
    await expect(link).toHaveAttribute("target", "_blank");
    expect(await figure.evaluate((el) => el.closest("a"))).toBeNull();

    // 크기: 모바일 카드 폭(아래에서 판단 카드와 비교) × 164, PC 384 × 188. 사진 위치는 가운데 위쪽 30%
    const box = await figure.boundingBox();
    const mobile = info.project.name === "mobile";
    expect(Math.round(box!.height)).toBe(mobile ? 164 : 188);
    if (!mobile) expect(Math.round(box!.width)).toBe(384);
    await expect(image).toHaveCSS("object-position", "50% 30%");

    // 커버 바로 아래가 판단 카드. 판단 내용(사유 배지·현장 우선 문구)은 그대로
    await expect(page.getByText("특보 없음").first()).toBeVisible();
    await expect(page.getByText(FINAL_CALL).first()).toBeVisible();
    const verdict = await page
      .getByText(FINAL_CALL)
      .first()
      .locator("xpath=ancestor::section[1]")
      .boundingBox();
    expect(Math.round(verdict!.y)).toBe(Math.round(box!.y + box!.height));
    // 카드와 한 덩어리: 커버 폭 = 판단 카드 폭
    expect(Math.round(box!.width)).toBe(Math.round(verdict!.width));

    await expectNoA11yViolations(page);
  });

  test("다크에서는 사진 밝기 90%, 라이트는 원본", async ({ page }) => {
    await page.goto(`/spots/${slugOf(CLEAR_ID)}/`);
    const image = cover(page);
    await expect(image).toBeVisible();
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "light"),
    );
    await expect(image).toHaveCSS("filter", "none");
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await expect(image).toHaveCSS("filter", "brightness(0.9)");
    await expectNoA11yViolations(page);
  });

  test("사진 없는 해변: 커버 없이 판단 카드만", async ({ page }) => {
    await page.goto(`/spots/${slugOf(UNKNOWN_ID)}/`);
    await expect(page.getByText(FINAL_CALL).first()).toBeVisible();
    await expect(cover(page)).toHaveCount(0);
    await expect(page.getByText("참고 사진 · 지금 바다 모습 아님")).toHaveCount(
      0,
    );
  });

  test.describe("사진 받기 실패", () => {
    test.use({ photos: "fail" });
    test("커버를 빼고 판단 카드만(빈 자리·그림 없음)", async ({ page }) => {
      await page.goto(`/spots/${slugOf(CLEAR_ID)}/`);
      await expect(page.getByText(FINAL_CALL).first()).toBeVisible();
      await expect(cover(page)).toHaveCount(0);
      await expect(page.getByText("특보 없음").first()).toBeVisible();
    });

    // 사진 응답 기본값이 '받음'이라 받기 실패 화면은 여기서 봄: 공유 시트 미리보기는 파도 아이콘 + 안내(SHARE, GH-527)
    test("공유 시트 미리보기는 사진 대신 안내", async ({ page }) => {
      await page.goto(`/spots/${slugOf(CLEAR_ID)}/`);
      await page.getByRole("button", { name: "공유" }).click();
      const sheet = page.getByRole("dialog", { name: "공유하기" });
      await expect(
        sheet.getByText("사진이 없어 일러스트로 보여드려요"),
      ).toBeVisible();
      await expect(sheet.getByRole("img")).toHaveCount(0);
      // 시트가 다 열린 뒤 검사(열리는 동안은 반투명이라 대비가 낮게 잡힘)
      await sheet.evaluate((el) =>
        Promise.all(
          el.getAnimations({ subtree: true }).map((item) => item.finished),
        ),
      );
      await expectNoA11yViolations(page);
    });
  });
});
