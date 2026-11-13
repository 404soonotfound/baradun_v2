import { expect, expectNoA11yViolations, test } from "./fixtures";

test.describe("당겨서 새로고침(L16)", () => {
  test.use({ exploreView: "list" });

  test("탐색 목록에서 새로고침하면 변경 없음·변경됨·실패·오프라인 토스트와 이전 사유를 보여 준다", async ({
    page,
    context,
    data,
  }) => {
    await page.goto("/explore/");
    const refreshBtn = page.getByRole("button", { name: "새로고침" });
    await expect(refreshBtn).toBeVisible();
    await expect(page.getByText("특보 없음").first()).toBeVisible();

    // 1. 바뀐 게 없을 때
    await refreshBtn.click();
    await expect(page.getByText("이미 최신이에요")).toBeVisible();

    // 2. 상태가 바뀌었을 때
    data.set("noConfirmed");
    await refreshBtn.click();
    await expect(
      page.getByText(/기준으로 바뀌었어요 · \d+곳 상태 변경/),
    ).toBeVisible();
    await expect(page.getByText(/방금 바뀜 · 이전:/).first()).toBeVisible();
    await expectNoA11yViolations(page);

    // 3. 온라인 다시 받기 실패(B5)
    data.set("noData");
    await refreshBtn.click();
    await expect(
      page.getByText(/새 정보를 확인하지 못했어요/),
    ).toBeVisible();

    // 4. 오프라인 다시 받기 실패(B5)
    await context.setOffline(true);
    await refreshBtn.click();
    await expect(
      page.getByText(/인터넷에 연결되어 있지 않아 새 정보를 확인하지 못했어요/),
    ).toBeVisible();
  });

  test("홈에서 키보드 새로고침과 동작 줄이기에서 애니메이션 없이 동작한다", async ({
    page,
    data,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const refreshBtn = page.getByRole("button", { name: "새로고침" });
    await expect(refreshBtn).toBeVisible();
    await expect(page.getByText("특보 없음").first()).toBeVisible();

    data.set("noConfirmed");
    await refreshBtn.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByText(/기준으로 바뀌었어요 · \d+곳 상태 변경/),
    ).toBeVisible();
    await expect(page.getByText(/방금 바뀜 · 이전:/).first()).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("맨 위에서 아래로 당기면 새로고침된다", async ({ page }) => {
    await page.goto("/explore/");
    await expect(page.getByText("특보 없음").first()).toBeVisible();

    await page.evaluate(() => {
      const target = document.querySelector("h1") ?? document.body;
      const touchStart = new TouchEvent("touchstart", {
        bubbles: true,
        touches: [
          new Touch({
            identifier: 1,
            target,
            clientX: 160,
            clientY: 120,
          }),
        ],
      });
      const touchMove = new TouchEvent("touchmove", {
        bubbles: true,
        touches: [
          new Touch({
            identifier: 1,
            target,
            clientX: 160,
            clientY: 280,
          }),
        ],
      });
      const touchEnd = new TouchEvent("touchend", {
        bubbles: true,
        changedTouches: [
          new Touch({
            identifier: 1,
            target,
            clientX: 160,
            clientY: 280,
          }),
        ],
      });
      target.dispatchEvent(touchStart);
      target.dispatchEvent(touchMove);
      target.dispatchEvent(touchEnd);
    });

    await expect(page.getByText("이미 최신이에요")).toBeVisible();
  });
});
