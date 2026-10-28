import type { Page } from "@playwright/test";

import {
  CLEAR_ID,
  DELAYED_ID,
  expect,
  expectNoA11yViolations,
  slugOf,
  test,
  WARNING_ID,
} from "./fixtures";

// 상태별 핵심 흐름 (BRD-39 · 노션 9.1 '실패 경로', 리뷰 점검표 3·4·5)
const FINAL_CALL = "최종 판단은 현장 통제와 안전요원 안내가 우선이에요";
const CONFIRMED = /기상청 \d{1,2}:\d{2} 확인/;

// 화면에 보이는 '특보 없음' 배지 개수
function clearBadges(page: Page) {
  return page.getByText("특보 없음", { exact: true }).filter({ visible: true });
}

// '특보 없음'이 보이는 모든 자리에 범위·기상청·확인 시각과 현장 우선 문구가 붙는지(점검표 5)
// 배지에서 바깥으로 올라가며 '기상청 HH:MM 확인'이 든 가장 가까운 묶음을 찾고, 그 묶음이 든 구역에 현장 우선 문구가 있는지 봄
async function clearPlacesWithoutBasis(page: Page) {
  return page.evaluate(
    ({ finalCall, confirmed }) => {
      const pattern = new RegExp(confirmed);
      const missing: string[] = [];
      const badges = [...document.querySelectorAll("main *")].filter(
        // 글자가 '특보 없음'인 가장 안쪽 요소(아이콘이 든 배지 포함)
        (element) =>
          element.textContent?.trim() === "특보 없음" &&
          ![...element.children].some(
            (child) => child.textContent?.trim() === "특보 없음",
          ) &&
          (element as HTMLElement).offsetParent !== null,
      );
      for (const badge of badges) {
        let box: Element | null = badge;
        let depth = 0;
        while (box && depth < 8 && !pattern.test(box.textContent ?? "")) {
          box = box.parentElement;
          depth += 1;
        }
        const scopeOk =
          box !== null &&
          depth < 8 &&
          (box.textContent ?? "").includes("특보구역");
        const section = box?.closest("section, [role='region'], main");
        const finalOk = (section?.textContent ?? "").includes(finalCall);
        if (!scopeOk || !finalOk) {
          missing.push(
            (box ?? badge).textContent?.trim().slice(0, 80) ?? "(빈 자리)",
          );
        }
      }
      return { count: badges.length, missing };
    },
    { finalCall: FINAL_CALL, confirmed: CONFIRMED.source },
  );
}

test.describe("정상", () => {
  for (const url of ["/", "/explore/", `/spots/${slugOf(CLEAR_ID)}/`]) {
    test(`'특보 없음' 자리마다 근거와 현장 우선 문구 ${url}`, async ({
      page,
    }) => {
      await page.goto(url);
      await expect(clearBadges(page).first()).toBeVisible();
      const result = await clearPlacesWithoutBasis(page);
      expect(result.count).toBeGreaterThan(0);
      expect(result.missing).toEqual([]);
    });
  }

  test("이용불가는 실제 사유(풍랑주의보)를 먼저 보여줌", async ({ page }) => {
    await page.goto(`/spots/${slugOf(WARNING_ID)}/`);
    await expect(
      page.getByRole("heading", { name: "풍랑주의보가 발효 중이에요" }),
    ).toBeVisible();
    await expect(page.getByText(FINAL_CALL).first()).toBeVisible();
  });

  test("관측 지연이면 지난 파고 값을 숨기고 지연이라고 알림", async ({
    page,
  }) => {
    await page.goto(`/spots/${slugOf(DELAYED_ID)}/`);
    await expect(page.getByText("관측 지연").first()).toBeVisible();
    await expect(
      page.getByText("파고 측정이 늦어지고 있어요").first(),
    ).toBeVisible();
    // 게시된 지연 값(0.9m)은 보이지 않아야 함('가까운 특보 없는 해변' 대안의 '특보 없음'은 다른 해변이라 따로 봄)
    await expect(page.getByText(/0\.9\s*m/)).toHaveCount(0);
  });
});

test.describe("로딩", () => {
  test.use({ scenario: "loading" });
  test("응답을 기다리는 동안 '특보 없음'을 보여주지 않음", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByText("해변 상태를 불러오고 있어요").first(),
    ).toBeVisible();
    await expect(clearBadges(page)).toHaveCount(0);
    await expectNoA11yViolations(page);
  });
});

test.describe("데이터 없음", () => {
  test.use({ scenario: "noData" });
  test("처음 열 때 못 받으면 확인 못 함·다시 시도, 다시 받으면 정상으로", async ({
    page,
    data,
  }) => {
    await page.goto("/");
    await expect(page.getByText("새 정보를 불러오지 못했어요")).toBeVisible();
    await expect(page.getByText("아직 받은 정보가 없어요")).toBeVisible();
    await expect(clearBadges(page)).toHaveCount(0);
    await expectNoA11yViolations(page);

    // 실패 뒤 다시 시도하면 새로 받음(점검표 1)
    data.set("normal");
    await page.getByRole("button", { name: "다시 시도" }).click();
    await expect(clearBadges(page).first()).toBeVisible();
    await expect(page.getByText("새 정보를 불러오지 못했어요")).toHaveCount(0);
  });

  test("탐색·상세도 '특보 없음'으로 보이지 않음", async ({ page }) => {
    for (const url of ["/explore/", `/spots/${slugOf(CLEAR_ID)}/`]) {
      await page.goto(url);
      await expect(
        page.getByText("새 정보를 불러오지 못했어요").first(),
      ).toBeVisible();
      await expect(clearBadges(page)).toHaveCount(0);
    }
  });
});

test.describe("전체 장애", () => {
  test.use({ scenario: "outage" });
  test("모든 해변이 특보 확인 못 함이면 장애 안내", async ({ page }) => {
    for (const url of ["/", "/explore/", `/spots/${slugOf(CLEAR_ID)}/`]) {
      await page.goto(url);
      await expect(
        page.getByText("판단에 쓰는 공식 정보를 받지 못하고 있어요").first(),
      ).toBeVisible();
      await expect(clearBadges(page)).toHaveCount(0);
    }
    await expectNoA11yViolations(page);
  });
});

// 믿을 수 없는 응답은 정상이나 '특보 없음'으로 보이지 않음(점검표 3)
for (const scenario of ["futureConfirm", "missingWarning"] as const) {
  test.describe(scenario, () => {
    test.use({ scenario });
    test("'특보 없음'을 보여주지 않음", async ({ page }) => {
      for (const url of ["/", `/spots/${slugOf(CLEAR_ID)}/`]) {
        await page.goto(url);
        await expect(page.getByText("확인 못 함").first()).toBeVisible();
        await expect(clearBadges(page)).toHaveCount(0);
      }
    });
  });
}

test.describe("오프라인", () => {
  test("연결이 끊기면 안내하고 '특보 없음'을 확인 못 함으로 내림, 발효 특보는 유지", async ({
    page,
    context,
    data,
  }) => {
    await page.goto(`/spots/${slugOf(WARNING_ID)}/`);
    await expect(
      page.getByRole("heading", { name: "풍랑주의보가 발효 중이에요" }),
    ).toBeVisible();
    // 가짜 응답은 오프라인에서도 응답하므로 데이터도 함께 끊음
    data.set("noData");
    await context.setOffline(true);
    await expect(
      page.getByText("인터넷에 연결되어 있지 않아요").first(),
    ).toBeVisible();
    // B5: 발효 중 특보 배지는 남음
    await expect(page.getByText("풍랑주의보").first()).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("홈: 끊긴 동안 '특보 없음'을 보여주지 않음", async ({
    page,
    context,
    data,
  }) => {
    await page.goto("/");
    await expect(clearBadges(page).first()).toBeVisible();
    data.set("noData");
    await context.setOffline(true);
    await expect(
      page.getByText("인터넷에 연결되어 있지 않아요").first(),
    ).toBeVisible();
    await expect(clearBadges(page)).toHaveCount(0);
  });
});

// 점검·강제 업데이트: 화면 전체를 덮고 지난 값을 숨김(점검표 4)
for (const [scenario, title] of [
  ["maintenance", "지금은 점검 중이에요"],
  ["update", "새 버전으로 업데이트해 주세요"],
] as const) {
  test.describe(scenario, () => {
    test(`${title} · 지난 값 숨김 · Esc로 닫히지 않음`, async ({
      page,
      data,
    }) => {
      // 먼저 정상 값을 받아 기기에 저장해 둠
      await page.goto(`/spots/${slugOf(CLEAR_ID)}/`);
      await expect(clearBadges(page).first()).toBeVisible();

      data.set(scenario);
      await page.reload();
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      // 덮인 뒤 화면에도 지난 값·'특보 없음'이 남지 않음
      const hidden = await page.evaluate(() => {
        const text = document.querySelector("main")?.textContent ?? "";
        return {
          clear: text.includes("특보 없음"),
          value: /0\.6\s*m/.test(text),
        };
      });
      expect(hidden).toEqual({ clear: false, value: false });
      await expectNoA11yViolations(page);
    });
  });
}

test.describe("404", () => {
  test("없는 주소는 404와 홈으로 가는 길", async ({ page }) => {
    for (const url of ["/no-such-page/", "/spots/no-such-beach/"]) {
      const response = await page.goto(url);
      expect(response?.status()).toBe(404);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("link").first()).toBeVisible();
    }
  });
});
