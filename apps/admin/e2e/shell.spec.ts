import {
  ME_OK,
  expect,
  expectNoA11yViolations,
  isDesktop,
  isMobile,
  mockCognito,
  mockOps,
  openMenu,
  signInWithPassword,
  srpScript,
  test,
} from "./fixtures";
import type { Page } from "@playwright/test";

// 운영자 화면 공통 틀 (BRD-171, 화면 설계서 6장 '공통 틀')

const OPS = "ops@example.test";
const MENU = [
  "운영 홈",
  "이용 통계",
  "수집 현황",
  "데이터 출처",
  "해변",
  "데이터 게시",
  "공지",
  "문의",
  "운영 정책",
  "변경 이력",
];

const nav = (page: Page) =>
  page.getByRole("navigation", { name: "운영 메뉴" }).filter({ visible: true });

// 메뉴로 옮겨 감(페이지를 새로 불러오면 메모리 로그인이 사라지므로 주소 이동은 쓰지 않음)
async function go(page: Page, label: string) {
  await openMenu(page);
  await nav(page).getByRole("link", { name: label }).click();
}

test.beforeEach(async ({ page }) => {
  await mockCognito(page, srpScript({ email: OPS, after: "tokens" }));
  await mockOps(page, ME_OK);
  await signInWithPassword(page, "/login/", OPS);
  await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
});

test("메뉴 순서·지금 화면 표시, 다른 메뉴로 이동하면 aria-current가 바뀐다 @smoke", async ({
  page,
}) => {
  await openMenu(page);
  await expect(nav(page).getByRole("link")).toHaveText(MENU);
  await expect(
    nav(page).getByRole("link", { name: "운영 홈" }),
  ).toHaveAttribute("aria-current", "page");

  await nav(page).getByRole("link", { name: "이용 통계" }).click();
  await expect(page).toHaveURL(/\/stats\/$/);
  await expect(
    page.getByRole("heading", { name: "이용 통계", level: 1 }),
  ).toBeVisible();
  await openMenu(page);
  await expect(
    nav(page).getByRole("link", { name: "이용 통계" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    nav(page).getByRole("link", { name: "운영 홈" }),
  ).not.toHaveAttribute("aria-current");
});

for (const scheme of ["light", "dark"] as const) {
  test(
    `운영 홈·준비 중 화면 접근성과 가로 스크롤 없음 (${scheme})`,
    { tag: scheme === "light" ? "@smoke" : [] },
    async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const check = async () => {
        await expectNoA11yViolations(page);
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          ),
        ).toBe(0);
      };
      await check();
      await go(page, "공지");
      await expect(
        page.getByRole("heading", { name: "공지", level: 1 }),
      ).toBeVisible();
      await check();
    },
  );
}

test("모바일 서랍: 메뉴 버튼으로 열고 Esc·바깥 누르기로 닫는다, 열린 동안 배경 스크롤을 잠근다", async ({
  page,
}) => {
  test.skip(!isMobile(page), "모바일만");
  const button = page.getByRole("button", { name: "메뉴 열기" });
  const drawer = page.getByRole("dialog", { name: "운영 메뉴" });
  const lock = () =>
    page.evaluate(() => document.documentElement.style.overflow);

  await button.click();
  await expect(drawer).toBeVisible();
  expect(await lock()).toBe("hidden");
  await expectNoA11yViolations(page);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  expect(await lock()).toBe("");

  await button.click();
  await expect(drawer).toBeVisible();
  await page.mouse.click(370, 400); // 서랍(280px) 바깥 배경
  await expect(drawer).toBeHidden();

  // 메뉴를 누르면 서랍이 닫히고 그 화면으로
  await go(page, "해변");
  await expect(drawer).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "해변 관리", level: 1 }),
  ).toBeVisible();
  expect(await lock()).toBe("");
});

test.describe("PC 왼쪽 메뉴 (GH-450, 시안 V1 aside)", () => {
  test("폭·항목 높이가 시안 값, 사용자 칸은 이메일과 '…' 메뉴(내 계정·로그아웃), Esc로 닫으면 포커스가 돌아온다 @smoke", async ({
    page,
  }) => {
    test.skip(!isDesktop(page), "PC(1024px 이상)만");
    const aside = page.locator("aside");
    expect((await aside.boundingBox())?.width).toBe(220);
    const home = nav(page).getByRole("link", { name: "운영 홈" });
    expect((await home.boundingBox())?.height).toBe(33);
    await expect(nav(page).getByText("기록", { exact: true })).toBeVisible();

    // 이름 칸 없이 이메일. 내 계정·로그아웃은 메뉴를 열기 전에는 보이지 않음
    await expect(aside.getByText(OPS, { exact: true })).toBeVisible();
    await expect(aside.getByRole("button", { name: "로그아웃" })).toHaveCount(
      0,
    );
    // 홈의 수집 현황 응답이 없으면(가짜 501) '확인 못 함'. 정상으로 두지 않음
    const status = aside.getByRole("group", { name: "운영 상태" });
    await expect(status.getByText("상태 확인 못 함")).toBeVisible();
    await expect(status.getByText(/^운영 화면 /)).toBeVisible();

    const more = aside.getByRole("button", { name: "계정 메뉴" });
    await more.click();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    await expect(aside.getByRole("button", { name: "로그아웃" })).toBeVisible();
    await expectNoA11yViolations(page);
    await page.keyboard.press("Escape");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(more).toBeFocused();

    await more.click();
    await aside.getByRole("link", { name: "내 계정" }).click();
    await expect(
      page.getByRole("heading", { name: "내 계정", level: 1 }),
    ).toBeVisible();
  });

  test("⌘K 찾기: 단축키·단추로 열고 화면 이름으로 찾아 Enter로 옮겨 간다", async ({
    page,
  }) => {
    test.skip(!isDesktop(page), "PC(1024px 이상)만");
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "화면 찾기" });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole("combobox", { name: "화면 이름으로 찾기" });
    await expect(input).toBeFocused();
    await input.fill("통계");
    await expect(dialog.getByRole("option")).toHaveText(["이용 통계"]);
    await expectNoA11yViolations(page);
    await input.fill("없는화면");
    await expect(dialog.getByRole("option")).toHaveCount(0);
    await expect(dialog.getByRole("status")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await page.locator("aside").getByRole("button", { name: /찾기/ }).click();
    await expect(dialog).toBeVisible();
    await input.fill("공지");
    await input.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "공지", level: 1 }),
    ).toBeVisible();
    await expect(nav(page).getByRole("link", { name: "공지" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});

test.describe("태블릿 아이콘 레일", () => {
  test.use({ viewport: { width: 900, height: 800 } });

  test("아이콘만 보이고 이름은 접근 가능한 이름·말풍선으로, 펼치기 버튼으로 이름까지 보인다", async ({
    page,
  }, info) => {
    test.skip(info.project.name === "mobile", "PC 프로젝트에서 폭만 바꿔 봄");
    // WebKit은 Safari 기본 설정처럼 Tab이 링크로 가지 않음(시험 도구 차이, 화면 문제 아님)
    // 말풍선은 키보드 포커스(:focus-visible)·마우스 올림 때만 뜨므로 WebKit에서는 마우스 올림으로 같은 말풍선을 봄
    // Tab 이동과 :focus-visible은 chromium·Firefox에서 봄
    const tabsToLinks = info.project.name !== "desktop-webkit";
    const rail = page.locator("aside");
    const home = nav(page).getByRole("link", { name: "운영 홈" });
    await expect(home).toBeVisible();
    expect((await rail.boundingBox())?.width).toBe(72);
    // 키보드로 옮겨 가야 :focus-visible 이 켜짐(브랜드 → 운영 홈)
    if (tabsToLinks) {
      await rail.getByRole("link", { name: "바라던 바다 운영" }).focus();
      await page.keyboard.press("Tab");
      await expect(home).toBeFocused();
    } else {
      await home.hover();
    }
    // 말풍선은 레일(72px) 밖에 떠야 함. 스크롤 상자 안에 absolute로 두면 잘려서 안 보였음
    const tip = page.locator("[data-rail-tip]");
    await expect(tip).toHaveText("운영 홈");
    expect((await tip.boundingBox())?.x).toBeGreaterThanOrEqual(72);
    await expectNoA11yViolations(page);
    if (tabsToLinks) await page.keyboard.press("Tab");
    else await nav(page).getByRole("link", { name: "이용 통계" }).hover();
    await expect(tip).toHaveText("이용 통계");

    // 계정 아이콘도 마우스를 올리면 이름이 보임
    await rail.getByRole("button", { name: "로그아웃" }).hover();
    await expect(tip).toHaveText("로그아웃");

    await rail.getByRole("button", { name: "메뉴 펼치기" }).click();
    expect((await rail.boundingBox())?.width).toBe(220);
    await expect(
      rail.getByText("기록", { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    await expect(
      rail.getByRole("button", { name: "메뉴 접기" }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});
