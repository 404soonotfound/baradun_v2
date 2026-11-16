import type { Page } from "@playwright/test";

import { INQUIRY_CONTACT_ENABLED } from "../src/lib/inquiry/form";
import { expect, expectNoA11yViolations, test } from "./fixtures";

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

// 내용 칸: 칸 제목이 고른 유형에 맞게 바뀜(GH-532 · D29-9). 고르기 전 '내용'
const MESSAGE_LABEL =
  /^(내용|무엇이 달랐나요\?|어떤 해변을 추가할까요\?|어떤 판단이 궁금한가요\?|어떤 정보를 더 보고 싶나요\?)$/;
function messageBox(page: Page) {
  return page.getByRole("textbox", { name: MESSAGE_LABEL });
}

// 유형 카드: 라디오는 보이지 않게 두고 카드(label)를 누름
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
    await messageBox(page).fill("파고가 달라요");
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
      .getByRole("textbox", { name: MESSAGE_LABEL })
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
    await expect(messageBox(page)).toHaveValue("파주기 기준이 궁금해요");
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
    await messageBox(page).fill("파고가 달라요");
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
    // '문의할 해변' 카드(GH-532 · D29-9): 해변명 · 지역 · 확인된 활동 + 함께 보내는 활동 안내
    const context = page.getByRole("region", { name: "문의할 해변" });
    await expect(
      context.getByText("강문해수욕장", { exact: true }),
    ).toBeVisible();
    await expect(
      context.getByText(/^강원 강릉시 · 확인된 활동 /),
    ).toBeVisible();
    await expect(
      context.getByText(/고른 활동\(수영\)도 함께 보내요/),
    ).toBeVisible();
    await pickKind(page, "해변을 추가해 주세요");
    await page
      .getByRole("textbox", { name: MESSAGE_LABEL })
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
    await expect(page.getByText("강문해수욕장", { exact: true })).toBeVisible();
    await expect(page.getByText(/고른 활동\(.+\)도 함께 보내요/)).toHaveCount(
      0,
    );
    await pickKind(page, "정보가 실제와 달라요");
    await messageBox(page).fill("파고가 달라요");
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(
      page.getByRole("heading", { name: "접수됐어요" }),
    ).toBeVisible();
    expect(bodies[0]).toMatchObject({ beachId: "b0001" });
    expect(bodies[0]).not.toHaveProperty("activity");

    // 경포해변은 서핑 지원 → 서핑을 함께 보냄
    await page.goto(`${INQUIRY}?beach=gyeongpo`);
    await expect(
      page.getByText(/고른 활동\(서핑\)도 함께 보내요/),
    ).toBeVisible();
    await pickKind(page, "정보가 실제와 달라요");
    await messageBox(page).fill("파고가 달라요");
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
    await page.getByRole("button", { name: "문의할 해변 빼기" }).click();
    await pickKind(page, "정보가 실제와 달라요");
    await messageBox(page).fill("파고가 달라요");
    await page.getByRole("button", { name: "보내기" }).click();
    await expect(
      page.getByRole("heading", { name: "접수됐어요" }),
    ).toBeVisible();
    expect(bodies[0]).not.toHaveProperty("beachId");
    expect(bodies[0]).not.toHaveProperty("activity");
  });

  test("접수되면 완료를 알리고 임시 저장을 지움 @smoke", async ({ page }) => {
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
    await messageBox(page).fill("파고가 달라요");
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
    await messageBox(page).fill("파고가 달라요");
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
    await messageBox(page).fill("파고가 달라요");
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

  // 접수 뒤 돌아갈 곳(10/30 사용자 결정 A): 들어온 해변이 공개 목록에 있으면 그 해변, 아니면 설정
  const RETURNS = [
    {
      title: "해변에서 들어오면 '해변으로 돌아가기' → 그 해변",
      path: `${INQUIRY}?beach=gangmun`,
      kind: "정보가 실제와 달라요",
      message: /^무엇이 달랐나요\?$/,
      send: "보내기",
      done: "접수됐어요",
      back: "해변으로 돌아가기",
      href: "/spots/gangmun/",
    },
    {
      title: "모르는 해변 id면 '설정으로'",
      path: `${INQUIRY}?beach=no-such-beach`,
      kind: "정보가 실제와 달라요",
      message: /^무엇이 달랐나요\?$/,
      send: "보내기",
      done: "접수됐어요",
      back: "설정으로",
      href: "/settings/",
    },
    {
      title: "빈 값이면 '설정으로'",
      path: `${INQUIRY}?beach=`,
      kind: "정보가 실제와 달라요",
      message: /^무엇이 달랐나요\?$/,
      send: "보내기",
      done: "접수됐어요",
      back: "설정으로",
      href: "/settings/",
    },
    {
      title: "영어 화면은 영어 해변 주소로",
      path: "/en/settings/inquiry/?beach=gangmun",
      kind: "The info doesn't match reality",
      message: /^What was different\?$/,
      send: "Send",
      done: "Received",
      back: "Back to the beach",
      href: "/en/spots/gangmun/",
    },
  ] as const;
  for (const item of RETURNS) {
    test(`접수 뒤 돌아갈 곳: ${item.title}`, async ({ page }) => {
      await page.route("**/api/inquiries", (route) =>
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
      await page.goto(item.path);
      await pickKind(page, item.kind);
      await page
        .getByRole("textbox", { name: item.message })
        .fill("파고가 달라요");
      await page.getByRole("button", { name: item.send }).click();
      await expect(
        page.getByRole("heading", { name: item.done }),
      ).toBeVisible();
      const back = page.getByRole("link", { name: item.back, exact: true });
      await expect(back).toHaveAttribute("href", item.href);
      await back.click();
      await expect(page).toHaveURL(new RegExp(`${item.href}$`));
    });
  }
});

// 데이터 문의 유형 카드·유형별 칸 제목 (GH-532 · 결정 기록 29장 D29-9)
test.describe("데이터 문의 유형 카드", () => {
  const INQUIRY = "/settings/inquiry/";

  test("카드 4개는 라디오 묶음: 화살표 키로 고르고, 이름 + 설명이 접근 가능한 이름, 칸 제목이 유형에 맞게 바뀜", async ({
    page,
  }) => {
    await page.goto(INQUIRY);
    await expect(
      page.getByText(
        "앱 정보가 현장과 다르거나 바라는 점이 있으면 알려 주세요. 운영자가 확인하고 정보에 반영해요.",
      ),
    ).toBeVisible();
    const group = page.getByRole("group", { name: "무엇을 알려 주시겠어요?" });
    const radios = group.getByRole("radio");
    await expect(radios).toHaveCount(4);
    // 접근 가능한 이름 = 이름 + 설명 한 줄
    await expect(
      group.getByRole("radio", {
        name: "정보가 실제와 달라요 특보·파고 등 앱 값이 현장과 다를 때",
      }),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "내용" })).toBeVisible();

    await pickKind(page, "정보가 실제와 달라요");
    await expect(
      page.getByRole("textbox", { name: "무엇이 달랐나요?" }),
    ).toBeVisible();
    // 화살표 키: 같은 이름의 라디오 사이를 옮겨 고름
    await page.keyboard.press("ArrowRight");
    await expect(
      group.getByRole("radio", { name: /^해변을 추가해 주세요/ }),
    ).toBeChecked();
    await expect(
      page.getByRole("textbox", { name: "어떤 해변을 추가할까요?" }),
    ).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("textbox", { name: "어떤 판단이 궁금한가요?" }),
    ).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("textbox", { name: "어떤 정보를 더 보고 싶나요?" }),
    ).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("임시 저장: 고른 유형·내용은 다시 열어도 남고, 칸 제목도 그 유형으로", async ({
    page,
  }) => {
    await page.goto(INQUIRY);
    await pickKind(page, "판단 기준이 궁금해요");
    await messageBox(page).fill("왜 판단불가인지 궁금해요");
    await page.reload();
    await expect(
      page.getByRole("radio", { name: /^판단 기준이 궁금해요/ }),
    ).toBeChecked();
    await expect(
      page.getByRole("textbox", { name: "어떤 판단이 궁금한가요?" }),
    ).toHaveValue("왜 판단불가인지 궁금해요");
    // 이메일·기기 정보·동의 상태·해변은 임시 저장에 없음(유형·내용 + 저장 시각만)
    const saved = await page.evaluate(() =>
      Object.keys(localStorage)
        .filter((key) => key.includes("inquiry"))
        .map((key) => [key, localStorage.getItem(key) ?? ""] as const),
    );
    expect(saved.map(([key]) => key)).toEqual(["baradun:inquiry-draft"]);
    expect(Object.keys(JSON.parse(saved[0]![1])).sort()).toEqual([
      "kind",
      "message",
      "savedAt",
    ]);
  });

  test("문의할 해변: 상세에서 들어오면 채워지고(사진 없으면 그림), 빼면 카드가 사라짐 · 다크 axe", async ({
    page,
  }) => {
    await page.addInitScript(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    await page.goto(`${INQUIRY}?beach=sacheonjin`);
    const context = page.getByRole("region", { name: "문의할 해변" });
    await expect(
      context.getByText("사천진해수욕장", { exact: true }),
    ).toBeVisible();
    // 사진 없는 해변: 사진 대신 해변 그림(옆에 이름이 있어 화면 읽기에서는 숨김)
    await expect(context.locator("img")).toHaveCount(0);
    await expect(context.locator('svg[viewBox="0 0 320 132"]')).toBeVisible();
    await expectNoA11yViolations(page);
    await page.getByRole("button", { name: "문의할 해변 빼기" }).click();
    await expect(context).toHaveCount(0);
    // 누른 버튼이 사라져도 포커스는 다음 칸(유형 첫 카드)으로
    await expect(page.getByRole("radio").first()).toBeFocused();
  });
});
