import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

// 지도 실패 안내·데이터 문의 흐름 (BRD-39 · 리뷰 지적: 실패 경로 E2E 공백)
// 다른 출처(지도 타일·글꼴)는 fixtures가 막으므로 지도는 늘 실패 경로로 감

test.describe("지도 실패", () => {
  test("목록으로 볼 수 있다고 알리고, 다시 시도·목록으로 보기가 동작함", async ({
    page,
  }, testInfo) => {
    await page.goto("/explore/");
    const mobile = testInfo.project.name === "mobile";
    if (mobile) {
      await page
        .getByRole("group", { name: "목록·지도 보기" })
        .getByRole("button", { name: "지도" })
        .click();
    }
    const alert = page
      .getByRole("alert")
      .filter({ hasText: "지도를 불러오지 못했어요" });
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toContainText("해변 정보는 목록으로 볼 수 있어요");

    // 다시 시도: 새로 불러오고, 여전히 막혀 있으니 다시 실패 안내
    await alert.getByRole("button", { name: "다시 시도" }).click();
    await expect(alert).toBeVisible({ timeout: 20_000 });

    if (mobile) {
      await alert.getByRole("button", { name: "목록으로 보기" }).click();
      await expect(
        page
          .getByRole("group", { name: "목록·지도 보기" })
          .getByRole("button", { name: "목록" }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(alert).toBeHidden();
    } else {
      // PC는 목록이 옆에 늘 보여 '목록으로 보기'를 두지 않음
      await expect(
        alert.getByRole("button", { name: "목록으로 보기" }),
      ).toBeHidden();
    }
  });
});

// 유형 칩: 라디오는 보이지 않게 두고 칩(label)을 누름
async function pickKind(page: Page, name: string) {
  await page.locator("label").filter({ hasText: name }).click();
  await expect(page.getByRole("radio", { name })).toBeChecked();
}

test.describe("데이터 문의", () => {
  const INQUIRY = "/settings/inquiry/";

  test("빈 채로 보내면 오류를 알리고 첫 오류 칸으로 포커스, 보내지 않음", async ({
    page,
  }) => {
    let posted = 0;
    await page.route("**/api/inquiries**", (route) => {
      posted += 1;
      return route.fulfill({ status: 500, body: "" });
    });
    await page.goto(INQUIRY);
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(page.getByText("문의 유형을 골라 주세요.")).toBeVisible();
    await expect(page.getByText("내용을 5자 이상 써 주세요.")).toBeVisible();
    await expect(
      page.getByRole("radio", { name: "정보가 실제와 달라요" }),
    ).toBeFocused();

    // 이메일을 쓰면 동의가 필요함
    await pickKind(page, "정보가 실제와 달라요");
    await page.getByRole("textbox", { name: /내용/ }).fill("파고가 달라요");
    await page.getByRole("textbox", { name: /이메일/ }).fill("name@example");
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(page.getByText(/이메일 형식이 맞지 않아요/)).toBeVisible();
    await expect(page.getByText(/동의가 필요해요/)).toBeVisible();
    expect(posted).toBe(0);
  });

  test("서버가 받지 못하면 무슨 일·다음 행동을 알리고 유형·내용은 남김", async ({
    page,
  }) => {
    await page.route("**/api/inquiries**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "service_unavailable", message: "m" },
        }),
      }),
    );
    await page.goto(INQUIRY);
    await pickKind(page, "판단 기준이 궁금해요");
    await page
      .getByRole("textbox", { name: /내용/ })
      .fill("파주기 기준이 궁금해요");
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(page.getByText("문의를 보내지 못했어요")).toBeVisible();
    await expect(
      page.getByText("지금은 문의를 받을 수 없어요. 잠시 뒤 다시 보내 주세요."),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: /내용/ })).toHaveValue(
      "파주기 기준이 궁금해요",
    );
  });

  test("접수되면 완료를 알리고 임시 저장을 지움", async ({ page }) => {
    await page.route("**/api/inquiries**", (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          inquiryId: "123e4567-e89b-42d3-a456-426614174000",
          receivedAt: "2026-10-28T03:00:00Z",
          photos: [],
        }),
      }),
    );
    await page.goto(INQUIRY);
    await pickKind(page, "정보가 실제와 달라요");
    await page.getByRole("textbox", { name: /내용/ }).fill("파고가 달라요");
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("baradun:inquiry-draft")),
      )
      .not.toBeNull();
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(
      page.getByRole("heading", { name: "접수됐어요" }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("baradun:inquiry-draft")),
    ).toBeNull();
  });

  test("응답을 못 받고 다시 보내면 같은 멱등 키로 보내 한 번만 접수됨(BRD-103)", async ({
    page,
  }) => {
    const keys: string[] = [];
    await page.route("**/api/inquiries", (route) => {
      keys.push(
        (route.request().postDataJSON() as { idempotencyKey: string })
          .idempotencyKey,
      );
      if (keys.length === 1) return route.abort("connectionreset");
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          inquiryId: "123e4567-e89b-42d3-a456-426614174000",
          receivedAt: "2026-10-28T03:00:00Z",
          photos: [],
        }),
      });
    });
    await page.goto(INQUIRY);
    await pickKind(page, "정보가 실제와 달라요");
    await page.getByRole("textbox", { name: /내용/ }).fill("파고가 달라요");
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(
      page.getByText("응답이 없어 보내지 못했어요. 잠시 뒤 다시 보내 주세요."),
    ).toBeVisible();
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(
      page.getByRole("heading", { name: "접수됐어요" }),
    ).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(keys[1]).toBe(keys[0]);
  });

  test("업로드 양식 주소가 허용 버킷이 아니면 사진을 올리지 않고 문의도 보내지 않음(BRD-103)", async ({
    page,
  }) => {
    const KEY = `pending/${"a".repeat(32)}/0123456789abcdef`;
    let created = 0;
    const external: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith("https://")) external.push(request.url());
    });
    await page.route("**/api/inquiries/uploads", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          uploads: [
            {
              photoId: "0123456789abcdef",
              key: KEY,
              method: "POST",
              url: "https://evil.example/",
              fields: { key: KEY, "Content-Type": "image/jpeg" },
              expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            },
          ],
        }),
      }),
    );
    await page.route("**/api/inquiries", (route) => {
      created += 1;
      return route.fulfill({ status: 500, body: "" });
    });
    await page.goto(INQUIRY);
    await pickKind(page, "정보가 실제와 달라요");
    await page.getByRole("textbox", { name: /내용/ }).fill("파고가 달라요");
    // 1×1 PNG. 기기에서 JPEG로 다시 그려 보냄
    await page.locator('input[type="file"]').setInputFiles({
      name: "shot.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
    await expect(page.getByRole("img", { name: /사진 1/ })).toBeVisible();
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(
      page.getByText("접수됐는지 확인하지 못했어요. 잠시 뒤 다시 보내 주세요."),
    ).toBeVisible();
    expect(external).toEqual([]);
    expect(created).toBe(0);
  });
});

