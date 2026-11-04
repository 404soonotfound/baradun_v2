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
  detail: number;
  patches: { body: Record<string, unknown>; key: string | undefined }[];
}

async function mockInquiries(
  page: Page,
  options: {
    detail?: (inquiryId: string) => { status: number; body: unknown };
    listStatus?: number;
    // 처리 저장(PATCH) 응답. 없으면 200 + version 2
    patch?: (body: Record<string, unknown>) => {
      status: number;
      body: unknown;
    };
  } = {},
): Promise<Calls> {
  const calls: Calls = { list: [], detail: 0, patches: [] };
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
    if (route.request().method() === "PATCH") {
      const body = JSON.parse(route.request().postData() ?? "{}");
      calls.patches.push({
        body,
        key: route.request().headers()["x-idempotency-key"],
      });
      const reply = options.patch?.(body) ?? {
        status: 200,
        body: { inquiryId, version: 2 },
      };
      await route.fulfill({
        status: reply.status,
        contentType: "application/json",
        body: JSON.stringify(reply.body),
      });
      return;
    }
    calls.detail += 1;
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

// 상세: PC는 목록 위 모달 패널(dialog), 모바일은 목록 대신 상세 영역
const detailOf = (page: Page) =>
  isMobile(page)
    ? page.getByRole("region", { name: "문의 상세" })
    : page.getByRole("dialog");

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

test("상세: 내용·보관 기한·받지 않는 연락처를 보여 주고, PC는 목록을 밀지 않는 딤 패널(Esc·바깥 누르기로 닫음), 모바일은 목록 대신 상세", async ({
  page,
}) => {
  await signIn(page);
  await mockInquiries(page);
  await openInquiries(page);
  const table = page.locator("table");
  const before = isMobile(page) ? null : await table.boundingBox();
  await rows(page).first().getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`\\?id=${id(1)}$`));
  const detail = detailOf(page);
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
    // 패널이 열려도 표 위치·너비가 그대로(목록 위에 뜸)
    expect(await table.boundingBox()).toEqual(before);
    await expect(detail).toHaveAttribute("aria-label", "문의 상세");
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(/\/inquiries\/$/);
    // 바깥(딤) 누르기로도 닫힘
    await rows(page).nth(1).getByRole("link").click();
    await expect(detail).toBeVisible();
    await page.mouse.click(100, 400);
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
  const detail = detailOf(page);
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

test("토큰 갱신에 실패해 다시 로그인하면 문의 목록을 저절로 다시 읽는다", async ({
  page,
}) => {
  // 첫 발급은 곧 만료(바로 갱신 필요) → 갱신은 가짜 서버가 거절 → 다시 로그인 창. 두 번째 발급은 15분
  let issued = 0;
  await mockCognito(
    page,
    srpScript({
      email: OPS,
      after: "tokens",
      groups: ["editor"],
      expIn: () => (issued++ === 0 ? 30 : 900),
    }),
  );
  await mockOps(page, ME_OK);
  await mockInquiries(page);
  // 보던 화면이 문의 목록이면 로그인 뒤 바로 문의 목록을 읽음
  await page.goto("/inquiries/");
  await expect(page).toHaveURL(/\/login\/$/);
  await page.getByLabel("이메일").fill(OPS);
  await page.getByLabel("비밀번호", { exact: true }).fill("test-password-1");
  await page.getByRole("button", { name: "다음" }).click();
  await expect(page).toHaveURL(/\/inquiries\/$/);
  await expect(page.getByText(/로그인을 다시 확인해야 해요/)).toBeVisible();

  const dialog = page.getByRole("dialog", {
    name: "로그인을 이어가지 못했어요",
  });
  await dialog.getByLabel("비밀번호", { exact: true }).fill("test-password-1");
  await dialog.getByRole("button", { name: "로그인" }).click();
  await expect(dialog).toBeHidden();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByText(/로그인을 다시 확인해야 해요/)).toHaveCount(0);
});

test("다음 쪽이 비어도(그사이 지워짐) 이전 쪽으로 돌아갈 수 있고 '문의가 없어요'로 보이지 않는다", async ({
  page,
}) => {
  await signIn(page);
  await mockInquiries(page);
  // 나중에 건 route가 먼저 받음: cursor가 있는 쪽은 빈 목록
  await page.route(/\/ops\/inquiries\?.*cursor=/, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], nextCursor: null }),
    }),
  );
  await openInquiries(page);
  await page.getByRole("button", { name: "다음" }).click();
  await expect(page.getByText(/이 쪽에는 문의가 없어요/)).toBeVisible();
  await expect(page.getByText("문의가 없어요", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "이전" }).click();
  await expect(rows(page)).toHaveCount(3);
});

test("처리: 반려는 이유가 있어야 저장되고, 저장하면 안내·목록·메뉴 배지에 바로 반영된다(목록 응답이 늦어도 되돌리지 않음)", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockInquiries(page);
  await openInquiries(page);
  // PC 메뉴(모바일은 서랍 안이라 여기서는 PC만 봄)
  const menuBadge = page
    .getByRole("navigation", { name: "운영 메뉴" })
    .filter({ visible: true })
    .first();
  if (!isMobile(page)) {
    await expect(
      menuBadge.getByRole("link", { name: "문의, 접수 2건" }),
    ).toBeVisible();
  }
  await rows(page).first().getByRole("link").click();
  const detail = detailOf(page);
  await expect(detail.getByText("바뀐 내용 없음")).toBeVisible();

  await detail.getByText("반려", { exact: true }).click();
  await detail.getByRole("button", { name: "저장" }).click();
  await expect(detail.getByText("반려 이유를 써 주세요.")).toBeVisible();
  expect(calls.patches).toHaveLength(0);

  await detail.getByLabel("반려 이유").fill("  내용을 알아볼 수 없어요.  ");
  await detail.getByLabel("처리 메모(내부용)").fill("스팸으로 보임");
  await expect(detail.getByText("바뀐 내용 3")).toBeVisible();
  await expectNoA11yViolations(page);
  await detail.getByRole("button", { name: "저장" }).click();
  await expect(
    detail.getByRole("status").filter({ hasText: "‘반려’(으)로 바꿨어요" }),
  ).toBeVisible();
  expect(calls.patches[0]?.body).toEqual({
    version: 1,
    status: "rejected",
    rejectReason: "내용을 알아볼 수 없어요.",
    memo: "스팸으로 보임",
  });
  expect(calls.patches[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  // 저장 뒤 상세를 다시 읽음
  expect(calls.detail).toBeGreaterThanOrEqual(2);

  if (isMobile(page)) {
    await detail.getByRole("link", { name: /문의 목록으로/ }).click();
  } else {
    await page.keyboard.press("Escape");
    await expect(
      menuBadge.getByRole("link", { name: "문의, 접수 1건" }),
    ).toBeVisible();
  }
  // 가짜 목록은 여전히 '접수'(version 1)를 주지만 저장한 상태(version 2)로 보임
  await expect(rows(page).first()).toContainText("반려");
});

test("처리 충돌(409): 다른 운영자가 먼저 바꿨으면 덮어쓰지 않고 새 내용 불러오기·메모 복사를 준다", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockInquiries(page, {
    patch: () => ({
      status: 409,
      body: {
        error: { code: "conflict", reason: "version", requestId: "req-2" },
      },
    }),
  });
  await openInquiries(page);
  await rows(page).first().getByRole("link").click();
  const detail = detailOf(page);
  await detail.getByLabel("처리 메모(내부용)").fill("내가 쓴 메모");
  await detail.getByRole("button", { name: "저장" }).click();
  const alert = detail.getByRole("alert");
  await expect(alert).toContainText("다른 운영자가 먼저 이 문의를 바꿨어요");
  await expect(
    alert.getByRole("button", { name: "내 메모 복사" }),
  ).toBeVisible();
  const before = calls.detail;
  await alert.getByRole("button", { name: "새 내용 불러오기" }).click();
  await expect.poll(() => calls.detail).toBeGreaterThan(before);
});

test("저장 실패: 화면 상태를 먼저 바꾸지 않고, 다시 보내면 같은 요청 번호를 쓴다", async ({
  page,
}) => {
  await signIn(page);
  let fail = true;
  const calls = await mockInquiries(page, {
    patch: () =>
      fail
        ? {
            status: 500,
            body: { error: { code: "internal", requestId: "req-9" } },
          }
        : { status: 200, body: { inquiryId: id(1), version: 2 } },
  });
  await openInquiries(page);
  await rows(page).first().getByRole("link").click();
  const detail = detailOf(page);
  await detail.getByText("확인 중", { exact: true }).click();
  await detail.getByRole("button", { name: "저장" }).click();
  const alert = detail.getByRole("alert");
  await expect(alert).toContainText("지금 상태는 ‘접수’ 그대로예요");
  await expect(alert).toContainText("오류 번호 req-9");
  fail = false;
  await detail.getByRole("button", { name: "저장" }).click();
  await expect(
    detail.getByRole("status").filter({ hasText: "‘확인 중’(으)로 바꿨어요" }),
  ).toBeVisible();
  expect(calls.patches).toHaveLength(2);
  expect(calls.patches[1]?.key).toBe(calls.patches[0]?.key);
});

test("반려 이유 길이는 반려일 때만 보고, 다른 상태로 바꾸면 저장할 수 있다", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockInquiries(page);
  await openInquiries(page);
  await rows(page).first().getByRole("link").click();
  const detail = detailOf(page);
  await detail.getByText("반려", { exact: true }).click();
  await detail.getByLabel("반려 이유").fill("가".repeat(501));
  await expect(detail.getByText(/500자까지 쓸 수 있어요/)).toBeVisible();
  await expect(detail.getByRole("button", { name: "저장" })).toBeDisabled();
  await detail.getByText("완료", { exact: true }).click();
  await detail.getByRole("button", { name: "저장" }).click();
  await expect(
    detail.getByRole("status").filter({ hasText: "‘완료’(으)로 바꿨어요" }),
  ).toBeVisible();
  expect(calls.patches[0]?.body).toEqual({ version: 1, status: "resolved" });
});

test("충돌 뒤 '새 내용 불러오기'는 서버의 새 내용으로 바꾼다(쓰던 메모는 그때 사라짐)", async ({
  page,
}) => {
  await signIn(page);
  let version = 1;
  await mockInquiries(page, {
    detail: () => ({
      status: 200,
      body: {
        ...summary(1, { version }),
        restricted: false,
        message: "본문",
        memo: version > 1 ? "다른 운영자 메모" : null,
        rejectReason: null,
        emailCollected: false,
        photosCollected: false,
      },
    }),
    patch: () => {
      version = 2; // 다른 운영자가 먼저 바꾼 상태
      return {
        status: 409,
        body: {
          error: { code: "conflict", reason: "version", requestId: "r" },
        },
      };
    },
  });
  await openInquiries(page);
  await rows(page).first().getByRole("link").click();
  const detail = detailOf(page);
  const memo = detail.getByLabel("처리 메모(내부용)");
  await memo.fill("내가 쓴 메모");
  await detail.getByRole("button", { name: "저장" }).click();
  await detail.getByRole("button", { name: "새 내용 불러오기" }).click();
  await expect(memo).toHaveValue("다른 운영자 메모");
  await expect(detail.getByText("바뀐 내용 없음")).toBeVisible();
});

test("저장 뒤 다시 읽기가 실패해도 내용과 처리 칸을 지우지 않고, 다시 읽을 때까지 잠근다", async ({
  page,
}) => {
  await signIn(page);
  let version = 1;
  let failNext = false;
  await mockInquiries(page, {
    detail: () =>
      failNext
        ? ((failNext = false),
          {
            status: 500,
            body: { error: { code: "internal", requestId: "req-5" } },
          })
        : {
            status: 200,
            body: {
              ...summary(1, { version }),
              restricted: false,
              message: "본문",
              memo: version > 1 ? "저장한 메모" : null,
              rejectReason: null,
              emailCollected: false,
              photosCollected: false,
            },
          },
    patch: () => {
      version = 2;
      failNext = true;
      return { status: 200, body: { inquiryId: id(1), version: 2 } };
    },
  });
  await openInquiries(page);
  await rows(page).first().getByRole("link").click();
  const detail = detailOf(page);
  const memo = detail.getByLabel("처리 메모(내부용)");
  await memo.fill("저장한 메모");
  await detail.getByRole("button", { name: "저장" }).click();

  const alert = detail
    .getByRole("alert")
    .filter({ hasText: "문의를 불러오지 못했어요" });
  await expect(alert).toContainText("오류 번호 req-5");
  await expect(detail.getByText("본문")).toBeVisible();
  await expect(memo).toHaveValue("저장한 메모");
  await expect(memo).toBeDisabled();

  await alert.getByRole("button", { name: "다시 시도" }).click();
  await expect(memo).toBeEnabled();
  await expect(memo).toHaveValue("저장한 메모");
  await expect(detail.getByText("바뀐 내용 없음")).toBeVisible();
});

test("접수 탭에서 완료로 저장하면 그 문의는 탭에서 빠지고 탭 수도 옮겨진다(목록 응답이 늦어도)", async ({
  page,
}) => {
  await signIn(page);
  await mockInquiries(page);
  await openInquiries(page);
  const tabs = page.getByRole("group", { name: "처리 상태로 거르기" });
  await tabs.getByRole("button", { name: "접수 2" }).click();
  await expect(rows(page)).toHaveCount(2);
  await rows(page).first().getByRole("link").click();
  const detail = detailOf(page);
  await detail.getByText("완료", { exact: true }).click();
  await detail.getByRole("button", { name: "저장" }).click();
  await expect(
    detail.getByRole("status").filter({ hasText: "‘완료’(으)로 바꿨어요" }),
  ).toBeVisible();
  if (isMobile(page)) {
    await detail.getByRole("link", { name: /문의 목록으로/ }).click();
  } else {
    await page.keyboard.press("Escape");
  }
  await expect(rows(page)).toHaveCount(1);
  await expect(tabs.getByRole("button", { name: "접수 1" })).toBeVisible();
  await expect(tabs.getByRole("button", { name: "완료 1" })).toBeVisible();
});

// 읽기 전용 칸에서 글을 끌어 고른 것처럼 선택 범위를 정함
async function selectText(page: Page, text: string) {
  const box = detailOf(page).getByRole("textbox", { name: "내용" });
  await box.evaluate((el, target) => {
    const area = el as HTMLTextAreaElement;
    const start = area.value.indexOf(target);
    area.focus();
    area.setSelectionRange(start, start + target.length);
    area.dispatchEvent(new Event("select", { bubbles: true }));
  }, text);
}

test("개인정보 가리기: 고른 부분을 확인 뒤 가리고, 쓰던 메모는 그대로 둔다", async ({
  page,
}) => {
  await signIn(page);
  const message = "깃발이 있어요.\r\n제 번호는 010-0000-0000이에요.";
  let redacted = false;
  const calls = await mockInquiries(page, {
    detail: () => ({
      status: 200,
      body: {
        ...summary(1, { version: redacted ? 2 : 1 }),
        restricted: false,
        message: redacted
          ? "깃발이 있어요.\r\n제 번호는 [가림]이에요."
          : message,
        memo: null,
        rejectReason: null,
        emailCollected: false,
        photosCollected: false,
      },
    }),
    patch: () => {
      redacted = true;
      return { status: 200, body: { inquiryId: id(1), version: 2 } };
    },
  });
  await openInquiries(page);
  await rows(page).first().getByRole("link").click();
  const detail = detailOf(page);
  await detail.getByLabel("처리 메모(내부용)").fill("쓰던 메모");
  await detail.getByRole("button", { name: "개인정보 가리기" }).click();
  const apply = detail.getByRole("button", { name: "고른 부분 가리기" });
  await expect(apply).toBeDisabled();
  await selectText(page, "010-0000-0000");
  await expect(detail.getByText("고른 부분 13자")).toBeVisible();
  await expectNoA11yViolations(page);
  await apply.click();
  await expect(detail.getByRole("alert")).toContainText(
    "원래 글은 되돌릴 수 없어요",
  );
  await detail.getByRole("button", { name: "가리기", exact: true }).click();
  await expect(
    detail.getByRole("status").filter({ hasText: "고른 부분을 가렸어요" }),
  ).toBeVisible();
  // 원래 본문(\r\n) 위치로 보내고, 그 자리 글을 함께 보냄
  const start = message.indexOf("010");
  expect(calls.patches.at(-1)?.body).toEqual({
    version: 1,
    redactions: [{ start, end: start + 13, text: "010-0000-0000" }],
  });
  await expect(detail.getByText("제 번호는 [가림]이에요.")).toBeVisible();
  // 가리기는 상태·메모를 바꾸지 않으므로 쓰던 메모를 '그사이 바뀜'으로 막지 않음
  await expect(detail.getByLabel("처리 메모(내부용)")).toHaveValue("쓰던 메모");
  await expect(detail.getByText("이 문의가 그사이 바뀌었어요")).toHaveCount(0);
});

test("개인정보 가리기: 본문이 그사이 바뀌었으면(400) 가리지 않았다고 알리고 새 내용 불러오기를 준다", async ({
  page,
}) => {
  await signIn(page);
  await mockInquiries(page, {
    patch: () => ({
      status: 400,
      body: {
        error: {
          code: "invalid_request",
          field: "redactions",
          requestId: "req-3",
        },
      },
    }),
  });
  await openInquiries(page);
  await rows(page).first().getByRole("link").click();
  const detail = detailOf(page);
  await detail.getByRole("button", { name: "개인정보 가리기" }).click();
  await selectText(page, "입수 금지");
  await detail.getByRole("button", { name: "고른 부분 가리기" }).click();
  await detail.getByRole("button", { name: "가리기", exact: true }).click();
  const alert = detail
    .getByRole("alert")
    .filter({ hasText: "가리지 않았어요" });
  await expect(alert).toBeVisible();
  await expect(
    alert.getByRole("button", { name: "새 내용 불러오기" }),
  ).toBeVisible();
});

test("개인정보 가리기: 편집 권한이 없으면 버튼을 숨기지 않고 비활성으로 둔다", async ({
  page,
}) => {
  await signIn(page, ["viewer"]);
  await mockInquiries(page);
  await openInquiries(page);
  await rows(page).first().getByRole("link").click();
  await expect(
    detailOf(page).getByRole("button", { name: "개인정보 가리기" }),
  ).toBeDisabled();
});
