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

test("정상 조회·기간 전환·해변 이름 매핑·수집 이벤트 및 제한 안내 숨김(E8)", async ({
  page,
}) => {
  const ranges = await mockStats(page, (range) => ({
    body: localStatsView(range === "today" || range === "28d" || range === "60d" ? range : "7d"),
  }));
  await openStats(page);

  await expect(page.getByText("지금 사용 중 (최근 30분)")).toBeVisible();
  await expect(page.getByText("14명")).toBeVisible();
  await expect(page.getByText("해운대해수욕장")).toBeVisible();
  await expect(page.getByText("부산 해운대구")).toBeVisible();
  await expect(page.getByText("수집 중")).toBeVisible();
  await expect(page.getByText("수집 안 함(후속)").first()).toBeVisible();
  await expect(
    page.getByText("일부 숫자가 가려졌거나 요약되었어요"),
  ).toHaveCount(0);

  await expectNoA11yViolations(page);

  await page.getByRole("button", { name: "오늘" }).click();
  await expect(page.getByText("기간 요약 (오늘)")).toBeVisible();
  await expect(page.getByText("180명")).toBeVisible();
  expect(ranges).toEqual(["7d", "today"]);
});

test("metadata 제한 안내가 있을 때만 표시되고 빈 값(null)은 0이 아닌 –로 표시(E8)", async ({
  page,
}) => {
  const base = localStatsView("7d");
  await mockStats(page, () => ({
    body: {
      ...base,
      cached: true,
      realtime: { status: "ok", activeUsers: null, pageViews: 10 },
      period: {
        ...base.period,
        metadata: { thresholding: true, sampling: true, otherRowLoss: false },
      },
    },
  }));
  await openStats(page);

  await expect(page.getByText("잠시 저장된 응답")).toBeVisible();
  await expect(
    page.getByText("일부 숫자가 가려졌거나 요약되었어요"),
  ).toBeVisible();
  await expect(page.getByText(/thresholding/)).toBeVisible();
  await expect(page.getByText(/sampling/)).toBeVisible();
  await expect(
    page.getByRole("region", { name: "지금 사용 중 (최근 30분)" }),
  ).toContainText("–");
  await expectNoA11yViolations(page);
});

test("GA4 미연결(configured: false)과 조회 실패(500) 안내", async ({ page }) => {
  await mockStats(page, () => ({
    body: { ...localStatsView("7d"), configured: false },
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
  await expect(page.getByText("이용 통계를 불러오지 못했어요.")).toBeVisible();
});

test("예시 데이터 배지와 세부 리포트 일부 실패(null) 구분 표시", async ({
  page,
}) => {
  const base = localStatsView("7d");
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
    page.getByText(
      "이 항목을 불러오지 못했어요. 일부 집계가 비어 있으니 잠시 뒤 새로 고침해 주세요.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("집계된 해변 방문 기록이 없어요."),
  ).toHaveCount(0);
  await expectNoA11yViolations(page);
});
