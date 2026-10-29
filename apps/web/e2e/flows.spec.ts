import type { Page } from "@playwright/test";

import { INQUIRY_CONTACT_ENABLED } from "../src/lib/inquiry/form";
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
    expect(posted).toBe(0);
  });

  test("이메일을 쓰면 형식과 동의를 확인하고 보내지 않음", async ({ page }) => {
    test.skip(!INQUIRY_CONTACT_ENABLED, "이메일·사진 받기 꺼짐(BRD-130)");
    let posted = 0;
    await page.route("**/api/inquiries**", (route) => {
      posted += 1;
      return route.fulfill({ status: 500, body: "" });
    });
    await page.goto(INQUIRY);
    await pickKind(page, "정보가 실제와 달라요");
    await page.getByRole("textbox", { name: /내용/ }).fill("파고가 달라요");
    await page.getByRole("textbox", { name: /이메일/ }).fill("name@example");
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(page.getByText(/이메일 형식이 맞지 않아요/)).toBeVisible();
    await expect(page.getByText(/동의가 필요해요/)).toBeVisible();
    expect(posted).toBe(0);
  });

  test("서버가 처리하지 못하면 접수 여부·다음 행동을 알리고 내용·이메일·동의는 화면에 남김(결정 25·27)", async ({
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
    if (INQUIRY_CONTACT_ENABLED) {
      await page
        .getByRole("textbox", { name: /이메일/ })
        .fill("reader@example.com");
      await page.getByRole("checkbox").check();
    }
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(page.getByText("접수됐는지 확인하지 못했어요")).toBeVisible();
    await expect(
      page.getByText("서버가 요청을 처리하지 못했어요."),
    ).toBeVisible();
    await expect(
      page.getByText("보낸 문의가 접수됐을 수도 있어요."),
    ).toBeVisible();
    await expect(
      page.getByText(
        "이 화면에서 내용을 바꾸지 않고 '다시 보내기'를 누르면 같은 문의가 두 번 접수되지 않아요.",
      ),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: /내용/ })).toHaveValue(
      "파주기 기준이 궁금해요",
    );
    await expect(
      page.getByRole("button", { name: "다시 보내기" }),
    ).toBeVisible();
    if (INQUIRY_CONTACT_ENABLED) {
      await expect(page.getByRole("textbox", { name: /이메일/ })).toHaveValue(
        "reader@example.com",
      );
      await expect(page.getByRole("checkbox")).toBeChecked();
      // 이메일·동의는 기기에 저장하지 않음
      expect(
        await page.evaluate(() => JSON.stringify({ ...localStorage })),
      ).not.toContain("reader@example.com");
    }
  });

  test("이메일·사진 받기가 꺼져 있으면 칸이 없고 유형·내용만 보냄(결정 기록 13장, BRD-130)", async ({
    page,
  }) => {
    test.skip(INQUIRY_CONTACT_ENABLED, "이메일·사진 받기 켜짐");
    let uploads = 0;
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/inquiries/uploads", (route) => {
      uploads += 1;
      return route.fulfill({ status: 500, body: "" });
    });
    await page.route("**/api/inquiries", (route) => {
      bodies.push(route.request().postDataJSON() as Record<string, unknown>);
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          inquiryId: "123e4567-e89b-42d3-a456-426614174000",
          receivedAt: "2026-10-29T03:00:00Z",
          photos: [],
        }),
      });
    });
    await page.goto(INQUIRY);
    await expect(page.getByRole("textbox", { name: /이메일/ })).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(
      page.getByText(
        "문의 글은 90일 보관한 뒤 자동으로 지워요. 이메일·사진은 받지 않아요.",
      ),
    ).toBeVisible();

    await pickKind(page, "정보가 실제와 달라요");
    await page.getByRole("textbox", { name: /내용/ }).fill("파고가 달라요");
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(
      page.getByRole("heading", { name: "접수됐어요" }),
    ).toBeVisible();
    await expect(
      page.getByText("확인 후 정보에 반영해요. 따로 답변은 드리지 않아요."),
    ).toBeVisible();
    expect(uploads).toBe(0);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("email");
    expect(bodies[0]?.photos).toEqual([]);
  });

  test("장소 상세에서 들어오면 해변·활동을 본문이 아닌 계약 칸으로 보냄(결정 22)", async ({
    page,
  }) => {
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/inquiries", (route) => {
      bodies.push(route.request().postDataJSON() as Record<string, unknown>);
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
    await page.goto(`${INQUIRY}?beach=gangmun`);
    await expect(page.getByText(/^해변: /)).toBeVisible();
    await pickKind(page, "해변을 추가해 주세요");
    await page
      .getByRole("textbox", { name: /내용/ })
      .fill("근처 해변도 넣어 주세요");
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(
      page.getByRole("heading", { name: "접수됐어요" }),
    ).toBeVisible();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      type: "beach_request",
      message: "근처 해변도 넣어 주세요",
      beachId: "b0001",
      activity: "swimming",
    });
  });

  test("그 해변이 지원하지 않는 활동은 보내지 않고, 지원하면 보냄", async ({
    page,
  }) => {
    const bodies: Record<string, unknown>[] = [];
    await page.addInitScript(() =>
      localStorage.setItem("baradun:activity", "surfing"),
    );
    await page.route("**/api/inquiries", (route) => {
      bodies.push(route.request().postDataJSON() as Record<string, unknown>);
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
    // 강문해변은 수영만 → 서핑을 골라 둬도 활동은 보내지 않고 화면에도 쓰지 않음
    await page.goto(`${INQUIRY}?beach=gangmun`);
    await expect(page.getByText(/^해변: /)).toBeVisible();
    await expect(page.getByText(/활동: /)).toHaveCount(0);
    await pickKind(page, "정보가 실제와 달라요");
    await page.getByRole("textbox", { name: /내용/ }).fill("파고가 달라요");
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(
      page.getByRole("heading", { name: "접수됐어요" }),
    ).toBeVisible();
    expect(bodies[0]).toMatchObject({ beachId: "b0001" });
    expect(bodies[0]).not.toHaveProperty("activity");

    // 경포해변은 서핑 지원 → 서핑을 함께 보냄
    await page.goto(`${INQUIRY}?beach=gyeongpo`);
    await expect(page.getByText(/활동: 서핑/)).toBeVisible();
    await pickKind(page, "정보가 실제와 달라요");
    await page.getByRole("textbox", { name: /내용/ }).fill("파고가 달라요");
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(
      page.getByRole("heading", { name: "접수됐어요" }),
    ).toBeVisible();
    expect(bodies[1]).toMatchObject({ activity: "surfing" });
  });

  test("해변·활동을 빼면 두 칸 모두 보내지 않음", async ({ page }) => {
    const bodies: Record<string, unknown>[] = [];
    await page.route("**/api/inquiries", (route) => {
      bodies.push(route.request().postDataJSON() as Record<string, unknown>);
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
    await page.goto(`${INQUIRY}?beach=gangmun`);
    await page.getByRole("button", { name: "해변·활동 빼기" }).click();
    await pickKind(page, "정보가 실제와 달라요");
    await page.getByRole("textbox", { name: /내용/ }).fill("파고가 달라요");
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(
      page.getByRole("heading", { name: "접수됐어요" }),
    ).toBeVisible();
    expect(bodies[0]).not.toHaveProperty("beachId");
    expect(bodies[0]).not.toHaveProperty("activity");
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
    await expect(page.getByText("서버 응답이 오지 않았어요.")).toBeVisible();
    await page.getByRole("button", { name: "다시 보내기" }).click();
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
    test.skip(!INQUIRY_CONTACT_ENABLED, "이메일·사진 받기 꺼짐(BRD-130)");
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
      page.getByText("서버 응답을 확인하지 못했어요."),
    ).toBeVisible();
    await expect(page.getByText("문의는 접수되지 않았어요.")).toBeVisible();
    // 사진은 다시 고르지 않아도 되게 화면에 남음(결정 25)
    await expect(page.getByRole("img", { name: /사진 1/ })).toBeVisible();
    expect(external).toEqual([]);
    expect(created).toBe(0);
  });
});
