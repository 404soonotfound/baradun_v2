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

// 운영자 문의 목록·상세 (BRD-153, 화면 설계서 6장 ADM-INQ). 운영 API는 가짜 응답

const OPS = "ops@example.test";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const RECEIVED = "2026-11-02T04:12:00Z"; // KST 11/2 13:12

const summary = (n: number, overrides: Record<string, unknown> = {}) => ({
  inquiryId: id(n),
  type: "data_error",
  beachId: "b0001",
  activity: "swimming",
  receivedAt: RECEIVED,
  status: "received",
  version: 1,
  legacy: false,
  ...overrides,
});

const COUNTS = { received: 2, in_progress: 1, resolved: 0, rejected: 0 };

interface Calls {
  list: URLSearchParams[];
}

async function mockInquiries(
  page: Page,
  options: {
    detail?: (inquiryId: string) => { status: number; body: unknown };
    listStatus?: number;
  } = {},
): Promise<Calls> {
  const calls: Calls = { list: [] };
  await page.route(/\/ops\/inquiries(\?.*)?$/, async (route: Route) => {
    const url = new URL(route.request().url());
    calls.list.push(url.searchParams);
    if (options.listStatus) {
      await route.fulfill({
        status: options.listStatus,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "internal", requestId: "req-7f3a2c91" },
        }),
      });
      return;
    }
    const cursor = url.searchParams.get("cursor");
    const status = url.searchParams.get("status");
    const all = [
      summary(1),
      summary(2, {
        type: "beach_request",
        beachId: "b9999",
        activity: "scuba",
      }),
      summary(3, {
        type: "data_question",
        status: "in_progress",
        beachId: undefined,
        activity: undefined,
      }),
    ];
    const items = cursor
      ? [summary(4, { type: "data_suggestion" })]
      : all.filter((i) => !status || i.status === status);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items,
        nextCursor: cursor || status ? null : "c1",
        ...(cursor ? {} : { counts: COUNTS }),
      }),
    });
  });
  await page.route(/\/ops\/inquiries\/[^/?]+$/, async (route: Route) => {
    const inquiryId = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").pop()!,
    );
    const reply = options.detail?.(inquiryId) ?? {
      status: 200,
      body: {
        ...summary(1),
        restricted: false,
        message: "현장에 입수 금지 깃발이 걸려 있어요.",
        memo: null,
        rejectReason: null,
        emailCollected: false,
        photosCollected: false,
      },
    };
    await route.fulfill({
      status: reply.status,
      contentType: "application/json",
      body: JSON.stringify(reply.body),
    });
  });
  return calls;
}

async function openInquiries(page: Page) {
  await openMenu(page);
  await page
    .getByRole("navigation", { name: "운영 메뉴" })
    .filter({ visible: true })
    .getByRole("link", { name: "문의" })
    .click();
  await expect(
    page.getByRole("heading", { name: "문의", level: 1 }),
  ).toBeVisible();
}

async function signIn(page: Page, groups = ["editor"]) {
  await mockCognito(page, srpScript({ email: OPS, after: "tokens", groups }));
  await mockOps(page, ME_OK);
  await signInWithPassword(page, "/login/", OPS);
  await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
}

const rows = (page: Page) =>
  isMobile(page)
    ? page.locator("ul li").filter({ visible: true })
    : page.locator("tbody tr");

test("목록: 상태 탭에 수, 해변 이름·활동, 없는 해변 ID도 숨기지 않고, 쪽을 넘긴다", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockInquiries(page);
  await openInquiries(page);

  const tabs = page.getByRole("group", { name: "처리 상태로 거르기" });
  await expect(tabs.getByRole("button", { name: "접수 2" })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "전체 3" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(rows(page)).toHaveCount(3);
  await expect(rows(page).first()).toContainText("정보가 실제와 달라요");
  await expect(rows(page).first()).toContainText("강문해수욕장 · 수영");
  await expect(rows(page).first()).toContainText("11/2 13:12");
  await expect(rows(page).nth(1)).toContainText("해변 목록에 없는 ID b9999");
  await expect(rows(page).nth(2)).toContainText("고르지 않음");
  await expect(page.getByText("3건 중 1–3")).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByRole("button", { name: "다음" }).click();
  await expect(rows(page)).toHaveCount(1);
  expect(calls.list.at(-1)?.get("cursor")).toBe("c1");
  // 탭 수는 첫 쪽에서 받은 값을 그대로 둠
  await expect(tabs.getByRole("button", { name: "접수 2" })).toBeVisible();
  await page.getByRole("button", { name: "이전" }).click();
  await expect(rows(page)).toHaveCount(3);

  await tabs.getByRole("button", { name: "확인 중 1" }).click();
  await expect(rows(page)).toHaveCount(1);
  expect(calls.list.at(-1)?.get("status")).toBe("in_progress");
  expect(calls.list.at(-1)?.get("cursor")).toBeNull();
});

test("상세: 내용·보관 기한·받지 않는 연락처를 보여 주고, PC는 옆 시트(Esc로 닫음), 모바일은 목록 대신 상세", async ({
  page,
}) => {
  await signIn(page);
  await mockInquiries(page);
  await openInquiries(page);
  await rows(page).first().getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`\\?id=${id(1)}$`));
  const detail = page.getByRole("complementary", { name: "문의 상세" });
  await expect(
    detail.getByText("현장에 입수 금지 깃발이 걸려 있어요."),
  ).toBeVisible();
  await expect(detail.getByText("받지 않아요")).toBeVisible();
  // 받은 시각 + 90일(KST) = 1/31
  await expect(detail.getByText("1/31에 자동 삭제")).toBeVisible();
  await expect(detail.getByText("강원 강릉시")).toBeVisible();
  await expectNoA11yViolations(page);

  if (isMobile(page)) {
    await expect(
      page.getByRole("heading", { name: "문의", level: 1 }),
    ).toBeHidden();
    await detail.getByRole("link", { name: /문의 목록으로/ }).click();
  } else {
    await expect(
      page.getByRole("heading", { name: "문의", level: 1 }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
  }
  await expect(page).toHaveURL(/\/inquiries\/$/);
  await expect(detail).toBeHidden();
});

test("보기 권한은 내용·메모를 받지 않음을 알리고, 이전 문의 표시를 보여 준다", async ({
  page,
}) => {
  await signIn(page, ["viewer"]);
  await mockInquiries(page, {
    detail: () => ({
      status: 200,
      body: {
        ...summary(1, { legacy: true }),
        restricted: true,
        emailCollected: false,
        photosCollected: false,
      },
    }),
  });
  await openInquiries(page);
  await rows(page).first().getByRole("link").click();
  const detail = page.getByRole("complementary", { name: "문의 상세" });
  await expect(detail.getByText(/보기 권한으로는 문의 내용/)).toBeVisible();
  await expect(detail.getByText("이전 문의 · 처리 이력 없음")).toBeVisible();
  await expect(detail.getByText("처리 메모(내부용)")).toHaveCount(0);
});

test("주소로 연 문의가 없으면(90일 지남) 찾는 문의가 없다고 알린다", async ({
  page,
}) => {
  await signIn(page);
  await mockInquiries(page, {
    detail: () => ({
      status: 404,
      body: { error: { code: "not_found", requestId: "req-1" } },
    }),
  });
  await openInquiries(page);
  await rows(page).first().getByRole("link").click();
  await expect(page.getByText("찾는 문의가 없어요")).toBeVisible();
  await page.getByRole("button", { name: "문의 목록으로" }).click();
  await expect(page).toHaveURL(/\/inquiries\/$/);
});

test("목록을 불러오지 못하면 영향·오류 번호·다시 시도를 보여 주고 빈 목록으로 꾸미지 않는다", async ({
  page,
}) => {
  await signIn(page);
  await mockInquiries(page, { listStatus: 500 });
  await openInquiries(page);
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "문의 목록을 불러오지 못했어요" });
  await expect(alert).toContainText("앱 사용자 화면에는 영향이 없어요");
  await expect(alert).toContainText("오류 번호 req-7f3a2c91");
  await expect(page.getByText("문의가 없어요")).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test("모르는 처리 상태·유형은 숨기지 않고 그 값을 그대로 보여 준다", async ({
  page,
}) => {
  await signIn(page);
  await mockInquiries(page);
  // 나중에 건 route가 먼저 받음
  await page.route(/\/ops\/inquiries(\?.*)?$/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: [summary(9, { status: "archived", type: "new_kind" })],
        nextCursor: null,
        counts: COUNTS,
      }),
    }),
  );
  await openInquiries(page);
  await expect(rows(page).first()).toContainText("알 수 없는 상태(archived)");
  await expect(rows(page).first()).toContainText("알 수 없는 유형(new_kind)");
});
