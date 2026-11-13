import type { Page } from "@playwright/test";
import {
  ME_OK,
  expect,
  expectNoA11yViolations,
  mockCognito,
  mockOps,
  signInWithPassword,
  srpScript,
  test,
  tokensFor,
} from "./fixtures";

// 내 계정 · 다른 운영자의 2단계 인증 초기화 (#335, D16-A9, 화면 설계서 6장 ADM-CONFIRM)
// 대상 이메일 직접 입력 → 확인 창(취소에 먼저 포커스, 대상 이메일 다시 입력) → POST /ops/account/mfa-reset

const OPS = "ops@example.test";
const TARGET = "lost@example.test";

async function openAccount(
  page: Page,
  reply: { status: number; body: unknown } = {
    status: 200,
    body: { result: "reset" },
  },
) {
  const bodies: unknown[] = [];
  await mockCognito(
    page,
    srpScript({ email: OPS, after: "tokens", groups: ["viewer"] }),
  );
  await mockOps(page, { ...ME_OK, body: { ...ME_OK.body, role: "viewer" } });
  await page.route("**/ops/account/mfa-reset", async (route) => {
    bodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: reply.status,
      contentType: "application/json",
      body: JSON.stringify(reply.body),
    });
  });
  await signInWithPassword(page, "/login/", OPS);
  await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
  await page.getByRole("link", { name: "내 계정" }).click();
  await expect(page.getByRole("heading", { name: "내 계정" })).toBeVisible();
  return bodies;
}

const emailField = (page: Page) =>
  page.getByRole("textbox", { name: "초기화할 운영자 이메일" });
const dialog = (page: Page) => page.getByRole("dialog");

async function startReset(page: Page, email = TARGET) {
  await emailField(page).fill(email);
  await page.getByRole("button", { name: "초기화하기" }).click();
}

test("보기 권한 운영자도 대상 이메일을 다시 입력해야 초기화하고, 결과를 알린다", async ({
  page,
}) => {
  const bodies = await openAccount(page);
  await expect(
    page.getByRole("heading", { name: "다른 운영자의 2단계 인증 초기화" }),
  ).toBeVisible();
  await startReset(page);
  await expect(dialog(page)).toBeVisible();
  await expect(
    dialog(page).getByRole("heading", {
      name: `${TARGET}의 2단계 인증을 초기화할까요?`,
    }),
  ).toBeVisible();
  // 취소에 먼저 포커스
  await expect(
    dialog(page).getByRole("button", { name: "취소" }),
  ).toBeFocused();
  const confirm = dialog(page).getByRole("button", { name: "초기화" });
  await expect(confirm).toBeDisabled();
  const word = dialog(page).getByRole("textbox", {
    name: "확인하려면 초기화할 이메일을 다시 입력해 주세요",
  });
  await word.fill("other@example.test");
  await expect(confirm).toBeDisabled();
  // 대소문자는 가리지 않음(로그인 이메일과 같음)
  await word.fill("Lost@Example.test");
  await expect(confirm).toBeEnabled();
  await expectNoA11yViolations(page);
  await confirm.click();
  await expect(dialog(page)).toBeHidden();
  await expect(
    page.getByText(
      `${TARGET}의 2단계 인증을 초기화했어요. 다음 로그인 때 새 인증 앱을 등록해요.`,
    ),
  ).toBeVisible();
  expect(bodies).toEqual([{ email: TARGET }]);
  await expect(emailField(page)).toHaveValue("");
});

test("취소하면 요청하지 않고, 내 이메일은 확인 창을 열기 전에 막는다", async ({
  page,
}) => {
  const bodies = await openAccount(page);
  await startReset(page);
  await dialog(page).getByRole("button", { name: "취소" }).click();
  await expect(dialog(page)).toBeHidden();
  await startReset(page, "OPS@example.test");
  await expect(dialog(page)).toBeHidden();
  await expect(
    page.getByText(
      "내 계정은 여기서 초기화하지 않아요. 위 '2단계 인증'의 '다시 등록'으로 바꿔 주세요.",
    ),
  ).toBeVisible();
  await startReset(page, "not-an-email");
  await expect(page.getByText("이메일 형식으로 입력해 주세요.")).toBeVisible();
  expect(bodies).toEqual([]);
});

for (const [name, reply, text] of [
  [
    "없는 계정",
    {
      status: 404,
      body: { error: { code: "not_found", reason: "account", requestId: "r" } },
    },
    "이 이메일로 된 운영자 계정이 없어요. 이메일을 확인해 주세요.",
  ],
  [
    "이미 없음",
    { status: 200, body: { result: "already_none" } },
    `${TARGET}에는 등록된 인증 앱이 없어요. 바꾼 것은 없어요.`,
  ],
  [
    "로그인 만료(401)",
    {
      status: 401,
      body: { error: { code: "session_expired", requestId: "r" } },
    },
    "로그인이 만료됐어요",
  ],
  [
    "서버 오류(확인 못 함)",
    { status: 500, body: { error: { code: "internal", requestId: "r" } } },
    "초기화했는지 확인하지 못했어요.",
  ],
] as const) {
  test(`${name}이면 실패와 구분된 문구를 보여 준다`, async ({ page }) => {
    await openAccount(page, reply);
    await startReset(page);
    await dialog(page)
      .getByRole("textbox", {
        name: "확인하려면 초기화할 이메일을 다시 입력해 주세요",
      })
      .fill(TARGET);
    await dialog(page).getByRole("button", { name: "초기화" }).click();
    await expect(page.getByText(text)).toBeVisible();
  });
}

test("데모 계정에는 초기화 칸이 없다", async ({ page }) => {
  await mockCognito(
    page,
    srpScript({
      email: "demo@example.test",
      groups: ["sample"],
      after: "tokens",
    }),
  );
  await mockOps(page, {
    status: 200,
    body: {
      kind: "sample",
      role: "sample",
      authTime: new Date().toISOString(),
      sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
  });
  await signInWithPassword(page, "/login/demo/", "demo@example.test");
  await page.getByRole("link", { name: "내 계정" }).click();
  await expect(page.getByRole("heading", { name: "내 계정" })).toBeVisible();
  await expect(
    page.getByText("데모 계정은 비밀번호와 2단계 인증을 바꿀 수 없어요."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "다른 운영자의 2단계 인증 초기화" }),
  ).toHaveCount(0);
});

test("화면 테마 라디오 그룹은 키보드 이동·새로고침·새 탭·로그인 화면에서 유지되고 기기 설정보다 우선한다", async ({
  browser,
}) => {
  const context = await browser.newContext({ colorScheme: "dark" });
  const page = await context.newPage();
  const authTime = Math.floor(Date.now() / 1000);
  await mockCognito(
    page,
    srpScript({ email: OPS, after: "tokens", groups: ["viewer"], authTime }),
    (target) =>
      target === "GetTokensFromRefreshToken"
        ? {
            body: {
              AuthenticationResult: tokensFor(OPS, ["viewer"], 900, authTime),
            },
          }
        : undefined,
  );
  await mockOps(page, { ...ME_OK, body: { ...ME_OK.body, role: "viewer" } });
  await signInWithPassword(page, "/login/", OPS);
  await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
  await page.getByRole("link", { name: "내 계정" }).click();
  await expect(page.getByRole("heading", { name: "내 계정" })).toBeVisible();

  const group = page.getByRole("radiogroup", { name: "화면 테마" });
  await expect(group).toBeVisible();
  const systemRadio = group.getByRole("radio", { name: "시스템" });
  const lightRadio = group.getByRole("radio", { name: "라이트" });
  const darkRadio = group.getByRole("radio", { name: "다크" });

  await expect(systemRadio).toBeChecked();
  await systemRadio.focus();
  await page.keyboard.press("ArrowRight");
  await expect(lightRadio).toBeChecked();
  await expect(lightRadio).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // 새로고침 후 유지
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(
    await page.evaluate(() => localStorage.getItem("baradun-admin:theme")),
  ).toBe("light");

  // 새 탭에서도 유지
  const second = await context.newPage();
  await second.goto("/login/");
  await expect(second.locator("html")).toHaveAttribute("data-theme", "light");
  await expectNoA11yViolations(second);

  // 다크 선택 시 기기 설정(light)과 무관하게 다크 유지, 다른 탭도 따라감
  await page.emulateMedia({ colorScheme: "light" });
  await lightRadio.focus();
  await page.keyboard.press("ArrowRight");
  await expect(darkRadio).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(second.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectNoA11yViolations(page);

  // 시스템으로 돌리면 저장 키와 data-theme 속성이 사라짐
  await page.keyboard.press("ArrowRight");
  await expect(systemRadio).toBeChecked();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  expect(
    await page.evaluate(() => localStorage.getItem("baradun-admin:theme")),
  ).toBeNull();

  // 라이트 선택 후 로그아웃해도 테마 키는 지우지 않음
  await lightRadio.click();
  await page.getByRole("button", { name: "이 기기에서 로그아웃" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(
    await page.evaluate(() => localStorage.getItem("baradun-admin:theme")),
  ).toBe("light");

  await context.close();
});

test("내 계정 화면 구성(V24)과 비밀번호 변경 토스트가 기준에 맞다", async ({
  page,
}) => {
  await openAccount(page);

  // 프로필: 이메일만(이름 칸 없음)
  await expect(
    page.getByRole("textbox", { name: "이메일", exact: true }),
  ).toHaveValue(OPS);
  await expect(page.getByRole("textbox", { name: "이름" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "이름 바꾸기" }),
  ).toHaveCount(0);

  // 2단계 인증 줄 형태 + 운영 책임자만 배지 + 로그인 섹션
  await expect(page.getByText("인증 앱 등록됨")).toBeVisible();
  await expect(page.getByText("로그인마다 6자리 코드")).toBeVisible();
  await expect(page.getByText("운영 책임자만")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "이 기기에서 로그아웃" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "모든 기기에서 로그아웃" }),
  ).toBeVisible();

  // 넣지 않는 섹션 없음
  await expect(
    page.getByRole("heading", { name: "알림 받는 곳" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "로그인한 기기" }),
  ).toHaveCount(0);

  // 비밀번호 변경 성공 시 상단 토스트 표시
  await page.route("https://cognito-idp.ap-northeast-2.amazonaws.com/", async (route) => {
    const target = route.request().headers()["x-amz-target"] ?? "";
    if (target.endsWith(".ChangePassword")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }
    await route.fallback();
  });
  await page.getByLabel("지금 비밀번호").fill("CurrentPass123!");
  await page.getByLabel("새 비밀번호").fill("NextPassword123!");
  await page.getByLabel("한 번 더").fill("NextPassword123!");
  await page.getByRole("button", { name: "비밀번호 바꾸기" }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: "비밀번호를 바꿨어요. 다른 기기에서는 다시 로그인해야 해요.",
    }),
  ).toBeVisible();
});
