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

// 운영자 변경 이력 (BRD-155, 화면 설계서 6장 ADM-AUD). 운영 API는 가짜 응답

const OPS = "ops@example.test";
const SUB_A = "aaaaaaaa-1111-4222-8333-444444444444";
const SUB_B = "bbbbbbbb-1111-4222-8333-444444444444";
const INQUIRY = "3f2a0000-0000-4000-8000-00000000009c";

const entry = (n: number, overrides: Record<string, unknown> = {}) => ({
  at: new Date(Date.now() - n * 3_600_000).toISOString(),
  actorSub: SUB_A,
  actorKind: "operator",
  role: "publisher",
  action: "notice.update",
  target: { kind: "notice", id: "n-maintenance" },
  changes: ["title", "body"],
  requestId: `req-${n}`,
  ...overrides,
});

const PAGE_1 = [
  entry(1),
  entry(2, {
    actorSub: SUB_B,
    role: "editor",
    action: "inquiry.update",
    target: { kind: "inquiry", id: INQUIRY },
    changes: ["status", "memo"],
    statusFrom: "received",
    statusTo: "in_progress",
  }),
  entry(3, { action: "brand.new", changes: [] }),
];

async function mockAudit(
  page: Page,
  options: { status?: number } = {},
): Promise<URLSearchParams[]> {
  const calls: URLSearchParams[] = [];
  await page.route(/\/ops\/audit(\?.*)?$/, async (route: Route) => {
    const params = new URL(route.request().url()).searchParams;
    calls.push(params);
    if (options.status) {
      await route.fulfill({
        status: options.status,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "internal", requestId: "req-7f3a2c91" },
        }),
      });
      return;
    }
    const cursor = params.get("cursor");
    const actor = params.get("actor");
    const items = cursor
      ? [entry(30, { action: "notice.delete", changes: ["deletedAt"] })]
      : PAGE_1.filter((e) => !actor || e.actorSub === actor);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        filter: {
          from: params.get("from"),
          to: params.get("to"),
        },
        items,
        nextCursor: cursor || actor ? null : "c1",
      }),
    });
  });
  return calls;
}

async function signIn(page: Page, groups = ["viewer"]) {
  await mockCognito(page, srpScript({ email: OPS, after: "tokens", groups }));
  await mockOps(page, ME_OK);
  await signInWithPassword(page, "/login/", OPS);
  await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
}

async function openAudit(page: Page) {
  await openMenu(page);
  await page
    .getByRole("navigation", { name: "운영 메뉴" })
    .filter({ visible: true })
    .getByRole("link", { name: "변경 이력" })
    .click();
  await expect(
    page.getByRole("heading", { name: "변경 이력", level: 1 }),
  ).toBeVisible();
}

// 표(태블릿·PC) 또는 카드(모바일) 중 보이는 것
const records = (page: Page) =>
  isMobile(page)
    ? page
        .locator("li")
        .filter({ visible: true, hasText: /공지|문의|알 수 없는/ })
    : page.locator("tbody tr");

test("목록: 종류·대상·바뀐 항목 이름·상태 앞뒤만 보이고, 모르는 종류도 숨기지 않으며, 기간을 UTC로 보낸다", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockAudit(page);
  await openAudit(page);
  await expect(records(page)).toHaveCount(3);
  const inquiry = records(page).filter({ hasText: "문의 처리" });
  await expect(inquiry).toContainText("처리 상태 · 처리 메모");
  await expect(inquiry).toContainText("접수 → 확인 중");
  await expect(inquiry).toContainText("편집");
  await expect(
    records(page).filter({ hasText: "알 수 없는 종류(brand.new)" }),
  ).toHaveCount(1);
  const first = calls[0]!;
  expect(first.get("from")).toMatch(/Z$/);
  expect(first.get("to")).toMatch(/Z$/);
  expect(Date.parse(first.get("to")!) - Date.parse(first.get("from")!)).toBe(
    30 * 86_400_000,
  );
  await expectNoA11yViolations(page);

  // 대상을 누르면 그 문의 화면으로
  await inquiry.getByRole("link", { name: /문의 3f2a/ }).click();
  await expect(page).toHaveURL(new RegExp(`/inquiries/\\?id=${INQUIRY}$`));
});

test("거르기: 종류·기간을 바꾸면 첫 쪽부터 다시 받고, 운영자를 누르면 그 운영자 기록만", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockAudit(page);
  await openAudit(page);
  await page.getByLabel("종류").selectOption("notice.delete");
  await expect.poll(() => calls.at(-1)?.get("action")).toBe("notice.delete");
  await page.getByLabel("기간").selectOption("7");
  await expect
    .poll(() => {
      const last = calls.at(-1)!;
      return Date.parse(last.get("to")!) - Date.parse(last.get("from")!);
    })
    .toBe(7 * 86_400_000);
  await page.getByLabel("종류").selectOption("");
  await records(page)
    .filter({ hasText: "문의 처리" })
    .getByRole("button", { name: /이 운영자 기록만 보기/ })
    .click();
  await expect.poll(() => calls.at(-1)?.get("actor")).toBe(SUB_B);
  await expect(records(page)).toHaveCount(1);
  await expect(page.getByText("운영자 bbbbbbbb…의 기록만")).toBeVisible();
  await page.getByRole("button", { name: "운영자 거르기 풀기" }).click();
  await expect(records(page)).toHaveCount(3);
});

test("더 보기는 cursor만 보내 이어 붙이고, 끝나면 모두 봤다고 알린다", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockAudit(page);
  await openAudit(page);
  await page.getByRole("button", { name: "더 보기" }).click();
  await expect(records(page)).toHaveCount(4);
  const last = calls.at(-1)!;
  expect([...last.keys()]).toEqual(["cursor"]);
  await expect(page.getByText("이 기간의 기록을 모두 봤어요.")).toBeVisible();
});

test("불러오지 못하면 영향·오류 번호·다시 시도를 보여 주고 빈 목록으로 꾸미지 않는다", async ({
  page,
}) => {
  await signIn(page);
  await mockAudit(page, { status: 500 });
  await openAudit(page);
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "변경 이력을 불러오지 못했어요" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("앱 사용자 화면에는 영향이 없어요");
  await expect(alert).toContainText("req-7f3a2c91");
  await expect(page.getByText("이 기간에 기록이 없어요")).toHaveCount(0);
});

test("데모 계정은 변경 이력을 요청하지 않고 볼 수 없다고 안내한다", async ({
  page,
}) => {
  await mockCognito(
    page,
    srpScript({ email: OPS, after: "tokens", groups: ["sample"] }),
  );
  await mockOps(page, {
    status: 200,
    body: {
      kind: "sample",
      role: "sample",
      authTime: "",
      sessionExpiresAt: "",
    },
  });
  const calls = await mockAudit(page);
  await signInWithPassword(page, "/login/demo/", OPS);
  await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
  await openAudit(page);
  await expect(
    page.getByText("데모 계정은 변경 이력을 볼 수 없어요."),
  ).toBeVisible();
  expect(calls).toHaveLength(0);
});
