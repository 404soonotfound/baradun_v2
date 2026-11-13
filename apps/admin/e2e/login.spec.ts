import {
  COGNITO_ERRORS,
  ME_OK,
  expect,
  expectNoA11yViolations,
  isDesktop,
  logout,
  mockCognito,
  mockOps,
  openAccountMenu,
  signInWithPassword,
  srpScript,
  test,
  tokensFor,
} from "./fixtures";

// 운영자 로그인 흐름 (BRD-148·179, 캔버스 V26~V29·E8·E11, D16-A2·A5, D17-2·D17-11)

const OPS = "ops@example.test";

test.describe("로그인 화면", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`운영자 로그인·데모 로그인·비밀번호 찾기 접근성 (${scheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      for (const path of ["/login/", "/login/demo/", "/login/forgot/"]) {
        await page.goto(path);
        await expect(page.locator("h1")).toBeVisible();
        await expectNoA11yViolations(page);
      }
    });
  }

  // BRD-180: 켜져 있지 않으면 위반이 0건이어도 아무것도 지키지 않으므로 켜졌는지 확인
  test("Trusted Types가 켜져 있고 default 정책 하나만 있다 @smoke", async ({
    page,
  }) => {
    await page.goto("/login/");
    await expect(page.getByLabel("이메일")).toBeVisible();
    const state = await page.evaluate(() => ({
      csp: document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content"),
      policy: (
        window as unknown as {
          trustedTypes?: { defaultPolicy?: { name: string } | null };
        }
      ).trustedTypes?.defaultPolicy?.name,
    }));
    expect(state.csp).toContain(
      "require-trusted-types-for 'script'; trusted-types default",
    );
    expect(state.policy).toBe("default");
  });

  test("검색 노출을 막고, 기본 로그인 화면에는 데모 입구가 없다(D17-2)", async ({
    page,
  }) => {
    await page.goto("/login/");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      /noindex/,
    );
    await expect(
      page.getByRole("heading", { name: "운영자 로그인" }),
    ).toBeVisible();
    await expect(page.locator('a[href*="demo"]')).toHaveCount(0);
    await expect(page.getByText(/데모/)).toHaveCount(0);

    await page.goto("/login/demo/");
    await expect(
      page.getByRole("heading", { name: "데모 계정 로그인" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "비밀번호를 잊었어요" }),
    ).toHaveCount(0);
  });

  test("로그인하지 않고 운영 화면에 오면 로그인으로 보낸다 @smoke", async ({
    page,
  }) => {
    await page.goto("/account/");
    await expect(page).toHaveURL(/\/login\/$/);
  });
});

test.describe("운영자 로그인", () => {
  test("틀린 이메일·비밀번호는 계정 유무와 상관없이 같은 문구", async ({
    page,
  }) => {
    await mockCognito(page, srpScript({ email: OPS, after: "wrong" }));
    await signInWithPassword(page, "/login/", OPS);
    await expect(
      page.getByText("이메일 또는 비밀번호가 맞지 않아요"),
    ).toBeVisible();
    await expect(page.getByLabel("비밀번호", { exact: true })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  test("잠기면 남은 시간·횟수 없이 '잠시 뒤 다시 시도'만 안내한다(D16-A5)", async ({
    page,
  }) => {
    await mockCognito(page, srpScript({ email: OPS, after: "locked" }));
    await signInWithPassword(page, "/login/", OPS);
    await expect(
      page.getByRole("heading", { name: "잠시 로그인할 수 없어요" }),
    ).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "잠시 뒤" }),
    ).toContainText("잠시 뒤 다시 시도해 주세요.");
    await expect(page.locator("body")).not.toContainText(/\d+\s*(분|초|번)/);
    await expectNoA11yViolations(page);
  });

  test("비밀번호 → 인증 앱 코드(틀림 → 맞음) → 운영 홈, access·ID token은 저장소에 남지 않는다 @smoke", async ({
    page,
  }) => {
    const calls = await mockCognito(
      page,
      srpScript({ email: OPS, after: "totp" }),
    );
    const ops = await mockOps(page, ME_OK);
    await signInWithPassword(page, "/login/", OPS);

    await expect(
      page.getByRole("heading", { name: "인증 앱 코드" }),
    ).toBeVisible();
    await expectNoA11yViolations(page);
    const code = page.getByLabel("인증 앱 코드 6자리");
    await code.fill("000000");
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "코드가 맞지 않아요" }),
    ).toBeVisible();
    await expect(page.getByText("다시 넣어 주세요")).toBeVisible();

    await code.fill("123456");
    await page.getByRole("button", { name: "다시 확인" }).click();
    await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
    // 로그인 계정·권한은 공통 틀(PC 왼쪽 메뉴)에서 확인. 운영 홈의 계정 줄은 지움(GH-453)
    if (isDesktop(page)) {
      const side = page.locator("aside");
      await expect(side.getByText(OPS)).toBeVisible();
      await expect(side.getByText(/운영 · 노출 변경/)).toBeVisible();
    }
    // 운영 홈 본문(가짜 응답이 없는 운영 API는 '확인 못 함'으로 보임)
    await expect(page.getByRole("heading", { name: "할 일" })).toBeVisible();
    await expectNoA11yViolations(page);

    // 운영 API에는 전용 헤더로 access token만(Authorization 없음)
    expect(ops[0]?.["x-baradun-access-token"]).toMatch(/^ey/);
    expect(ops[0]?.authorization).toBeUndefined();
    expect(calls.map((c) => c.target)).toEqual([
      "InitiateAuth",
      "RespondToAuthChallenge",
      "RespondToAuthChallenge",
      "RespondToAuthChallenge",
    ]);
    // D16-A2·D17-11: access·ID token은 저장소에 두지 않고, 이 탭의 sessionStorage에 refresh token만
    const stored = await page.evaluate(() => ({
      local: Object.keys(localStorage).length,
      cookie: document.cookie,
      session: JSON.stringify({ ...sessionStorage }),
    }));
    expect(stored).toMatchObject({ local: 0, cookie: "" });
    expect(stored.session).toContain("refreshToken");
    expect(stored.session).not.toMatch(/eyJ/);
  });

  // 2026-11-04 사용자 결정(D17-11): 하나뿐인 탭도 새로고침하면 이 탭에 둔 refresh token으로 이어 감
  test("새로고침해도 다시 로그인하지 않고 보던 화면에 남으며, 로그아웃한 뒤 새로고침하면 로그인 화면이다", async ({
    page,
  }) => {
    const authTime = Math.floor(Date.now() / 1000) - 60;
    const calls = await mockCognito(
      page,
      srpScript({ email: OPS, after: "tokens", authTime }),
      (target) =>
        target === "GetTokensFromRefreshToken"
          ? {
              body: {
                AuthenticationResult: tokensFor(
                  OPS,
                  ["publisher"],
                  900,
                  authTime,
                ),
              },
            }
          : undefined,
    );
    await mockOps(page, ME_OK);
    await signInWithPassword(page, "/login/", OPS);
    await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
    await openAccountMenu(page);
    await page.getByRole("link", { name: "내 계정" }).click();
    await expect(page.getByRole("heading", { name: "내 계정" })).toBeVisible();

    const visited: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) visited.push(frame.url());
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "내 계정" })).toBeVisible();
    // 제목은 세션 확인 중 틀(GH-462 보드 L10)에도 보이므로 이어 간 뒤의 내용까지 기다림
    await expect(
      page.getByRole("button", { name: "이 기기에서 로그아웃" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/account\/$/);
    expect(visited.filter((url) => url.includes("/login"))).toEqual([]);
    expect(
      calls.filter((c) => c.target === "GetTokensFromRefreshToken"),
    ).toHaveLength(1);
    await expectNoA11yViolations(page);

    await page.getByRole("button", { name: "이 기기에서 로그아웃" }).click();
    await expect(page).toHaveURL(/\/login\/$/);
    await page.goto("/account/");
    await expect(page).toHaveURL(/\/login\/$/);
    await expect(page.getByLabel("이메일")).toBeVisible();
  });

  test("새로고침 때 refresh token으로 이어 가지 못하면 로그인 화면으로 간다", async ({
    page,
  }) => {
    await mockCognito(
      page,
      srpScript({ email: OPS, after: "tokens" }),
      (target) =>
        target === "GetTokensFromRefreshToken"
          ? COGNITO_ERRORS.error(
              "NotAuthorizedException",
              "Refresh Token has been revoked",
            )
          : undefined,
    );
    await mockOps(page, ME_OK);
    await signInWithPassword(page, "/login/", OPS);
    await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/login\/$/);
    await expect(page.getByLabel("이메일")).toBeVisible();
    await expect(page.getByText("로그인을 이어 가지 못했어요")).toBeVisible();
    await expect(
      page.getByText("이 탭에 남아 있던 로그인이 만료됐거나"),
    ).toBeVisible();
    await expectNoA11yViolations(page);
    const stored = await page.evaluate(() => sessionStorage.length);
    expect(stored).toBe(0);
  });

  // 2026-11-04 사용자 결정(D16-A10 변경): 새 탭은 열린 로그인한 탭에서 넘겨받음. 토큰은 저장소에 두지 않음
  test("새 탭은 로그인한 탭에서 넘겨받아 다시 로그인하지 않고, 한 탭에서 로그아웃하면 다른 탭도 로그아웃된다", async ({
    page,
    context,
  }) => {
    await mockCognito(page, srpScript({ email: OPS, after: "tokens" }));
    await mockOps(page, ME_OK);
    await signInWithPassword(page, "/login/", OPS);
    await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();

    const second = await context.newPage();
    await mockOps(second, ME_OK);
    // 넘겨받는 동안 로그인 화면을 거쳐 돌아오지 않음(보던 주소 그대로)
    const visited: string[] = [];
    second.on("framenavigated", (frame) => {
      if (frame === second.mainFrame()) visited.push(frame.url());
    });
    await second.goto("/stats/");
    await expect(
      second.getByRole("heading", { name: "이용 통계", level: 1 }),
    ).toBeVisible();
    await expect(second).toHaveURL(/\/stats\/$/);
    expect(visited.filter((url) => url.includes("/login"))).toEqual([]);
    // 넘겨받아도 access·ID token은 브라우저 저장소에 두지 않음(D16-A2·D17-11)
    const stored = await second.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(stored).not.toMatch(/eyJ/);

    await logout(second);
    await expect(second).toHaveURL(/\/login\/$/);
    await expect(page).toHaveURL(/\/login\/$/);
  });

  test("운영자 탭이 열려 있어도 데모 주소의 새 탭은 넘겨받지 않고 데모 로그인 화면을 보여 준다", async ({
    page,
    context,
  }) => {
    await mockCognito(page, srpScript({ email: OPS, after: "tokens" }));
    await mockOps(page, ME_OK);
    await signInWithPassword(page, "/login/", OPS);
    await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();

    const second = await context.newPage();
    await second.goto("/login/demo/");
    await expect(second.getByLabel("이메일")).toBeVisible();
    await expect(second).toHaveURL(/\/login\/demo\/$/);
  });

  test("로그인한 탭이 없으면 새 탭은 로그인 화면으로 간다", async ({
    page,
  }) => {
    await page.goto("/account/");
    await expect(page).toHaveURL(/\/login\/$/);
    await expect(page.getByLabel("이메일")).toBeVisible();
  });

  test("로그아웃하면 refresh token을 폐기하고 로그인 화면에 안내를 보여 준다", async ({
    page,
  }) => {
    const calls = await mockCognito(
      page,
      srpScript({ email: OPS, after: "tokens" }),
    );
    await mockOps(page, ME_OK);
    await signInWithPassword(page, "/login/", OPS);
    await logout(page);
    await expect(page).toHaveURL(/\/login\/$/);
    await expect(page.getByText("로그아웃했어요")).toBeVisible();
    await expect
      .poll(() => calls.some((c) => c.target === "RevokeToken"))
      .toBe(true);
  });
});

test.describe("첫 로그인 (V28)", () => {
  test("새 비밀번호(규칙 확인) → 인증 앱 QR·설정 키 → 코드 → 준비 완료 → 운영 홈", async ({
    page,
  }) => {
    await mockCognito(page, srpScript({ email: OPS, after: "new_password" }));
    await mockOps(page, ME_OK);
    await signInWithPassword(page, "/login/", OPS);

    await expect(
      page.getByRole("heading", { name: "새 비밀번호를 정해 주세요" }),
    ).toBeVisible();
    const submit = page.getByRole("button", { name: "다음" });
    await page.getByLabel("새 비밀번호").fill("short1");
    await page.getByLabel("한 번 더").fill("short1");
    await expect(submit).toBeDisabled();
    await page.getByLabel("새 비밀번호").fill("long-enough-password-1");
    await page.getByLabel("한 번 더").fill("long-enough-password-1");
    await expectNoA11yViolations(page);
    await submit.click();

    await expect(
      page.getByRole("heading", { name: "인증 앱을 연결해 주세요" }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: "인증 앱 등록 QR 코드" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "QR을 못 찍으면 설정 키 입력" })
      .click();
    await expect(page.getByText("JBSW Y3DP EHPK 3PXP")).toBeVisible();
    await expectNoA11yViolations(page);
    await page.getByLabel("인증 앱 코드 6자리").fill("123456");
    await page.getByRole("button", { name: "연결하고 시작하기" }).click();

    await expect(
      page.getByRole("heading", { name: "준비가 끝났어요" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "운영 홈으로" }).click();
    await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
  });
});

test.describe("데모 계정 (D17-2)", () => {
  test("숨은 주소에서 비밀번호만으로 들어가고, 데모 표시가 있으며 기간 밖이면 서버 거절을 알린다", async ({
    page,
  }) => {
    await mockCognito(
      page,
      srpScript({
        email: "demo@example.test",
        groups: ["sample"],
        after: "tokens",
      }),
    );
    await mockOps(page, {
      status: 403,
      body: {
        error: { code: "sample_not_allowed", requestId: "req-00000000" },
      },
    });
    await signInWithPassword(page, "/login/demo/", "demo@example.test");
    await expect(page.getByText("데모 계정 · 읽기만")).toBeVisible();
    await expect(
      page.getByText("데모 계정을 쓸 수 있는 기간이 아니에요"),
    ).toBeVisible();
    await expectNoA11yViolations(page);
    await logout(page);
    await expect(page).toHaveURL(/\/login\/demo\/$/);
  });
});

test.describe("비밀번호 찾기 (V29)", () => {
  test("등록 여부와 상관없이 코드 화면 → 코드 틀림 → 다시 → 완료", async ({
    page,
  }) => {
    let confirms = 0;
    await mockCognito(page, (target) => {
      if (target === "ForgotPassword")
        return COGNITO_ERRORS.error("UserNotFoundException");
      if (target === "ConfirmForgotPassword") {
        confirms += 1;
        return confirms === 1
          ? COGNITO_ERRORS.error("CodeMismatchException")
          : { body: {} };
      }
      return undefined;
    });
    await page.goto("/login/forgot/");
    await page.getByLabel("이메일").fill("nobody@example.test");
    await page.getByRole("button", { name: "코드 받기" }).click();
    await expect(
      page.getByRole("heading", { name: "메일로 받은 코드를 넣어 주세요" }),
    ).toBeVisible();
    await expect(
      page.getByText("등록된 이메일이면 코드를 보냈어요."),
    ).toBeVisible();

    await page.getByLabel("메일로 받은 코드 6자리").fill("111111");
    await page.getByLabel("새 비밀번호").fill("long-enough-password-1");
    await page.getByLabel("한 번 더").fill("long-enough-password-1");
    await page.getByRole("button", { name: "비밀번호 바꾸기" }).click();
    await expect(
      page.getByRole("heading", { name: "코드가 맞지 않아요" }),
    ).toBeVisible();
    await expectNoA11yViolations(page);

    await page.getByLabel("메일로 받은 코드 6자리").fill("222222");
    await page.getByRole("button", { name: "비밀번호 바꾸기" }).click();
    await expect(
      page.getByRole("heading", { name: "비밀번호를 바꿨어요" }),
    ).toBeVisible();
  });
});

test.describe("세션 시간 (D16-A3·E1, 캔버스 V31·E11)", () => {
  test("활동 없이 58분이면 경고, '계속 쓰기'로 연장, 다시 60분이면 만료 안내와 보던 화면", async ({
    page,
  }) => {
    await page.clock.install();
    // 유휴만 보려고 access 만료를 길게 줌(갱신은 다음 테스트에서 봄)
    await mockCognito(
      page,
      srpScript({ email: OPS, after: "tokens", expIn: () => 7200 }),
    );
    await mockOps(page, ME_OK);
    await signInWithPassword(page, "/login/", OPS);
    await openAccountMenu(page);
    await page.getByRole("link", { name: "내 계정" }).click();
    await expect(page.getByRole("heading", { name: "내 계정" })).toBeVisible();

    await page.clock.runFor("58:01");
    const warning = page
      .getByRole("alert")
      .filter({ hasText: "로그인이 만료돼요" });
    await expect(warning).toContainText("2분 뒤 로그인이 만료돼요.");
    await expectNoA11yViolations(page);
    // 시계를 멈춘 동안 애니메이션 프레임도 멈춰 있어 click()의 안정 대기가 끝나지 않음 → 이벤트로 누름
    await page
      .getByRole("button", { name: "계속 쓰기" })
      .dispatchEvent("click");
    await expect(warning).toHaveCount(0);

    await page.clock.runFor("01:00:01");
    await expect(page).toHaveURL(/\/login\/$/);
    await expect(page.getByText("로그인이 만료됐어요")).toBeVisible();
    await expect(
      page.getByText("60분 동안 활동이 없어 로그아웃했어요."),
    ).toBeVisible();
    await expect(page.getByText(/보던 화면: \/account/)).toBeVisible();
  });

  test("토큰 갱신에 실패하면 화면을 그대로 두고 같은 계정으로 다시 로그인 창을 띄운다", async ({
    page,
  }) => {
    await page.clock.install();
    // 처음 토큰은 15분(14분에 갱신 시도), 다시 로그인한 토큰은 넉넉하게(빨리 감은 시계에서 바로 만료되지 않게)
    let issued = 0;
    await mockCognito(
      page,
      srpScript({
        email: OPS,
        after: "totp",
        expIn: () => (issued++ === 0 ? 900 : 7200),
      }),
      (target) =>
        target === "GetTokensFromRefreshToken"
          ? COGNITO_ERRORS.error(
              "NotAuthorizedException",
              "Refresh Token has expired",
            )
          : undefined,
    );
    await mockOps(page, ME_OK);
    await signInWithPassword(page, "/login/", OPS);
    await page.getByLabel("인증 앱 코드 6자리").fill("123456");
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await openAccountMenu(page);
    await page.getByRole("link", { name: "내 계정" }).click();
    await page.getByLabel("지금 비밀번호").fill("draft-kept");

    // 14분: 갱신 시도 → 실패. 활동은 이어서 하는 중(유휴 아님)
    await page.clock.runFor("10:00");
    await page.mouse.move(10, 10);
    await page.keyboard.press("Shift");
    await page.clock.runFor("04:30");
    const dialog = page.getByRole("dialog", {
      name: "로그인을 이어가지 못했어요",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("이메일")).toHaveValue(OPS);
    await expectNoA11yViolations(page);

    await dialog
      .getByLabel("비밀번호", { exact: true })
      .fill("test-password-1");
    await dialog.getByRole("button", { name: "로그인" }).click();
    await dialog.getByLabel("인증 앱 코드 6자리").fill("123456");
    await dialog.getByRole("button", { name: "로그인" }).click();
    await expect(dialog).toHaveCount(0);
    // 쓰던 입력이 그대로 남음
    await expect(page.getByLabel("지금 비밀번호")).toHaveValue("draft-kept");
  });
});
