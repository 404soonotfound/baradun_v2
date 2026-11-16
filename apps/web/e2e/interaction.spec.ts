import type { Page, Route } from "@playwright/test";

import en from "../messages/en.json";
import ko from "../messages/ko.json";
import {
  NOTICE_EFFECTIVE_DATE,
  NOTICE_VERSION,
} from "../src/lib/notice-version";

import {
  CLEAR_ID,
  expect,
  expectNoA11yViolations,
  expectNoHorizontalScroll,
  slugOf,
  test,
  WARNING_ID,
} from "./fixtures";

// 키보드·대화상자·PC/모바일 같은 기능·반응형 (BRD-39 · 리뷰 점검표 10·12)

// 열린 대화상자 안에 포커스가 있는지
async function focusInsideOpenDialog(page: Page) {
  return page.evaluate(() => {
    const dialog = document.querySelector("dialog[open]");
    return !!dialog && dialog.contains(document.activeElement);
  });
}

// ON-1이 inline open일 때 배경 main·nav·footer가 모두 inert(또는 inert 부모 아래)인지
async function backgroundInertStates(page: Page) {
  return page.evaluate(() => ({
    main: Boolean(document.querySelector("main")?.closest("[inert]")),
    navAll: [...document.querySelectorAll("nav")].every((el) =>
      Boolean(el.closest("[inert]")),
    ),
    navAny: [...document.querySelectorAll("nav")].some((el) =>
      Boolean(el.closest("[inert]")),
    ),
    footer: Boolean(document.querySelector("footer")?.closest("[inert]")),
  }));
}

// 포커스가 대화상자 뒤 화면으로 새지 않는지. 기본 <dialog>는 마지막 요소 다음에 브라우저 주소창으로
// 나갔다 돌아오므로(그동안 activeElement = body) body도 허용함
async function focusNotBehindDialog(page: Page) {
  return page.evaluate(() => {
    const dialog = document.querySelector("dialog[open]");
    const active = document.activeElement;
    return (
      !!dialog &&
      (active === null || active === document.body || dialog.contains(active))
    );
  });
}

// 모바일 판단 묶음은 '확인한 것'·'주변 특보'를 접어 둠(D18-11 ②) → 배지 줄 버튼으로 연 뒤 '자세히'를 누름. PC는 늘 펼침
async function openChecked(page: Page, project: string) {
  if (project === "desktop") return;
  const toggle = page.getByRole("button", {
    name: /^(확인한 것|주변 특보)/,
    expanded: false,
  });
  await toggle.click();
  await expect(
    page.getByRole("button", { name: "접기", expanded: true }),
  ).toBeVisible();
}

// 대화상자: 열면 포커스가 안으로, Tab은 안에서만 돌고, Esc로 닫히면 연 버튼으로 돌아오고 스크롤 잠금이 풀림
async function checkSheet(page: Page, opener: string, title: string) {
  const button = page.getByRole("button", { name: opener }).first();
  await button.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  expect(await focusInsideOpenDialog(page)).toBe(true);
  expect(
    await page.evaluate(() => document.documentElement.style.overflow),
  ).toBe("hidden");
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    expect(await focusNotBehindDialog(page)).toBe(true);
  }
  // 열림 움직임(투명도)이 끝난 뒤 대비를 봄. 계속 도는 움직임(스켈레톤)은 기다리지 않음
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
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  // 닫기는 기록(뒤로 가기)을 거쳐 끝나서 잠금 해제를 기다림
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.overflow))
    .toBe("");
}

test.describe("대화상자", () => {
  test("지역 고르기", async ({ page }) => {
    await page.goto("/");
    await checkSheet(page, "지역 고르기, 지금 강원 강릉시", "지역 고르기");
  });

  test("공유·활동·특보 상세", async ({ page }, testInfo) => {
    await page.goto(`/spots/${slugOf(WARNING_ID)}/`);
    await expect(page.getByText("풍랑주의보").first()).toBeVisible();
    await checkSheet(page, "공유", "공유하기");
    await checkSheet(page, "특보 상세 보기", "풍랑주의보");
    // 상세에서는 활동을 고르지 않고 확인된 활동만 보여줌(D18-4). 고르는 버튼·세그먼트가 없음
    await expect(page.getByRole("button", { name: "수영" })).toHaveCount(0);
    await expect(
      page.getByRole("group", { name: "어떤 활동을 찾아볼까요?" }),
    ).toHaveCount(0);
    await openChecked(page, testInfo.project.name);
    await checkSheet(page, "자세히", "무엇을 확인했나요");
  });

  // 낮은 화면(가로 모드·작은 휴대폰)에서 내용이 스크롤되면 키보드로도 스크롤할 수 있어야 함(axe scrollable-region-focusable)
  test.describe("낮은 화면", () => {
    test.use({ viewport: { width: 390, height: 600 } });
    test("긴 시트 내용도 키보드로 닿음", async ({ page }) => {
      await page.goto(`/spots/${slugOf(WARNING_ID)}/`);
      await expect(page.getByText("풍랑주의보").first()).toBeVisible();
      await openChecked(page, "mobile");
      await checkSheet(page, "자세히", "무엇을 확인했나요");
    });
  });

  test.describe("첫 실행 안내", () => {
    test.use({ seeded: false });
    test("포커스가 안에 있고 Esc로 건너뛰지 않음", async ({ page }) => {
      await page.goto("/");
      const confirm = page.getByRole("button", { name: "확인했어요" });
      await expect(confirm).toBeVisible();
      await expect.poll(() => focusInsideOpenDialog(page)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(confirm).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("처리방침 링크로 해당 절을 읽고, 다른 화면에서는 고지를 다시 봄", async ({
      page,
    }) => {
      await page.goto("/");
      await page
        .getByRole("link", {
          name: "개인정보 처리방침과 이용 안내는 서비스 정보·약관에서 볼 수 있어요",
        })
        .click();
      await expect(page).toHaveURL(/\/terms\/#terms-privacy$/);
      await expect(
        page.getByRole("heading", { name: "개인정보 처리방침" }),
      ).toBeVisible();
      await expect(page.locator("dialog[open]")).toHaveCount(0);

      await page.goto("/settings/");
      await expect(
        page.getByRole("button", { name: "확인했어요" }),
      ).toBeVisible();
    });

    test("바로 전 고지 버전을 확인한 기기에서도 지금 고지 안내가 다시 뜨고, 약관에 새 시행일이 보임", async ({
      page,
    }) => {
      await page.addInitScript((previousVersion) => {
        if (sessionStorage.getItem("e2e:prev-notice")) return;
        sessionStorage.setItem("e2e:prev-notice", "1");
        localStorage.setItem("baradun:language", "ko");
        localStorage.setItem(
          "baradun:onboarding",
          JSON.stringify({
            noticeVersion: previousVersion,
            acknowledgedAt: "2026-11-02T00:00:00.000Z",
            locationStepDone: true,
          }),
        );
      }, NOTICE_VERSION - 1);
      await page.goto("/");
      const confirm = page.getByRole("button", { name: "확인했어요" });
      await expect(confirm).toBeVisible();
      await confirm.click();
      await expect(page.locator("dialog[open]")).toHaveCount(0);

      await page.goto("/terms/");
      await expect(
        page.getByText(`시행일: ${NOTICE_EFFECTIVE_DATE}`),
      ).toBeVisible();
      await expect(
        page.getByText(
          `고지 버전 ${NOTICE_VERSION} · 시행일 ${NOTICE_EFFECTIVE_DATE}`,
        ),
      ).toBeVisible();
    });

    test("수화 전에는 '불러오는 중' 비활성 버튼과 CSS 숨김으로 Tab이 ON-1 밖에 닿지 않고 수화 뒤 확인·해제됨", async ({
      page,
    }) => {
      let jsReleased = false;
      const pendingJs: Array<() => void> = [];
      await page.route("**/_next/static/**/*.js", async (route) => {
        if (!jsReleased) {
          await new Promise<void>((resolve) => {
            pendingJs.push(resolve);
          });
        }
        await route.continue();
      });

      await page.goto("/", { waitUntil: "domcontentloaded" });
      const loadingButton = page.getByRole("button", { name: "불러오는 중" });
      await expect(loadingButton).toBeVisible();
      await expect(loadingButton).toHaveAttribute("aria-disabled", "true");
      await expect(
        page.getByRole("button", { name: "확인했어요" }),
      ).toHaveCount(0);
      expect(
        await page.evaluate(
          () => getComputedStyle(document.querySelector("main")!).visibility,
        ),
      ).toBe("hidden");

      // 수화 전에도 Tab이 ON-1 밖(main·nav·footer·건너뛰기 링크)으로 나가지 않는지 확인
      for (let step = 0; step < 8; step += 1) {
        await page.keyboard.press("Tab");
        expect(await focusNotBehindDialog(page)).toBe(true);
      }

      jsReleased = true;
      pendingJs.splice(0).forEach((resolve) => resolve());

      const confirm = page.getByRole("button", { name: "확인했어요" });
      await expect(confirm).toBeVisible();
      await expect(confirm).not.toHaveAttribute("aria-disabled", "true");
      await expect.poll(() => focusInsideOpenDialog(page)).toBe(true);
      expect(await backgroundInertStates(page)).toMatchObject({
        main: true,
        navAll: true,
        footer: true,
      });

      await confirm.click();
      await expect
        .poll(() => backgroundInertStates(page))
        .toMatchObject({
          main: false,
          navAny: false,
          footer: false,
        });
    });

    for (const { url, navLabel, homeName, confirmName, homeUrl } of [
      {
        url: "/terms/",
        navLabel: "주요 메뉴",
        homeName: "홈",
        confirmName: "확인했어요",
        homeUrl: /\/$/,
      },
      {
        url: "/en/guide/",
        navLabel: "Main menu",
        homeName: "Home",
        confirmName: "I understand",
        homeUrl: /\/en\/$/,
      },
    ]) {
      test(`${url}로 들어온 첫 방문자가 홈으로 이동해도 ON-1이 보이고 확인 뒤 inert가 풀림`, async ({
        page,
      }) => {
        await page.goto(url);
        await expect(page.locator("html")).toHaveAttribute(
          "data-onboarded",
          "",
        );
        await expect(page.locator("dialog[open]")).toHaveCount(0);

        await page
          .getByRole("navigation", { name: navLabel })
          .getByRole("link", { name: homeName, exact: true })
          .click();
        await expect(page).toHaveURL(homeUrl);

        const confirm = page.getByRole("button", { name: confirmName });
        await expect(confirm).toBeVisible();
        await expect.poll(() => focusInsideOpenDialog(page)).toBe(true);
        expect(await backgroundInertStates(page)).toMatchObject({
          main: true,
          navAll: true,
          footer: true,
        });

        await confirm.click();
        await expect
          .poll(() => backgroundInertStates(page))
          .toMatchObject({
            main: false,
            navAny: false,
            footer: false,
          });
      });
    }
  });

  test("기기 데이터 초기화 확인 창에 탐색 정렬·탭별 마지막 위치 안내가 보임", async ({
    page,
  }, testInfo) => {
    await page.goto("/settings/");
    // 모바일은 '기기 데이터 관리' 줄이 바로 시트를 열고, PC는 오른쪽 묶음의 '기기 데이터 초기화'로 엶
    await page.getByRole("button", { name: "기기 데이터 관리" }).click();
    if (testInfo.project.name === "desktop") {
      await page.getByRole("button", { name: "기기 데이터 초기화" }).click();
    }
    const dialog = page.getByRole("dialog", {
      name: "기기 데이터를 지울까요?",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("탐색 정렬, 탭별 마지막 위치");
  });

  test("고지를 확인한 기기에서 초기화하면 data-onboarded가 있어도 ON-1·결과 안내가 보이고 확인 뒤 inert가 풀림", async ({
    page,
  }, testInfo) => {
    await page.goto("/settings/");
    await expect(page.locator("html")).toHaveAttribute("data-onboarded", "");
    await page.getByRole("button", { name: "기기 데이터 관리" }).click();
    if (testInfo.project.name === "desktop") {
      await page.getByRole("button", { name: "기기 데이터 초기화" }).click();
    }
    const resetDialog = page.getByRole("dialog", {
      name: "기기 데이터를 지울까요?",
    });
    await expect(resetDialog).toBeVisible();
    await resetDialog.getByRole("button", { name: "지우기" }).click();

    const confirm = page.getByRole("button", { name: "확인했어요" });
    await expect(confirm).toBeVisible();
    await expect(page.getByText("기기 데이터를 지웠어요")).toBeVisible();
    await expect.poll(() => focusInsideOpenDialog(page)).toBe(true);
    expect(await backgroundInertStates(page)).toMatchObject({
      main: true,
      navAll: true,
      footer: true,
    });

    await confirm.click();
    await expect
      .poll(() => backgroundInertStates(page))
      .toMatchObject({
        main: false,
        navAny: false,
        footer: false,
      });

    // 이어서 열린 ON-2(위치 안내)도 닫아 스크롤 잠금이 풀리는지 확인
    const pick = page.getByRole("button", { name: "지역 직접 고르기" });
    await expect(pick).toBeVisible();
    await pick.click();
    await page
      .getByRole("dialog", { name: "지역 고르기" })
      .getByRole("button", { name: /전국/ })
      .click();
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.overflow))
      .toBe("");
  });

  test.describe("전국 목록 탭 위치 복원", () => {
    test.use({ deviceRegion: null });

    async function clickNavTab(page: Page, name: "홈" | "탐색") {
      // Playwright locator.click()은 sticky 상단 내비에서도 scrollIntoViewIfNeeded로 스크롤을 당길 수 있어 보이는 위치 그대로 클릭
      const link = page
        .getByRole("navigation", { name: "주요 메뉴" })
        .getByRole("link", { name, exact: true });
      const box = await link.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    }

    async function prepareExploreRow(
      page: Page,
      projectName: string,
    ): Promise<{ href: string | null; top: number; scrollY: number }> {
      await page.goto("/explore/");
      if (projectName !== "desktop") {
        await page.getByRole("button", { name: "목록", exact: true }).click();
      }
      const targetRow = page.locator("main li a[href*='/spots/']").nth(80);
      await expect(targetRow).toBeVisible();

      const saved = await targetRow.evaluate((el) => {
        const targetY = window.scrollY + el.getBoundingClientRect().top - 160;
        window.scrollTo(0, targetY);
        return {
          href: el.getAttribute("href"),
          top: Math.round(el.getBoundingClientRect().top),
          scrollY: Math.round(window.scrollY),
        };
      });
      expect(saved.scrollY).toBeGreaterThan(1000);
      return saved;
    }

    test("탐색 목록에서 다른 탭을 다녀와도 보던 해변 위치로 정확히 돌아옴", async ({
      page,
    }, testInfo) => {
      const saved = await prepareExploreRow(page, testInfo.project.name);

      await clickNavTab(page, "홈");
      await expect(page).toHaveURL(/\/$/);
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "오늘은 어떤 바다로 갈까요?",
        }),
      ).toBeVisible();

      await page
        .getByRole("navigation", { name: "주요 메뉴" })
        .getByRole("link", { name: "탐색", exact: true })
        .click();
      await expect(page).toHaveURL(/\/explore\/$/);

      const restoredRow = page.locator(`main li a[href="${saved.href}"]`);
      await expect(restoredRow).toBeVisible();
      await expect
        .poll(async () =>
          restoredRow.evaluate((el) =>
            Math.round(el.getBoundingClientRect().top),
          ),
        )
        .toBeLessThanOrEqual(saved.top + 8);
      const afterTop = await restoredRow.evaluate((el) =>
        Math.round(el.getBoundingClientRect().top),
      );
      expect(Math.abs(afterTop - saved.top)).toBeLessThanOrEqual(8);
    });

    test("홈 전환이 끝나기 전에 탐색을 다시 누르면 탐색으로 가고, 보던 위치로 돌아옴", async ({
      page,
    }, testInfo) => {
      let holdHome = true;
      const held: Route[] = [];
      // /explore/ 진입 전에 가로채 두어 홈 프리패치·전환 RSC 응답을 결정적으로 붙잡아 둠
      await page.route("**/*.txt*", async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (
          holdHome &&
          (pathname === "/index.txt" || pathname.startsWith("/__next."))
        ) {
          held.push(route);
          return;
        }
        await route.continue();
      });

      const saved = await prepareExploreRow(page, testInfo.project.name);

      await clickNavTab(page, "홈");
      await expect.poll(() => held.length).toBeGreaterThan(0);

      // 홈 전환이 아직 커밋되지 않은 상태에서 탐색을 다시 클릭
      await clickNavTab(page, "탐색");

      // 붙잡아 둔 홈 RSC 응답을 마저 풀어 줘도 홈으로 끌려가지 않고 탐색에 남음
      holdHome = false;
      await Promise.all(held.splice(0).map((route) => route.continue()));

      await expect(page).toHaveURL(/\/explore\/$/);
      await expect(
        page.getByRole("heading", { level: 1, name: "탐색" }),
      ).toBeVisible();
      // 풀어 준 홈 전환이 늦게 탐색을 덮어쓰지 않는지 한 박자 더 확인
      await page.waitForTimeout(300);
      await expect(page).toHaveURL(/\/explore\/$/);

      const restoredRow = page.locator(`main li a[href="${saved.href}"]`);
      await expect(restoredRow).toBeVisible();
      const afterTop = await restoredRow.evaluate((el) =>
        Math.round(el.getBoundingClientRect().top),
      );
      expect(Math.abs(afterTop - saved.top)).toBeLessThanOrEqual(8);

      // 전환 취소 뒤에도 다시 정상 왕복 시 새 스크롤 위치 저장이 살아 있는지 확인
      await clickNavTab(page, "홈");
      await expect(page).toHaveURL(/\/$/);
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "오늘은 어떤 바다로 갈까요?",
        }),
      ).toBeVisible();
      await clickNavTab(page, "탐색");
      await expect(page).toHaveURL(/\/explore\/$/);
      await expect(restoredRow).toBeVisible();
      await expect
        .poll(async () =>
          Math.abs(
            (await restoredRow.evaluate((el) =>
              Math.round(el.getBoundingClientRect().top),
            )) - saved.top,
          ),
        )
        .toBeLessThanOrEqual(8);
    });
  });
});

test.describe("키보드", () => {
  test("본문으로 건너뛰기", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("main")).toBeVisible();
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "본문으로 건너뛰기" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
  });

  // 키보드만으로 주요 메뉴에 닿고, 포커스가 고정된 아래 탭 막대·위 막대에 가려지지 않음(WCAG 2.4.11)
  for (const url of [
    "/",
    "/explore/",
    `/spots/${slugOf(CLEAR_ID)}/`,
    "/settings/",
  ]) {
    test(`Tab으로 돌기 · 포커스가 가려지지 않음 ${url}`, async ({ page }) => {
      await page.goto(url);
      await expect(page.locator("main")).toBeVisible();
      const names = new Set<string>();
      const hidden: string[] = [];
      for (let index = 0; index < 150; index += 1) {
        await page.keyboard.press("Tab");
        const info = await page.evaluate(() => {
          const element = document.activeElement as HTMLElement | null;
          if (!element || element === document.body) return null;
          const box = element.getBoundingClientRect();
          // 포커스 요소의 가운데에 실제로 보이는 것이 자기(또는 자기 안쪽)인지
          const x = Math.min(
            Math.max(box.left + box.width / 2, 0),
            innerWidth - 1,
          );
          const y = Math.min(
            Math.max(box.top + box.height / 2, 0),
            innerHeight - 1,
          );
          const top = document.elementFromPoint(x, y);
          const visible =
            box.width <= 1 || // 화면 밖에 숨긴 건너뛰기 링크 등
            (top !== null && (element.contains(top) || top.contains(element)));
          return {
            name:
              element.getAttribute("aria-label") ??
              element.textContent?.trim().slice(0, 30) ??
              "",
            visible,
          };
        });
        if (!info) continue;
        names.add(info.name);
        if (!info.visible) hidden.push(info.name);
      }
      expect(hidden).toEqual([]);
      // 상세는 모바일에서 아래 탭 막대 대신 뒤로 버튼을 둠(노션 2장 DET)
      if (url.startsWith("/spots/")) return;
      for (const name of ["탐색", "즐겨찾기"]) {
        expect([...names].some((value) => value.includes(name))).toBe(true);
      }
    });
  }
});

// PC·모바일 모두 같은 기능에 닿음(모바일 전용 진입점만 두지 않음)
test.describe("PC·모바일 같은 기능", () => {
  for (const [name, path] of [
    ["탐색", "/explore/"],
    ["즐겨찾기", "/favorites/"],
    ["설정", "/settings/"],
    ["홈", "/"],
  ] as const) {
    test(`${name}`, async ({ page }) => {
      await page.goto(name === "홈" ? "/explore/" : "/");
      await page.getByRole("link", { name, exact: true }).first().click();
      // 주소 끝만 맞추면 홈("/")은 어느 주소에서나 통과함 → 경로 전체를 비교
      await expect.poll(() => new URL(page.url()).pathname).toBe(path);
    });
  }

  test("검색", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("link", { name: /검색/ })
      .filter({ visible: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/search\/$/);
    await expect(
      page.getByRole("searchbox").or(page.getByRole("textbox")).first(),
    ).toBeVisible();
  });

  // 사이트 푸터의 안전 보장 아님 문구는 PC·모바일, 한국어·영어, 홈·상세 모두 문장 전체가 보임(D18-7)
  // 문구 원본은 messages(footer.disclaimer)에서 읽음
  for (const [path, text] of [
    ["/", ko.footer.disclaimer],
    ["/en/", en.footer.disclaimer],
    [`/spots/${slugOf(CLEAR_ID)}/`, ko.footer.disclaimer],
  ] as const) {
    test(`푸터 안전 보장 아님 문구 ${path}`, async ({ page }) => {
      await page.goto(path);
      await expect(
        page.getByRole("contentinfo").getByText(text, { exact: true }),
      ).toBeVisible();
    });
  }
});

// 좁은 폭 320px, PC 1280px를 200% 확대한 폭(640px), 그 사이 폭에서 가로 스크롤 없음
test.describe("반응형", () => {
  for (const width of [320, 640, 768, 1024]) {
    test.describe(`${width}px`, () => {
      test.use({ viewport: { width, height: 800 } });
      for (const url of [
        "/",
        "/explore/",
        "/search/",
        `/spots/${slugOf(WARNING_ID)}/`,
        "/favorites/",
        "/settings/",
        "/settings/inquiry/",
        "/guide/",
        "/about/data/",
        "/terms/",
        "/en/",
        `/en/spots/${slugOf(CLEAR_ID)}/`,
      ]) {
        test(url, async ({ page }, info) => {
          // 폭만 바꿔 보는 검사라 한 프로젝트에서만
          test.skip(info.project.name !== "desktop");
          await page.goto(url);
          await expect(page.locator("main")).toBeVisible();
          await expectNoHorizontalScroll(page);
        });
      }
    });
  }
});

test.describe("동작 줄이기", () => {
  test.use({ reducedMotion: "reduce" });
  test("시트가 움직이지 않고 바로 열림", async ({ page }) => {
    await page.goto("/");
    await page
      .getByRole("button", { name: "지역 고르기, 지금 강원 강릉시" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "지역 고르기" }),
    ).toBeVisible();
    const durations = await page.evaluate(() =>
      [...document.querySelectorAll("dialog[open] *")]
        .map((element) => getComputedStyle(element).animationDuration)
        .filter((value) => value !== "0s"),
    );
    for (const value of durations) {
      expect(Number.parseFloat(value)).toBeLessThanOrEqual(0.001);
    }
  });
});

// 누르는 영역 44px(점검표 12 · WCAG 2.5.8보다 엄격한 프로젝트 기준). 보이는 크기가 작아도 ::before로 넓힌 영역을 인정하려고
// 요소 가운데에서 위아래·좌우로 21px(맞닿은 이웃과의 소수점 오차 1px 여유) 떨어진 점을 눌렀을 때 그 요소가 잡히는지 봄. 문장 안 글자 링크(display: inline)는 제외(WCAG 예외)
test.describe("누르는 영역", () => {
  for (const url of [
    "/",
    "/explore/",
    "/search/",
    `/spots/${slugOf(WARNING_ID)}/`,
    "/favorites/",
    "/settings/",
    "/settings/inquiry/",
    "/en/",
  ]) {
    test(url, async ({ page }, info) => {
      test.skip(info.project.name !== "mobile");
      await page.goto(url);
      await expect(page.locator("main")).toBeVisible();
      const small = await page.evaluate(() => {
        const selector =
          "a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=switch], [role=radio], [role=tab]";
        const found: string[] = [];
        for (const element of document.querySelectorAll<HTMLElement>(
          selector,
        )) {
          const style = getComputedStyle(element);
          if (style.display === "inline" || style.visibility === "hidden") {
            continue;
          }
          // 숨긴 입력(라벨이 대신 눌림)·건너뛰기 링크처럼 1px로 숨긴 것은 제외
          let box = element.getBoundingClientRect();
          if (box.width <= 1 || box.height <= 1) continue;
          if (element.closest("[aria-hidden='true'], [inert]")) continue;
          element.scrollIntoView({ block: "center", inline: "center" });
          box = element.getBoundingClientRect();
          const cx = box.left + box.width / 2;
          const cy = box.top + box.height / 2;
          const points: [number, number][] = [
            [cx, cy - 21],
            [cx, cy + 21],
            [cx - 21, cy],
            [cx + 21, cy],
          ];
          const hits = points.every(([x, y]) => {
            const top = document.elementFromPoint(x, y);
            // 라벨로 감싼 숨긴 입력은 라벨이 눌림 영역
            const owner = element.closest("label") ?? element;
            return top !== null && owner.contains(top);
          });
          if (!hits) {
            found.push(
              `${element.tagName}[${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 24)}] ${Math.round(box.width)}x${Math.round(box.height)}`,
            );
          }
        }
        return found;
      });
      expect(small).toEqual([]);
    });
  }
});
