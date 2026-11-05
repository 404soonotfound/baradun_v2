import type { Page, Route } from "@playwright/test";
import {
  ME_OK,
  expect,
  expectNoA11yViolations,
  isMobile,
  mockCognito,
  mockOps,
  openMenu,
  signInWithPassword,
  srpScript,
  test,
} from "./fixtures";
import { VIEW } from "./collection-data";

// 데이터 수집 현황 (BRD-149, 화면 설계서 6장 ADM-COLLECT). 운영 API는 가짜 응답

const OPS = "ops@example.test";
async function mockCollection(page: Page, status = 200) {
  let calls = 0;
  await page.route(/\/ops\/collection$/, async (route: Route) => {
    calls += 1;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(
        status === 200
          ? VIEW
          : { error: { code: "internal", requestId: "req-7f3a2c91" } },
      ),
    });
  });
  return () => calls;
}

async function openCollection(page: Page) {
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
    .getByRole("link", { name: "데이터 수집 현황" })
    .click();
  await expect(
    page.getByRole("heading", { name: "데이터 수집 현황", level: 1 }),
  ).toBeVisible();
}

// 표(태블릿·PC) 또는 카드(모바일) 중 보이는 출처 줄
const sourceRow = (page: Page, name: string) =>
  (isMobile(page)
    ? page.getByRole("region", { name: "출처별 수집" }).locator("ul > li")
    : page.locator("tbody tr")
  )
    .filter({ visible: true })
    .filter({ hasText: name });

test("출처별 상태(시안 V9·VM2): 정상·일부 실패·기록 없음을 글자로 나누고 운영 기간은 수집하지 않는다고 보여 준다", async ({
  page,
}) => {
  await mockCollection(page);
  await openCollection(page);
  await expect(sourceRow(page, "기상청 해상 특보")).toContainText("정상");
  await expect(sourceRow(page, "기상청 해상 특보")).toContainText("99.8%");
  await expect(sourceRow(page, "기상청 해양 관측")).toContainText("일부 실패");
  await expect(sourceRow(page, "국립해양조사원 이안류")).toContainText(
    "기록 없음",
  );
  // 날씨 예보(BRD-181)도 기록이 없으면 '기록 없음'(정상으로 보지 않음)
  await expect(sourceRow(page, "기상청 날씨 예보")).toContainText("기록 없음");
  await expect(sourceRow(page, "해양수산부 운영 기간")).toContainText(
    "수집하지 않음",
  );
  // 요약: 정상은 마지막 실행이 모두 성공한 출처만(해상 특보·사진)
  await expect(page.getByText("2/5", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("img", { name: "최근 24시간 96회 중 95회 성공" }),
  ).toHaveCount(1);
  await expectNoA11yViolations(page);
});

test("장애 기록: 최신 먼저, 이어지는 장애·해결, 출처 code와 모르는 사유를 숨기지 않는다", async ({
  page,
}) => {
  await mockCollection(page);
  await openCollection(page);
  const incidents = page
    .getByRole("region", { name: /장애 기록/ })
    .getByRole("listitem");
  await expect(incidents).toHaveCount(2);
  await expect(incidents.first()).toContainText(
    "기상청 해양 관측 · 기타 사유(새로운 사유)",
  );
  await expect(incidents.first()).toContainText("이어지는 중");
  await expect(incidents.nth(1)).toContainText("출처 오류 코드 22");
  await expect(incidents.nth(1)).toContainText("LIMITED NUMBER");
  await expect(incidents.nth(1)).toContainText("해결");
});

test("불러오지 못하면 앱 영향 없음과 요청 번호, 다시 시도를 보여 준다", async ({
  page,
}) => {
  const calls = await mockCollection(page, 500);
  await openCollection(page);
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "수집 현황을 불러오지 못했어요" });
  await expect(alert).toContainText("수집 현황을 불러오지 못했어요");
  await expect(alert).toContainText("앱의 수집·게시는 그대로");
  await expect(alert).toContainText("req-7f3a2c91");
  const before = calls();
  await alert.getByRole("button", { name: "다시 시도" }).click();
  await expect.poll(calls).toBe(before + 1);
});
