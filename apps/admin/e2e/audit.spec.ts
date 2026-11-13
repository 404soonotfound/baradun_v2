import type { Page, Route } from "@playwright/test";
import {
  ME_OK,
  expect,
  expectNoA11yViolations,
  expectHomeLoaded,
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
  targetLabel: "11/5 점검 예고",
  changes: ["title"],
  notice: {
    before: NOTICE,
    after: {
      ...NOTICE,
      title: { ko: "11/5(수) 02:00~04:30 점검해요", en: "Maintenance" },
    },
  },
  requestId: `req-a91f${n}`,
  ...overrides,
});

const NOTICE = {
  kind: "maintenance_notice",
  title: { ko: "11/5(수) 02:00~04:00 점검해요", en: "" },
  body: { ko: "점검 중에는 해변 정보를 볼 수 없어요.", en: "" },
  startsAt: "2026-11-04T00:00:00Z",
  endsAt: "2026-11-04T17:00:00Z",
};

const PAGE_1 = [
  entry(1),
  entry(2, {
    actorSub: SUB_B,
    role: "editor",
    action: "inquiry.update",
    target: { kind: "inquiry", id: INQUIRY },
    targetLabel: undefined,
    notice: undefined,
    changes: ["status", "memo"],
    statusFrom: "received",
    statusTo: "in_progress",
  }),
  entry(3, {
    action: "brand.new",
    target: { kind: "notice", id: "n-other" },
    targetLabel: "데이터 출처 안내",
    changes: ["something"],
    notice: undefined,
  }),
];

const COUNTS = {
  all: 3,
  notice: 1,
  beach: 0,
  publish: 0,
  inquiry: 1,
  permission: 0,
  login: 0,
};

async function mockAudit(
  page: Page,
  options: { status?: number; items?: unknown[] } = {},
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
    const items =
      options.items ??
      (cursor
        ? [entry(30, { action: "notice.delete", changes: ["deletedAt"] })]
        : PAGE_1.filter((e) => !actor || e.actorSub === actor));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        filter: { from: params.get("from"), to: params.get("to") },
        items,
        nextCursor: cursor || actor ? null : "c1",
        ...(cursor ? {} : { counts: { ...COUNTS, all: 4 } }),
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
  await expectHomeLoaded(page);
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
    ? page.locator("section li").filter({ visible: true })
    : page.locator("tbody tr").filter({ has: page.locator("td >> nth=5") });

test("목록(시안 V23): 분류 탭 수, 종류 배지·대상·바뀐 내용 요약·바뀐 곳, 기본 기간 7일을 UTC로 보낸다", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockAudit(page);
  await openAudit(page);
  const tabs = page.getByRole("group", { name: "분류로 거르기" });
  for (const name of [
    "전체 4",
    "공지 1",
    "해변 0",
    "게시 0",
    "문의 1",
    "권한 0",
    "로그인 0",
  ]) {
    await expect(tabs.getByRole("button", { name })).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "기간: 최근 7일" }),
  ).toBeVisible();
  await expect(records(page)).toHaveCount(3);
  const notice = records(page).filter({ hasText: "11/5 점검 예고" });
  await expect(notice).toContainText("공지");
  await expect(notice).toContainText("문구 수정 · 영어 문구 추가");
  const inquiry = records(page).filter({ hasText: "접수 → 확인 중" });
  await expect(inquiry).toContainText("문의");
  await expect(inquiry).toContainText("메모 수정");
  // 모르는 종류도 숨기지 않고 바뀐 항목 이름으로
  await expect(records(page).filter({ hasText: "something 바뀜" })).toHaveCount(
    1,
  );
  if (!isMobile(page)) {
    await expect(notice).toContainText("운영자 aaaa");
    await expect(notice).toContainText("운영자 화면");
  }
  await expect(page.getByText("최근 7일 4건 중 1–3")).toBeVisible();
  const first = calls[0]!;
  expect(Date.parse(first.get("to")!) - Date.parse(first.get("from")!)).toBe(
    7 * 86_400_000,
  );
  expect(first.get("to")).toMatch(/Z$/);
  await expectNoA11yViolations(page);

  await inquiry.getByRole("link", { name: /3f2a/ }).click();
  await expect(page).toHaveURL(new RegExp(`/inquiries/\\?id=${INQUIRY}$`));
});

test("공지 줄을 누르면 문구 앞·뒤를 줄 번호와 뺀 줄·더한 줄로 펼친다(PC)", async ({
  page,
}) => {
  test.skip(isMobile(page), "펼치기는 PC 표");
  await signIn(page);
  await mockAudit(page);
  await openAudit(page);
  const toggle = page.getByRole("button", {
    name: "문구 수정 · 영어 문구 추가",
  });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const diff = page.getByRole("group", { name: "공지 문구 바뀐 내용" });
  await expect(diff).toContainText("notices/n-maintenance");
  await expect(diff).toContainText("+2");
  await expect(diff).toContainText("−2");
  await expect(diff).toContainText(
    "뺌: title.ko: 11/5(수) 02:00~04:00 점검해요",
  );
  await expect(diff).toContainText(
    "더함: title.ko: 11/5(수) 02:00~04:30 점검해요",
  );
  await expect(diff).toContainText("뺌: title.en: (없음)");
  await expect(diff).toContainText("더함: title.en: Maintenance");
  await expect(diff).toContainText("kind: 점검 예고");
  await expect(diff).toContainText("placement: 홈 상단 배너");
  await expectNoA11yViolations(page);
  await toggle.click();
  await expect(diff).toHaveCount(0);

  // 키보드 Enter·Space로 펼침/접힘 전환
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(diff).toBeVisible();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(diff).toHaveCount(0);
});

test("거르기: 탭은 분류, 찾기는 대상·내용, +운영자·+기간 칩으로 다시 받는다", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockAudit(page);
  await openAudit(page);
  await expect(records(page)).toHaveCount(3);
  const tabs = page.getByRole("group", { name: "분류로 거르기" });
  await tabs.getByRole("button", { name: /^문의/ }).click();
  await expect.poll(() => calls.at(-1)?.get("category")).toBe("inquiry");
  // 분류만 바꾸면 기간은 그대로, 탭 수는 다시 세지 않고(counts=0) 계속 보임
  expect(calls.at(-1)?.get("counts")).toBe("0");
  expect(calls.at(-1)?.get("to")).toBe(calls[0]?.get("to"));
  await expect(tabs.getByRole("button", { name: "전체 4" })).toBeVisible();
  await tabs.getByRole("button", { name: /^전체/ }).click();
  await page.getByLabel("대상·내용 찾기").fill("점검");
  await expect.poll(() => calls.at(-1)?.get("q")).toBe("점검");
  await page.getByLabel("대상·내용 찾기").fill("");
  await page.getByRole("button", { name: "기간: 최근 7일" }).click();
  await page
    .getByRole("group", { name: "기간 고르기" })
    .getByRole("button", { name: "최근 30일" })
    .click();
  await expect
    .poll(() => {
      const last = calls.at(-1)!;
      return Date.parse(last.get("to")!) - Date.parse(last.get("from")!);
    })
    .toBe(30 * 86_400_000);
  await page.getByRole("button", { name: "운영자", exact: true }).click();
  await page
    .getByRole("group", { name: "운영자 고르기" })
    .getByRole("button", { name: /운영자 bbbb/ })
    .click();
  await expect.poll(() => calls.at(-1)?.get("actor")).toBe(SUB_B);
  await expect(records(page)).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "운영자: 운영자 bbbb" }),
  ).toBeVisible();
  // 고른 뒤에도 앞서 본 다른 운영자로 바로 바꿀 수 있음
  await page.getByRole("button", { name: "운영자: 운영자 bbbb" }).click();
  await page
    .getByRole("group", { name: "운영자 고르기" })
    .getByRole("button", { name: /운영자 aaaa/ })
    .click();
  await expect.poll(() => calls.at(-1)?.get("actor")).toBe(SUB_A);
});

test("다음·이전: 다음은 cursor만 보내고, 이전은 앞 쪽으로 돌아간다", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockAudit(page);
  await openAudit(page);
  await expect(page.getByRole("button", { name: "이전" })).toBeDisabled();
  await page.getByRole("button", { name: "다음" }).click();
  await expect(records(page)).toHaveCount(1);
  expect([...calls.at(-1)!.keys()].sort()).toEqual(["cursor", "limit"]);
  await expect(page.getByText("최근 7일 4건 중 21–21")).toBeVisible();
  await page.getByRole("button", { name: "이전" }).click();
  await expect(records(page)).toHaveCount(3);
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

test("누가 칸은 이메일·임시 표시·데모 계정을 구분해 보여 준다", async ({
  page,
}) => {
  await signIn(page);
  await mockAudit(page, {
    items: [
      entry(1, {
        actorSub: SUB_A,
        actorEmail: "alice@example.test",
      }),
      entry(2, {
        actorSub: SUB_B,
        action: "inquiry.update",
        target: { kind: "inquiry", id: INQUIRY },
        targetLabel: undefined,
        notice: undefined,
        changes: ["status"],
        statusFrom: "received",
        statusTo: "in_progress",
      }),
      entry(3, {
        actorSub: "demo-1111",
        actorKind: "sample",
        role: "sample",
        action: "sample.read",
        target: { kind: "route", id: "GET /ops/me" },
        targetLabel: undefined,
        notice: undefined,
        changes: [],
      }),
    ],
  });
  await openAudit(page);
  await expect(
    page.getByText("alice@example.test").locator("visible=true").first(),
  ).toBeVisible();
  await expect(
    page.getByText("운영자 bbbb").locator("visible=true").first(),
  ).toBeVisible();
  await expect(
    page.getByText("데모 계정").locator("visible=true").first(),
  ).toBeVisible();
});
