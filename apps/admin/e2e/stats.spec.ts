import type { Page, Route } from "@playwright/test";
import { localStatsView } from "../src/lib/auth/local-stats";
import {
  ME_OK,
  expect,
  expectNoA11yViolations,
  mockCognito,
  mockOps,
  openMenu,
  signInWithPassword,
  srpScript,
  test,
} from "./fixtures";

// 이용 통계 (BRD-154·GH-333, 화면 설계서 6장 ADM-STATS)

const OPS = "ops@example.test";

async function mockStats(
  page: Page,
  handler: (range: string) => { status?: number; body: object },
) {
  const ranges: string[] = [];
  await page.route(/\/ops\/stats(\?.*)?$/, async (route: Route) => {
    const url = new URL(route.request().url());
    const range = url.searchParams.get("range") ?? "7d";
    ranges.push(range);
    const res = handler(range);
    await route.fulfill({
      status: res.status ?? 200,
      contentType: "application/json",
      body: JSON.stringify(res.body),
    });
  });
  return ranges;
}

async function openStats(page: Page) {
  await mockCognito(
    page,
    srpScript({ email: OPS, after: "tokens", groups: ["viewer"] }),
  );
  await mockOps(page, ME_OK);
  await signInWithPassword(page, "/login/", OPS);
  await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
  await openMenu(page);
  await page
    .getByRole("navigation", { name: "운영 메뉴" })
    .filter({ visible: true })
    .getByRole("link", { name: "이용 통계" })
    .click();
  await expect(
    page.getByRole("heading", { name: "이용 통계", level: 1 }),
  ).toBeVisible();
}

const section = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

test("정상 조회: 머리 '지금 사용 중', 기본 28일, 해변 이름, 응답에 없는 값은 확인 못 함, 기간 전환", async ({
  page,
}) => {
  const ranges = await mockStats(page, (range) => ({
    body: localStatsView(
      range === "today" || range === "7d" || range === "60d" ? range : "28d",
    ),
  }));
  await openStats(page);

  await expect(page.getByText(/^지금 사용 중\s*14명\s*· 최근 30분$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "28일" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    page.getByText("Google Analytics · 비식별 이용 이벤트만 수집해요 · 최근 28일"),
  ).toBeVisible();
  // 28일 예시: 사용자 3,960 · 화면 조회 9,240 · 사용자당 2.3
  await expect(page.getByText("3,960", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("9,240", { exact: true })).toBeVisible();
  await expect(page.getByText("2.3", { exact: true })).toBeVisible();

  const beaches = section(page, "많이 본 해변");
  await expect(beaches.getByText("해운대해수욕장")).toBeVisible();
  await expect(beaches.getByText("광안리해수욕장")).toBeVisible();
  await expect(beaches.getByText("경포해수욕장")).toBeVisible();
  await expect(beaches.getByText(/\/spots\/|haeundae|gwangan-ri/)).toHaveCount(0);

  // 응답에 없는 값: 지어내지 않고 같은 자리에 확인 못 함
  await expect(page.getByText("그래프 확인 못 함")).toHaveCount(3);
  await expect(
    section(page, "많이 본 화면").getByText("확인 못 함", { exact: true }),
  ).toBeVisible();
  await expect(
    section(page, "들어온 경로").getByText("확인 못 함", { exact: true }),
  ).toBeVisible();
  await expect(section(page, "기기").getByText("모바일")).toBeVisible();
  await expect(section(page, "화면 언어").getByText("한국어")).toBeVisible();
  await expect(page.getByText(/일부 숫자 (숨김|제한)이 있어요/)).toHaveCount(0);

  await expectNoA11yViolations(page);

  await page.getByRole("button", { name: "오늘" }).click();
  await expect(
    page.getByText("Google Analytics · 비식별 이용 이벤트만 수집해요 · 오늘"),
  ).toBeVisible();
  await expect(page.locator("dl").getByText("180", { exact: true })).toBeVisible();
  expect(ranges).toEqual(["28d", "today"]);
});

test("이름표에 없는 해변은 slug·경로가 아니라 '이름 확인 못 함'", async ({
  page,
}) => {
  const base = localStatsView("28d");
  await mockStats(page, () => ({
    body: {
      ...base,
      period: {
        ...base.period,
        topBeaches: [
          { path: "/spots/gwangalli", slug: "gwangalli", pageViews: 64 },
          { path: "/spots/", slug: null, pageViews: 3 },
        ],
      },
    },
  }));
  await openStats(page);
  const beaches = section(page, "많이 본 해변");
  await expect(beaches.getByText("이름 확인 못 함")).toHaveCount(2);
  await expect(beaches.getByText(/gwangalli|\/spots/)).toHaveCount(0);
});

test("숫자 숨김 안내는 응답을 받은 뒤 metadata가 있을 때만, 빈 값(null)은 0이 아닌 확인 못 함·–", async ({
  page,
}) => {
  const base = localStatsView("28d");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/ops\/stats(\?.*)?$/, async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...base,
        cached: true,
        realtime: { status: "ok", activeUsers: null, pageViews: 10 },
        period: {
          ...base.period,
          devices: [
            { category: "mobile", activeUsers: null },
            { category: "desktop", activeUsers: 40 },
          ],
          metadata: { thresholding: true, sampling: true, otherRowLoss: false },
        },
      }),
    });
  });
  await openStats(page);
  // 응답 전: 자리표시만, 숨김 안내 자리는 두지 않음(L7). 차트 자리는 그대로
  await expect(page.locator("#main .sk").first()).toBeVisible();
  await expect(page.getByText(/일부 숫자 숨김이 있어요/)).toHaveCount(0);
  await expect(page.getByText("그래프 확인 못 함")).toHaveCount(3);
  release();

  await expect(page.getByText("잠시 저장된 응답")).toBeVisible();
  const notice = page
    .getByRole("status")
    .filter({ hasText: "이 기간 결과에 일부 숫자 숨김이 있어요." });
  await expect(notice).toBeVisible();
  await expect(notice.getByText(/GA가 가렸어요/)).toBeVisible();
  await expect(notice.getByText(/표본으로 계산/)).toBeVisible();
  await expect(notice.getByText(/'기타'로 묶였어요/)).toHaveCount(0);
  // 지금 사용 중 숫자가 비면 확인 못 함
  await expect(page.getByText("확인 못 함", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("0명")).toHaveCount(0);
  // 기기 합을 알 수 없으면 비율·합계를 추정하지 않음
  await expect(section(page, "기기").getByText("–").first()).toBeVisible();
  await expectNoA11yViolations(page);
});

test("GA4 미연결(configured: false)과 조회 실패(500) 뒤 같은 자리에서 다시 시도", async ({
  page,
}) => {
  await mockStats(page, () => ({
    body: { ...localStatsView("28d"), configured: false },
  }));
  await openStats(page);
  await expect(
    page.getByText("GA4 연동이 아직 설정되지 않았어요"),
  ).toBeVisible();
  await expectNoA11yViolations(page);

  await page.unroute(/\/ops\/stats(\?.*)?$/);
  await mockStats(page, () => ({
    status: 500,
    body: { error: { code: "internal", requestId: "req-1" } },
  }));
  await page.getByRole("button", { name: "새로 고침" }).click();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "이용 통계를 불러오지 못했어요." });
  await expect(alert).toBeVisible();
  await expect(alert.getByText("오류 번호 req-1")).toBeVisible();

  await page.unroute(/\/ops\/stats(\?.*)?$/);
  await mockStats(page, () => ({ body: localStatsView("28d") }));
  await alert.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByText("14명", { exact: true })).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test("새로 고침하는 동안 받은 값을 두고 회전 표시, 응답이 15초 넘게 없으면 같은 자리에서 실패", async ({
  page,
}) => {
  await page.clock.install();
  await mockStats(page, () => ({ body: localStatsView("28d") }));
  await openStats(page);
  await expect(page.getByText("14명", { exact: true })).toBeVisible();

  await page.unroute(/\/ops\/stats(\?.*)?$/);
  await page.route(/\/ops\/stats(\?.*)?$/, () => new Promise<void>(() => {}));
  await page.getByRole("button", { name: "새로 고침" }).click();
  await expect(page.getByText("다시 읽는 중")).toBeVisible();
  // 값 유지(자리표시로 바꾸지 않음)
  await expect(page.getByText("14명", { exact: true })).toBeVisible();
  await expect(section(page, "많이 본 해변").getByText("해운대해수욕장")).toBeVisible();

  // 기간을 바꾸면 다른 기간 값이라 자리표시, 15초 뒤 같은 자리 실패
  await page.getByRole("button", { name: "7일" }).click();
  await expect(page.getByText("14명", { exact: true })).toHaveCount(0);
  await page.clock.fastForward(16_000);
  await expect(
    page.getByRole("alert").filter({ hasText: "이용 통계를 불러오지 못했어요." }),
  ).toBeVisible();
});

test("예시 데이터 배지와 세부 리포트 일부 실패(null) 구분 표시", async ({
  page,
}) => {
  const base = localStatsView("28d");
  await mockStats(page, () => ({
    body: {
      ...base,
      sample: true,
      period: {
        ...base.period,
        topBeaches: null,
      },
    },
  }));
  await openStats(page);

  await expect(page.getByText("예시 데이터")).toBeVisible();
  await expect(
    section(page, "많이 본 해변").getByText(
      "이 항목을 불러오지 못했어요. 다른 칸은 그대로예요. 잠시 뒤 다시 시도해 주세요.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("집계된 해변 방문 기록이 없어요."),
  ).toHaveCount(0);
  await expectNoA11yViolations(page);
});
