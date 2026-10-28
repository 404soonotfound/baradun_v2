import type { Page } from "@playwright/test";

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

  test("공유·활동·특보 상세", async ({ page }) => {
    await page.goto(`/spots/${slugOf(WARNING_ID)}/`);
    await expect(page.getByText("풍랑주의보").first()).toBeVisible();
    await checkSheet(page, "공유", "공유하기");
    await checkSheet(page, "특보 상세 보기", "풍랑주의보");
    await checkSheet(page, "수영", "활동 고르기");
    await checkSheet(page, "자세히", "무엇을 확인했나요");
  });

  // 낮은 화면(가로 모드·작은 휴대폰)에서 내용이 스크롤되면 키보드로도 스크롤할 수 있어야 함(axe scrollable-region-focusable)
  test.describe("낮은 화면", () => {
    test.use({ viewport: { width: 390, height: 600 } });
    test("긴 시트 내용도 키보드로 닿음", async ({ page }) => {
      await page.goto(`/spots/${slugOf(WARNING_ID)}/`);
      await expect(page.getByText("풍랑주의보").first()).toBeVisible();
      await checkSheet(page, "자세히", "무엇을 확인했나요");
    });
  });

  test.describe("첫 실행 안내", () => {
    test.use({ seeded: false });
    test("포커스가 안에 있고 Esc로 건너뛰지 않음", async ({ page }) => {
      await page.goto("/");
      const confirm = page.getByRole("button", { name: "확인했어요" });
      await expect(confirm).toBeVisible();
      expect(await focusInsideOpenDialog(page)).toBe(true);
      await page.keyboard.press("Escape");
      await expect(confirm).toBeVisible();
      await expectNoA11yViolations(page);
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
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(path);
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
