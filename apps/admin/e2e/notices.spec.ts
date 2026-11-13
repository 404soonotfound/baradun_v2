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

// 운영자 공지 목록·편집 (BRD-151, 화면 설계서 6장 ADM-NTC). 운영 API는 가짜 응답

const OPS = "ops@example.test";
const at = (hours: number) =>
  new Date(Date.now() + hours * 3_600_000).toISOString();

const content = (overrides: Record<string, unknown> = {}) => ({
  kind: "general",
  title: { ko: "데이터 출처 안내", en: "Data sources" },
  body: { ko: "데이터 출처 안내가 바뀌었어요.", en: "We updated sources." },
  startsAt: at(-1),
  endsAt: at(48),
  ...overrides,
});

const view = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  version: 2,
  draft: content(),
  live: content(),
  exposedAt: at(-2),
  updatedAt: at(-2),
  state: "live",
  pendingEdit: false,
  hidden: false,
  ...overrides,
});

const ITEMS = () => [
  view("n-live", {
    draft: content({
      kind: "maintenance_notice",
      title: { ko: "새벽 점검 예고", en: "Maintenance" },
      endsAt: at(30),
    }),
    live: content({
      kind: "maintenance_notice",
      title: { ko: "새벽 점검 예고", en: "Maintenance" },
    }),
    pendingEdit: true,
  }),
  view("n-hidden", { hidden: true }),
  view("n-scheduled", {
    draft: content({ startsAt: at(30), endsAt: null }),
    live: content({ startsAt: at(30), endsAt: null }),
    state: "scheduled",
  }),
  view("n-draft", {
    version: 1,
    draft: content({
      title: { ko: "영어 문구 없음", en: "" },
      body: { ko: "아직 영어를 안 씀", en: "" },
      startsAt: at(5),
    }),
    live: null,
    exposedAt: null,
    state: "draft",
  }),
  view("n-ended", {
    draft: content({ startsAt: at(-100), endsAt: at(-50) }),
    live: content({ startsAt: at(-100), endsAt: at(-50) }),
    state: "ended",
  }),
];

interface Write {
  method: string;
  path: string;
  body: Record<string, unknown>;
  key: string | undefined;
}

async function mockNotices(
  page: Page,
  options: {
    items?: () => unknown[];
    write?: (w: Write) => { status: number; body: unknown } | undefined;
  } = {},
): Promise<{ writes: Write[]; lists: number }> {
  const calls = { writes: [] as Write[], lists: 0 };
  await page.route(/\/ops\/notices(\/.*)?$/, async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      calls.lists += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: (options.items ?? ITEMS)() }),
      });
      return;
    }
    const w: Write = {
      method: request.method(),
      path,
      body: JSON.parse(request.postData() ?? "{}"),
      key: request.headers()["x-idempotency-key"],
    };
    calls.writes.push(w);
    const reply = options.write?.(w) ?? {
      status: w.method === "POST" && path === "/ops/notices" ? 201 : 200,
      body: { noticeId: path.split("/")[3] ?? "n-new", version: 3 },
    };
    await route.fulfill({
      status: reply.status,
      contentType: "application/json",
      body: JSON.stringify(reply.body),
    });
  });
  return calls;
}

async function signIn(page: Page, groups = ["publisher"]) {
  await mockCognito(page, srpScript({ email: OPS, after: "tokens", groups }));
  await mockOps(page, ME_OK);
  await signInWithPassword(page, "/login/", OPS);
  await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
  await expectHomeLoaded(page);
}

async function openNotices(page: Page) {
  await openMenu(page);
  await page
    .getByRole("navigation", { name: "운영 메뉴" })
    .filter({ visible: true })
    .getByRole("link", { name: "공지" })
    .click();
  await expect(
    page.getByRole("heading", { name: "공지", level: 1 }),
  ).toBeVisible();
}

const rows = (page: Page) =>
  isMobile(page)
    ? page.locator("ul li").filter({ visible: true })
    : page.locator("tbody tr");

async function openNotice(page: Page, title: string) {
  await rows(page).filter({ hasText: title }).first().getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
}

test("목록: 상태 탭에 수, 수정 대기·가려짐·영어 없음을 숨기지 않고 보여 준다", async ({
  page,
}) => {
  await signIn(page);
  await mockNotices(page);
  await openNotices(page);
  const tabs = page.getByRole("group", { name: "공지 상태로 거르기" });
  await expect(tabs.getByRole("button", { name: "전체 5" })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "노출 2" })).toBeVisible();
  await expect(rows(page)).toHaveCount(5);
  const live = rows(page).filter({ hasText: "새벽 점검 예고" });
  await expect(live).toContainText("점검 예고");
  await expect(live).toContainText("수정 대기");
  await expect(rows(page).filter({ hasText: "가려짐" })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: "영어 문구 없음" })).toContainText(
    "English 없음",
  );
  await tabs.getByRole("button", { name: "대기 1" }).click();
  await expect(rows(page)).toHaveCount(1);
  await expectNoA11yViolations(page);
});

test("보기 권한은 새 공지를 비활성으로 두고 이유를 보여 주며, 편집 칸도 잠근다", async ({
  page,
}) => {
  await signIn(page, ["viewer"]);
  await mockNotices(page);
  await openNotices(page);
  await expect(page.getByRole("button", { name: "새 공지" })).toBeDisabled();
  await expect(
    page.getByText("공지를 쓰려면 편집 권한이 필요해요.").first(),
  ).toBeVisible();
  await openNotice(page, "새벽 점검 예고");
  await expect(page.getByLabel("제목", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "저장" })).toBeDisabled();
});

test("새 공지: 한국 시간으로 쓴 기간을 UTC로 보내고, 저장은 앱 반영이 아니라고 알린다 @smoke", async ({
  page,
}) => {
  await signIn(page);
  let created = false;
  const calls = await mockNotices(page, {
    items: () =>
      created
        ? [
            ...ITEMS(),
            view("n-new", {
              version: 1,
              draft: content({ title: { ko: "새 안내", en: "New" } }),
              live: null,
              state: "draft",
            }),
          ]
        : ITEMS(),
    write: () => {
      created = true;
      return { status: 201, body: { noticeId: "n-new", version: 1 } };
    },
  });
  await openNotices(page);
  await page.getByRole("button", { name: "새 공지" }).click();
  await expect(
    page.getByRole("heading", { name: "새 공지", level: 1 }),
  ).toBeVisible();
  await page.getByLabel("제목", { exact: true }).fill("새 안내");
  await page.getByLabel("내용", { exact: true }).fill("새 안내 내용");
  await page.getByLabel("Title").fill("New");
  await page.getByLabel("Body").fill("New body");
  await page.getByLabel("노출 시작(한국 시간)").fill("2030-01-02T09:00");
  await page.getByLabel("노출 종료(한국 시간)").fill("2030-01-03T09:00");
  await expectNoA11yViolations(page);
  await page.getByRole("button", { name: "저장" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "아직 앱에 나가지 않아요" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/notices\/\?id=n-new$/);
  expect(calls.writes[0]).toMatchObject({
    method: "POST",
    path: "/ops/notices",
    body: {
      kind: "general",
      title: { ko: "새 안내", en: "New" },
      body: { ko: "새 안내 내용", en: "New body" },
      startsAt: "2030-01-02T00:00:00.000Z",
      endsAt: "2030-01-03T00:00:00.000Z",
    },
  });
  expect(calls.writes[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
});

test("확정 전 확인: 영어 없음·글자 수 넘침은 저장은 되지만 확정을 막고, 기간이 거꾸로면 저장도 막는다", async ({
  page,
}) => {
  await signIn(page);
  await mockNotices(page);
  await openNotices(page);
  await openNotice(page, "영어 문구 없음");
  const expose = page.getByRole("button", { name: "게시 대상으로 확정" });
  await expect(expose).toBeDisabled();
  await expect(
    page.getByText("English Title을(를) 써 주세요.").first(),
  ).toBeVisible();
  const title = page.getByLabel("제목", { exact: true });
  await title.fill("가".repeat(41));
  await expect(page.getByText("41/40")).toBeVisible();
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("button", { name: "저장" })).toBeEnabled();
  await page.getByLabel("노출 종료(한국 시간)").fill("2020-01-01T00:00");
  await expect(page.getByRole("button", { name: "저장" })).toBeDisabled();
  await expect(
    page.getByText("노출 종료는 시작 뒤, 지금보다 뒤로 정해 주세요.").first(),
  ).toBeVisible();
});

test("표현 검사(D17-8): 차단 표현은 저장은 되지만 확정을 막고, 문맥 확인 표현은 경고만, 허용 표현은 통과", async ({
  page,
}) => {
  await signIn(page);
  await mockNotices(page, {
    items: () => [
      view("n-ready", {
        version: 4,
        draft: content({ startsAt: at(5) }),
        live: null,
        state: "draft",
      }),
    ],
  });
  await openNotices(page);
  await openNotice(page, "데이터 출처 안내");
  const checks = page.locator("#notice-checks-list");
  await expect(
    checks.getByText("게시를 막는 표현 없음", { exact: false }),
  ).toBeVisible();
  await expect(checks).toContainText("통과: 게시를 막는 표현 없음");

  const body = page.getByLabel("내용", { exact: true });
  await body.fill("오늘은 안 전 해 요");
  await expect(body).toHaveAttribute("aria-invalid", "true");
  await expect(checks).toContainText("고칠 것: 게시를 막는 표현 없음");
  await expect(
    page
      .getByText(
        "한국어 내용의 ‘안 전 해 요’은(는) 안전 보장 표현이라 게시 대상으로 확정할 수 없어요.",
        { exact: false },
      )
      .first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "저장" })).toBeEnabled();
  await expectNoA11yViolations(page);

  await body.fill("안전요원 안내를 따라 주세요. 파도가 잔잔해요");
  await expect(body).not.toHaveAttribute("aria-invalid", "true");
  await expect(checks).toContainText("통과: 게시를 막는 표현 없음");
  const warnings = page.locator("#notice-warnings");
  await expect(warnings).toContainText("문맥 확인 1 · 확정은 막지 않아요");
  await expect(warnings).toContainText("한국어 내용의 ‘잔잔해요’");
  await expect(warnings).not.toContainText("안전요원");
  await expectNoA11yViolations(page);
});

test("표현 검사: 서버가 차단 표현으로 확정을 거절하면 칸 이름과 다음 행동을 알린다", async ({
  page,
}) => {
  await signIn(page);
  await mockNotices(page, {
    items: () => [
      view("n-ready", {
        version: 4,
        draft: content({ startsAt: at(5) }),
        live: null,
        state: "draft",
      }),
    ],
    write: () => ({
      status: 400,
      body: {
        error: {
          code: "invalid_request",
          field: "body.en",
          reason: "blocked_phrase",
          requestId: "req-1234abcd",
        },
      },
    }),
  });
  await openNotices(page);
  await openNotice(page, "데이터 출처 안내");
  await page.getByRole("button", { name: "게시 대상으로 확정" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "게시 대상으로 확정해요" })
    .getByRole("button", { name: "게시 대상으로 확정" })
    .click();
  await expect(
    page.getByRole("alert").filter({
      hasText:
        "서버가 ‘English Body’에서 게시할 수 없는 표현을 찾아 확정하지 않았어요.",
    }),
  ).toContainText("고쳐 저장한 뒤 다시 확정해 주세요.");
});

test("게시 대상 확정: 노출 변경 권한은 확인 뒤 확정하고, 편집 권한은 비활성 + 이유", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockNotices(page, {
    items: () => [
      view("n-ready", {
        version: 4,
        draft: content({ startsAt: at(5) }),
        live: null,
        state: "draft",
      }),
    ],
  });
  await openNotices(page);
  await openNotice(page, "데이터 출처 안내");
  await page.getByRole("button", { name: "게시 대상으로 확정" }).click();
  const confirm = page
    .getByRole("alert")
    .filter({ hasText: "게시 대상으로 확정해요" });
  await expect(confirm).toContainText("지금 바로 보이지 않아요");
  await expect(
    confirm.getByRole("button", { name: "게시 대상으로 확정" }),
  ).toBeFocused();
  await confirm.getByRole("button", { name: "게시 대상으로 확정" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "다음 게시 때 앱에 반영돼요" }),
  ).toBeVisible();
  expect(calls.writes.at(-1)).toMatchObject({
    method: "POST",
    path: "/ops/notices/n-ready/expose",
    body: { version: 4 },
  });
});

test("편집 권한은 확정·노출 종료가 비활성이고 노출 변경 권한이 필요하다고 알린다", async ({
  page,
}) => {
  await signIn(page, ["editor"]);
  await mockNotices(page);
  await openNotices(page);
  await openNotice(page, "새벽 점검 예고");
  await expect(
    page.getByRole("button", { name: "게시 대상으로 확정" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "노출 종료" })).toBeDisabled();
  await expect(
    page.getByText("게시 대상 확정·노출 종료는 노출 변경 권한이 필요해요."),
  ).toBeVisible();
});

test("노출 중: 바로 지울 수 없고, 노출 종료는 확인 뒤 보낸다", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockNotices(page);
  await openNotices(page);
  await openNotice(page, "새벽 점검 예고");
  await expect(page.getByRole("button", { name: "삭제" })).toBeDisabled();
  await expect(
    page.getByText("노출 중인 공지는 바로 지울 수 없어요.").first(),
  ).toBeVisible();
  // 저장한 문구가 노출본과 다름(수정 대기): 앱에 나간 문구를 함께 보여 줌
  await expect(page.getByText("저장한 문구가 노출본과 달라요")).toBeVisible();
  await page.getByRole("button", { name: "노출 종료" }).click();
  const confirm = page.getByRole("alert").filter({ hasText: "노출을 끝내요" });
  await confirm.getByRole("button", { name: "노출 종료" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "노출을 끝냈어요" }),
  ).toBeVisible();
  expect(calls.writes.at(-1)).toMatchObject({
    path: "/ops/notices/n-live/end",
    body: { version: 2 },
  });
});

test("종료된 공지는 확인 뒤 지우고 목록으로 돌아간다", async ({ page }) => {
  await signIn(page);
  const calls = await mockNotices(page);
  await openNotices(page);
  await rows(page).last().getByRole("link").click();
  await page.getByRole("button", { name: "삭제" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "이 공지를 지워요" })
    .getByRole("button", { name: "삭제" })
    .click();
  await expect(
    page.getByRole("heading", { name: "공지", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "공지를 지웠어요" }),
  ).toBeVisible();
  expect(calls.writes.at(-1)).toMatchObject({
    method: "DELETE",
    path: "/ops/notices/n-ended",
  });
});

test("저장 충돌(409): 덮어쓰지 않고 새 내용 불러오기·쓰던 문구 복사를 주고, 다시 보내면 같은 요청 번호", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockNotices(page, {
    write: () => ({
      status: 409,
      body: { error: { code: "conflict", reason: "version" } },
    }),
  });
  await openNotices(page);
  await openNotice(page, "데이터 출처 안내");
  await page.getByLabel("Title").fill("Changed");
  await page.getByRole("button", { name: "저장" }).click();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "먼저 이 공지를 바꿨어요" });
  await expect(
    alert.getByRole("button", { name: "쓰던 문구 복사" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "저장" }).click();
  expect(calls.writes).toHaveLength(2);
  expect(calls.writes[1]?.key).toBe(calls.writes[0]?.key);
  const before = calls.lists;
  await alert.getByRole("button", { name: "새 내용 불러오기" }).click();
  await expect.poll(() => calls.lists).toBeGreaterThan(before);
});

test("저장하지 않은 변경이 있으면 나가기 전에 묻고 '계속 쓰기'에 먼저 포커스", async ({
  page,
}) => {
  await signIn(page);
  await mockNotices(page);
  await openNotices(page);
  await openNotice(page, "데이터 출처 안내");
  await page.getByLabel("Body").fill("Changed body");
  await page.getByRole("button", { name: /공지 목록으로/ }).click();
  const confirm = page
    .getByRole("alert")
    .filter({ hasText: "저장하지 않은 변경이 있어요" });
  await expect(confirm).toContainText("바뀐 1곳");
  await expect(
    confirm.getByRole("button", { name: "계속 쓰기" }),
  ).toBeFocused();
  await confirm.getByRole("button", { name: "나가기" }).click();
  await expect(
    page.getByRole("heading", { name: "공지", level: 1 }),
  ).toBeVisible();
});

test("저장 뒤 목록 다시 읽기가 실패해도 편집 칸과 쓰던 내용을 지우지 않고 실패만 알린다", async ({
  page,
}) => {
  await signIn(page);
  let fail = false;
  await mockNotices(page, {
    write: () => {
      fail = true;
      return { status: 200, body: { noticeId: "n-hidden", version: 3 } };
    },
  });
  await page.route(/\/ops\/notices$/, async (route) => {
    if (fail && route.request().method() === "GET") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "internal", requestId: "req-1a2b3c4d" },
        }),
      });
      return;
    }
    await route.fallback();
  });
  await openNotices(page);
  await openNotice(page, "데이터 출처 안내");
  await page.getByLabel("Body").fill("Saved body");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "공지 목록을 불러오지 못했어요" }),
  ).toContainText("req-1a2b3c4d");
  await expect(page.getByLabel("Body")).toHaveValue("Saved body");
});

test("열어 둔 사이 끝나 노출 종료가 거절되면(not_live) 새 내용 불러오기로 같은 version의 '종료'를 받고 잠금을 푼다", async ({
  page,
}) => {
  await signIn(page);
  let ended = false;
  await mockNotices(page, {
    items: () => [view("n-live", ended ? { state: "ended" } : {})],
    write: () => {
      ended = true;
      return {
        status: 409,
        body: { error: { code: "conflict", reason: "not_live" } },
      };
    },
  });
  await openNotices(page);
  await openNotice(page, "데이터 출처 안내");
  await page.getByRole("button", { name: "노출 종료" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "노출을 끝내요" })
    .getByRole("button", { name: "노출 종료" })
    .click();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "노출 중이 아니에요" });
  await alert.getByRole("button", { name: "새 내용 불러오기" }).click();
  await expect(
    page.getByRole("heading", { level: 1 }).locator("..").getByText("종료"),
  ).toBeVisible();
  await expect(page.getByLabel("Body")).toBeEnabled();
  await expect(page.getByRole("button", { name: "노출 종료" })).toBeDisabled();
});

test("저장하지 않은 변경이 있으면 노출 종료·삭제를 막고 먼저 저장하라고 알린다", async ({
  page,
}) => {
  await signIn(page);
  await mockNotices(page);
  await openNotices(page);
  await openNotice(page, "데이터 출처 안내");
  await expect(page.getByRole("button", { name: "노출 종료" })).toBeEnabled();
  await page.getByLabel("Body").fill("Unsaved body");
  await expect(page.getByRole("button", { name: "노출 종료" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "삭제" })).toBeDisabled();
  await expect(
    page
      .getByText("저장하지 않은 변경이 있어요. 먼저 저장하거나 취소해야")
      .first(),
  ).toBeVisible();
});

test("저장하지 않은 변경이 있으면 왼쪽 메뉴·브라우저 뒤로로 나갈 때도 묻는다", async ({
  page,
}) => {
  await signIn(page);
  await mockNotices(page);
  await openNotices(page);
  await openNotice(page, "데이터 출처 안내");
  await page.getByLabel("Body").fill("Unsaved body");
  const confirm = page
    .getByRole("alert")
    .filter({ hasText: "저장하지 않은 변경이 있어요" });

  // 브라우저 뒤로: 확인을 띄우고 '계속 쓰기'면 그대로
  await page.goBack();
  await expect(
    confirm.getByRole("button", { name: "계속 쓰기" }),
  ).toBeFocused();
  await confirm.getByRole("button", { name: "계속 쓰기" }).click();
  await expect(page.getByLabel("Body")).toHaveValue("Unsaved body");

  if (!isMobile(page)) {
    // 왼쪽 메뉴 링크: 이동하지 않고 확인 → 나가기면 그 화면으로
    await page
      .getByRole("navigation", { name: "운영 메뉴" })
      .filter({ visible: true })
      .getByRole("link", { name: /문의/ })
      .click();
    await expect(page).toHaveURL(/\/notices\//);
    await confirm.getByRole("button", { name: "나가기" }).click();
    await expect(page).toHaveURL(/\/inquiries\//);
  } else {
    await page.goBack();
    await confirm.getByRole("button", { name: "나가기" }).click();
    await expect(
      page.getByRole("heading", { name: "공지", level: 1 }),
    ).toBeVisible();
  }
});

test("저장 실패 뒤에도 뒤로 가기 '나가기'는 목록으로 가고, 저장하면 보호 항목을 걷어 뒤로 한 번에 목록으로 간다", async ({
  page,
}) => {
  await signIn(page);
  let failSave = true;
  let saved: Record<string, unknown> | null = null;
  await mockNotices(page, {
    // 저장에 성공하면 목록이 저장한 문구·새 version을 줌
    items: () =>
      saved
        ? [view("n-hidden", { version: 3, draft: saved, pendingEdit: true })]
        : ITEMS(),
    write: (w) => {
      if (failSave) {
        return {
          status: 500,
          body: { error: { code: "internal", requestId: "req-9" } },
        };
      }
      saved = Object.fromEntries(
        Object.entries(w.body).filter(([k]) => k !== "version"),
      );
      return { status: 200, body: { noticeId: "n-hidden", version: 3 } };
    },
  });
  await openNotices(page);
  const list = page.getByRole("heading", { name: "공지", level: 1 });
  await openNotice(page, "데이터 출처 안내");
  await page.getByLabel("Body").fill("Unsaved body");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "저장하지 못했어요" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "저장" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "저장하지 못했어요" }),
  ).toBeVisible();
  await page.goBack();
  await page
    .getByRole("alert")
    .filter({ hasText: "저장하지 않은 변경이 있어요" })
    .getByRole("button", { name: "나가기" })
    .click();
  await expect(list).toBeVisible();

  failSave = false;
  await openNotice(page, "데이터 출처 안내");
  await page.getByLabel("Body").fill("Saved body");
  await page.getByRole("button", { name: "저장" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "저장했어요" }),
  ).toBeVisible();
  await page.goBack();
  await expect(list).toBeVisible();
});
