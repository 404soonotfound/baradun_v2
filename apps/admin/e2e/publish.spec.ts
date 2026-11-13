import type { Page, Route } from "@playwright/test";
import {
  ME_OK,
  expect,
  expectHomeLoaded,
  expectNoA11yViolations,
  isMobile,
  mockCognito,
  mockOps,
  openMenu,
  signInWithPassword,
  srpScript,
  test,
} from "./fixtures";

// 데이터 게시 (#331, 화면 설계서 6장 ADM-PUB · 시안 V16·VM8·VM9·V30·N2·E2·E4·E10). 운영 API는 가짜 응답
// 지금 게시·되돌리기는 작업 ID → 상태 조회, 응답 시간 초과는 같은 멱등 키로 결과만 확인(D16-C4)

const OPS = "ops@example.test";
const MINUTE = 60_000;
const base = Math.floor(Date.now() / (10 * MINUTE)) * 10 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const version = (ms: number) =>
  iso(ms).replace(/[-:]/g, "").replace(/\.\d+/, "");
const V0 = version(base);
const V1 = version(base - 10 * MINUTE);
const V2 = version(base - 20 * MINUTE);

const counts = { clear: 180, unavailable: 23, undetermined: 3 };

function overview(overrides: Record<string, unknown> = {}) {
  return {
    current: { ok: true, version: V0, generatedAt: iso(base) },
    history: {
      ok: true,
      items: [
        {
          result: "published",
          version: V0,
          at: iso(base),
          source: "auto",
          beachCount: 206,
          changes: {
            notices: false,
            categoryCounts: counts,
            categoryDelta: { clear: -3, unavailable: 3, undetermined: 0 },
            delayedBeaches: 1,
            delayedDelta: 0,
          },
          gapBefore: false,
        },
        {
          result: "failed",
          version: version(base - 5 * MINUTE),
          at: iso(base - 5 * MINUTE),
          source: "auto",
          reason: "beach_ids",
        },
        {
          result: "published",
          version: V1,
          at: iso(base - 10 * MINUTE),
          source: "operator",
          beachCount: 206,
          changes: null,
          gapBefore: false,
        },
      ],
    },
    lastRun: {
      ok: true,
      run: {
        at: iso(base + 3 * MINUTE),
        source: "auto",
        result: "unchanged",
        version: V0,
      },
    },
    nextAuto: {
      warnings: iso(base + 18 * MINUTE),
      observations: iso(base + 40 * MINUTE),
    },
    pendingNotices: {
      ok: true,
      maintenancePending: false,
      items: [
        {
          id: "n-maint",
          change: "update",
          kind: "maintenance_notice",
          title: "새벽 점검 예고",
          startsAt: iso(base - 60 * MINUTE),
          endsAt: null,
        },
      ],
    },
    heldNotices: {
      ok: true,
      version: 4,
      items: [
        {
          id: "n-held",
          title: "주차장 공사 안내",
          target: V2,
          at: iso(base - 15 * MINUTE),
          restoresLive: false,
        },
      ],
    },
    latestJob: { ok: true, job: null },
    ...overrides,
  };
}

const job = (overrides: Record<string, unknown> = {}) => ({
  jobId: "j-0123456789ab",
  action: "publish",
  state: "pending",
  createdAt: iso(base + 4 * MINUTE),
  overdue: false,
  ...overrides,
});

interface Write {
  path: string;
  body: Record<string, unknown>;
  key: string | undefined;
}

async function mockPublish(
  page: Page,
  options: {
    overview?: () => unknown;
    create?: (
      w: Write,
      n: number,
    ) => "abort" | { status: number; body: unknown };
    jobs?: () => unknown;
    preview?: () => unknown;
    rollbackPreview?: (version: string) => unknown;
    reapply?: (w: Write) => { status: number; body: unknown };
  } = {},
) {
  const calls = { writes: [] as Write[], overviews: 0, previews: 0 };
  await page.route(/\/ops\/publish(\/.*)?(\?.*)?$/, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (request.method() === "GET") {
      if (url.pathname === "/ops/publish") {
        calls.overviews += 1;
        return json((options.overview ?? overview)());
      }
      if (url.pathname === "/ops/publish/preview") {
        calls.previews += 1;
        return json(options.preview?.() ?? { ok: false, reason: "failed" });
      }
      if (url.pathname === "/ops/publish/rollback-preview") {
        return json(
          options.rollbackPreview?.(url.searchParams.get("version") ?? "") ?? {
            available: true,
            version: url.searchParams.get("version"),
            items: [],
          },
        );
      }
      if (url.pathname.startsWith("/ops/publish/jobs/")) {
        const body =
          options.jobs?.() ?? job({ state: "done", result: "published" });
        return json({ jobId: "j-0123456789ab", job: body });
      }
    }
    const w: Write = {
      path: url.pathname,
      body: JSON.parse(request.postData() ?? "{}"),
      key: request.headers()["x-idempotency-key"],
    };
    calls.writes.push(w);
    if (url.pathname === "/ops/publish/jobs") {
      const reply = options.create?.(w, calls.writes.length) ?? {
        status: 202,
        body: { jobId: "j-0123456789ab", job: job() },
      };
      if (reply === "abort") return route.abort("failed");
      return json(reply.body, reply.status);
    }
    const reply = options.reapply?.(w) ?? {
      status: 200,
      body: { noticeId: "n-held", holdVersion: 5 },
    };
    return json(reply.body, reply.status);
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

async function openPublish(page: Page) {
  await openMenu(page);
  await page
    .getByRole("navigation", { name: "운영 메뉴" })
    .filter({ visible: true })
    .getByRole("link", { name: "데이터 게시" })
    .click();
  await expect(
    page.getByRole("heading", { name: "데이터 게시", level: 1 }),
  ).toBeVisible();
}

const history = (page: Page) =>
  isMobile(page)
    ? page
        .getByRole("region", { name: "게시 기록" })
        .locator("li")
        .filter({ visible: true })
    : page.getByRole("region", { name: "게시 기록" }).locator("tbody tr");

test("게시 현황: 현재 게시본·다음 자동 게시·대기 공지·되돌림 공지·게시 기록(바뀐 것·실패 사유)을 보여 준다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page);
  await openPublish(page);
  await expect(
    page.getByText("확정한 공지 1 · 다음 게시 때 함께"),
  ).toBeVisible();
  await expect(
    page.getByText("새로 게시할 변경이 없어 건너뛰었어요"),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "대기 중인 변경" })
      .getByText('공지 "새벽 점검 예고" 문구 수정'),
  ).toBeVisible();
  const held = page.getByRole("region", { name: "되돌림 상태 공지" });
  await expect(held).toContainText("주차장 공사 안내");
  await expect(held).toContainText("자동 게시에는 다시 실리지 않아요");
  await expect(history(page)).toHaveCount(3);
  await expect(history(page).nth(0)).toContainText(
    "특보 없음 −3 · 이용불가 +3",
  );
  await expect(history(page).nth(0)).toContainText("현재 게시본");
  await expect(history(page).nth(1)).toContainText("게시 안 함");
  await expect(history(page).nth(1)).toContainText(
    "해변 ID 대조 불일치(누락·추가·중복)",
  );
  await expect(history(page).nth(2)).toContainText("확인 못 함(이전 기록)");
  await expect(history(page).nth(2)).toContainText("지금 게시 · 운영자");
  await expect(page.getByText("앱 설정")).toBeVisible();
  await expect(page.getByText("서비스 점검 확인 못 함")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "GitHub에서 보기" }),
  ).toBeVisible();
  const pendingRegion = page.getByRole("region", { name: "대기 중인 변경" });
  await expect(pendingRegion.getByText("title.ko: 새벽 점검 예고")).toBeVisible();
  await expect(
    pendingRegion.getByText(
      "이전 값은 아직 보여 드릴 수 없어요 · 바뀔 내용만 보여요",
    ),
  ).toBeVisible();
  await expectNoA11yViolations(page);
});

test("지금 게시: 확인 창(취소에 먼저 포커스) → 작업 ID → 게시 완료와 앱 반영을 나눠 보여 준다 @smoke", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockPublish(page);
  await openPublish(page);
  await page.getByRole("button", { name: "지금 게시" }).click();
  const dialog = page.getByRole("dialog", {
    name: "대기 중인 변경 1건을 지금 게시할까요?",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "취소" })).toBeFocused();
  await expect(dialog).toContainText("새로 수집하지 않고 마지막 수집 기준으로");
  await expect(dialog).toContainText("판단 상태는 바뀌지 않아요");
  await expectNoA11yViolations(page);
  await dialog.getByRole("button", { name: "지금 게시" }).click();
  await expect(
    page.getByText("게시했어요. 앱의 다음 갱신 때 반영돼요."),
  ).toBeVisible();
  await expect(
    page.getByText(/앱은 5분마다 새 게시본을 확인해요/),
  ).toBeVisible();
  await expect(page.getByText(/1~2분/)).toHaveCount(0);
  expect(calls.writes).toHaveLength(1);
  expect(calls.writes[0]!.body).toEqual({ action: "publish" });
  expect(calls.writes[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
});

test("응답을 못 받으면 실패로 단정하지 않고, 결과 다시 확인은 같은 멱등 키로만 보낸다(새 게시 없음)", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockPublish(page, {
    create: (_w, n) =>
      n === 1
        ? "abort"
        : { status: 202, body: { jobId: "j-0123456789ab", job: job() } },
  });
  await openPublish(page);
  await page.getByRole("button", { name: "지금 게시" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "지금 게시" })
    .click();
  await expect(
    page.getByText(
      /게시 요청의 응답을 받지 못했어요. 게시가 실패했다는 뜻은 아니에요./,
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "결과 다시 확인" }).click();
  await expect(
    page.getByText("게시했어요. 앱의 다음 갱신 때 반영돼요."),
  ).toBeVisible();
  expect(calls.writes).toHaveLength(2);
  expect(calls.writes[1]!.key).toBe(calls.writes[0]!.key);
});

test("되돌리기: 바뀌는 공지를 보여 주고 '되돌리기'를 입력해야 실행되며 고른 버전으로 작업을 만든다", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockPublish(page, {
    rollbackPreview: (v) => ({
      available: true,
      version: v,
      items: [{ id: "n-maint", change: "restore", title: "새벽 점검 예고" }],
    }),
    jobs: () =>
      job({
        action: "rollback",
        target: V1,
        state: "done",
        result: "published",
      }),
  });
  await openPublish(page);
  await history(page)
    .nth(2)
    .getByRole("button", { name: /되돌리기/ })
    .click();
  const dialog = page.getByRole("dialog", { name: /게시본으로 되돌릴까요\?/ });
  await expect(dialog).toContainText("그 뒤에 바뀐 공지 1건");
  await expect(dialog).toContainText('공지 "새벽 점검 예고" 그때 문구로');
  await expect(dialog).toContainText(
    "특보·관측값은 지금 수집한 최신 값 그대로예요.",
  );
  await expect(dialog.getByRole("button", { name: "취소" })).toBeFocused();
  const confirm = dialog.getByRole("button", { name: "되돌리기" });
  await expect(confirm).toBeDisabled();
  await dialog
    .getByLabel('확인을 위해 "되돌리기"를 입력해 주세요')
    .fill("되돌리");
  await expect(confirm).toBeDisabled();
  await dialog
    .getByLabel('확인을 위해 "되돌리기"를 입력해 주세요')
    .fill("되돌리기");
  await expectNoA11yViolations(page);
  await confirm.click();
  await expect(page.getByText(/되돌리기 작업 ·/)).toBeVisible();
  expect(calls.writes[0]!.body).toEqual({ action: "rollback", version: V1 });
});

test("공지 기록이 없는 게시본은 되돌리기를 실행할 수 없다고 알린다", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockPublish(page, {
    rollbackPreview: (v) => ({ available: false, version: v }),
  });
  await openPublish(page);
  await history(page)
    .nth(2)
    .getByRole("button", { name: /되돌리기/ })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("공지 기록이 없어 되돌릴 수 없어요");
  await dialog
    .getByLabel('확인을 위해 "되돌리기"를 입력해 주세요')
    .fill("되돌리기");
  await expect(dialog.getByRole("button", { name: "되돌리기" })).toBeDisabled();
  expect(calls.writes).toHaveLength(0);
});

test("진행 중인 작업이 있으면 지금 게시·되돌리기를 잠그고 이유를 보여 준다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, {
    overview: () =>
      overview({ latestJob: { ok: true, job: job({ state: "running" }) } }),
    jobs: () => job({ state: "running" }),
  });
  await openPublish(page);
  await expect(page.getByRole("button", { name: "지금 게시" })).toBeDisabled();
  await expect(
    page.getByText(
      "게시 중이에요 · 끝나면 지금 게시·되돌리기를 다시 쓸 수 있어요",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("이 화면을 닫아도 게시는 계속돼요.", { exact: false }),
  ).toBeVisible();
});

test(
  "편집 권한은 지금 게시·되돌리기·다시 적용을 비활성으로 두고 노출 변경 권한이 필요하다고 알린다",
  { tag: "@smoke" },
  async ({ page }) => {
    await signIn(page, ["editor"]);
    await mockPublish(page);
    await openPublish(page);
    await expect(
      page.getByRole("button", { name: "지금 게시" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "다시 적용" }),
    ).toBeDisabled();
    await expect(
      history(page)
        .nth(2)
        .getByRole("button", { name: /되돌리기/ }),
    ).toBeDisabled();
    await expect(
      page.getByText(
        '"노출 변경" 권한이 필요해요. 운영 책임자에게 요청해 주세요.',
      ),
    ).toBeVisible();
  },
);

test("다시 적용: 확인 창에서 취소에 먼저 포커스하고, 확인하면 되돌림 포인터 version을 보내 다음 게시 때 반영된다고 알린다", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockPublish(page);
  await openPublish(page);
  const trigger = page.getByRole("button", { name: "다시 적용" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /다시 적용할까요\?/ });
  await expect(dialog.getByRole("button", { name: "취소" })).toBeFocused();
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(calls.writes).toHaveLength(0);

  await trigger.click();
  await dialog.getByRole("button", { name: "다시 적용" }).click();
  await expect(
    page.getByText("다시 적용했어요 · 다음 게시 때 앱에 반영돼요"),
  ).toBeVisible();
  expect(calls.writes[0]).toMatchObject({
    path: "/ops/publish/holds/n-held/reapply",
    body: { version: 4 },
  });
});

test("변경 미리보기: 분류별 수와 바뀌는 해변(사유 먼저)을 보여 주고, 만들지 못하면 다시 시도를 준다", async ({
  page,
}) => {
  await signIn(page);
  let fail = true;
  await mockPublish(page, {
    preview: () =>
      fail
        ? { ok: false, reason: "timeout" }
        : {
            ok: true,
            preview: {
              status: "ready",
              at: iso(base + 4 * MINUTE),
              current: { version: V0, counts, readable: true, missing: false },
              next: {
                counts: { clear: 179, unavailable: 24, undetermined: 3 },
              },
              changed: [
                {
                  id: "b0001",
                  before: { category: "clear", reasons: [] },
                  after: {
                    category: "unavailable",
                    reasons: [
                      { code: "warning", type: "wind_wave", level: "advisory" },
                    ],
                  },
                },
              ],
              changedCount: 1,
              checks: { beachIds: null, expected: 206, contractErrors: 0 },
            },
          },
  });
  await openPublish(page);
  const previewTrigger = page.getByRole("button", { name: "변경 미리보기" });
  await previewTrigger.click();
  const panel = page.getByRole("dialog", { name: "변경 미리보기" });
  await expect(panel).toContainText("미리보기가 늦어져 멈췄어요");
  fail = false;
  await panel.getByRole("button", { name: "다시 시도" }).click();
  await expect(panel).toContainText("강문해수욕장");
  await expect(panel).toContainText("풍랑주의보 · 이용불가");
  await expect(
    panel.getByRole("row", { name: /이용불가 23 24 \+1/ }),
  ).toBeVisible();
  await expect(panel).toContainText("판단 상태는 특보·관측값으로만 바뀌어요");
  await expectNoA11yViolations(page);
  await panel.getByRole("button", { name: "미리보기 닫기" }).focus();
  await page.keyboard.press("Shift+Tab");
  const focusedInBackground = await page.evaluate(() => {
    const active = document.activeElement;
    const dialog = document.querySelector("dialog[open]");
    return (
      active !== null &&
      active !== document.body &&
      dialog !== null &&
      !dialog.contains(active)
    );
  });
  expect(focusedInBackground).toBe(false);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(previewTrigger).toBeFocused();
});

test("칸을 읽지 못하면 '확인 못 함'으로 알리고 빈 목록처럼 보이지 않는다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, {
    overview: () =>
      overview({
        history: { ok: false },
        pendingNotices: { ok: false },
      }),
  });
  await openPublish(page);
  await expect(
    page.getByText(
      "게시 기록을 불러오지 못했어요 · 앱 사용자 화면에는 영향이 없어요",
    ),
  ).toBeVisible();
  await expect(
    page
      .getByText(
        "대기 중인 변경을 불러오지 못했어요 · 앱 사용자 화면에는 영향이 없어요",
      )
      .first(),
  ).toBeVisible();
  await expect(page.getByText("아직 게시 기록이 없어요")).toHaveCount(0);
});

test(
  "데모 계정은 데이터 게시를 볼 수 없다고 알리고 운영 API를 부르지 않는다",
  { tag: "@smoke" },
  async ({ page }) => {
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
    const calls = await mockPublish(page);
    await signInWithPassword(page, "/login/demo/", OPS);
    await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
    await openPublish(page);
    await expect(
      page.getByText("데모 계정은 데이터 게시 화면을 볼 수 없어요."),
    ).toBeVisible();
    expect(calls.overviews).toBe(0);
  },
);

test("다른 운영자가 연 진행 중 작업은 이 탭의 끝난 작업보다 먼저 보여 주고 버튼을 잠근다", async ({
  page,
}) => {
  await signIn(page);
  let other = false;
  await mockPublish(page, {
    overview: () =>
      overview({
        latestJob: {
          ok: true,
          job: other
            ? job({ jobId: "j-bbbbbbbbbbbb", state: "running" })
            : null,
        },
      }),
    jobs: () => job({ state: "done", result: "published" }),
  });
  await openPublish(page);
  await page.getByRole("button", { name: "지금 게시" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "지금 게시" })
    .click();
  await expect(
    page.getByText("게시했어요. 앱의 다음 갱신 때 반영돼요."),
  ).toBeVisible();
  // 다른 운영자가 새 작업을 시작한 뒤, 이 탭이 게시 현황을 다시 읽음(다시 적용 뒤 다시 읽기)
  // 새로고침하지 않으므로 이 탭의 끝난 작업은 메모리에 남아 있음
  other = true;
  await page.getByRole("button", { name: "다시 적용" }).click();
  await page
    .getByRole("dialog", { name: /다시 적용할까요\?/ })
    .getByRole("button", { name: "다시 적용" })
    .click();
  await expect(
    page.getByText("다시 적용했어요 · 다음 게시 때 앱에 반영돼요"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "지금 게시" })).toBeDisabled();
  await expect(page.getByText("게시 중이에요", { exact: true })).toBeVisible();
});

test("작업 조회가 한 번 실패해도 다시 조회하고, 기록이 없으면 멈추고 결과를 알 수 없다고 알린다", async ({
  page,
}) => {
  await signIn(page);
  let polls = 0;
  await mockPublish(page);
  // 상태 조회만 따로: 첫 번째는 서버 오류, 두 번째는 게시 완료
  await page.route(/\/ops\/publish\/jobs\/j-/, async (route) => {
    polls += 1;
    if (polls === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal", requestId: null } }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        jobId: "j-0123456789ab",
        job: job({ state: "done", result: "published" }),
      }),
    });
  });
  await openPublish(page);
  await page.getByRole("button", { name: "지금 게시" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "지금 게시" })
    .click();
  await expect(
    page.getByText("게시했어요. 앱의 다음 갱신 때 반영돼요."),
  ).toBeVisible({ timeout: 15_000 });
  expect(polls).toBe(2);
});

test("작업 기록이 없어지면(404) 조회를 멈추고 결과를 알 수 없다고 알린다", async ({
  page,
}) => {
  await signIn(page);
  let polls = 0;
  await mockPublish(page);
  await page.route(/\/ops\/publish\/jobs\/j-/, async (route) => {
    polls += 1;
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "not_found", requestId: null } }),
    });
  });
  await openPublish(page);
  await page.getByRole("button", { name: "지금 게시" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "지금 게시" })
    .click();
  await expect(
    page.getByText("결과를 알 수 없어요. 게시 기록에서 확인해 주세요."),
  ).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(4_000);
  expect(polls).toBe(1);
});

test("대기 공지를 읽지 못하면 지금 게시 확인 창에 그 사실을 함께 알린다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, {
    overview: () => overview({ pendingNotices: { ok: false } }),
  });
  await openPublish(page);
  await page.getByRole("button", { name: "지금 게시" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "대기 중인 변경을 불러오지 못해 무엇이 함께 나가는지 보여 드리지 못해요.",
  );
});

test("게시 기록 페이징과 실패 행 '이유' 펼치기·접기가 동작한다", async ({
  page,
}) => {
  await signIn(page);
  const items = Array.from({ length: 12 }, (_, idx) => {
    const atMs = base - idx * 5 * MINUTE;
    if (idx === 1) {
      return {
        result: "failed",
        version: version(atMs),
        at: iso(atMs),
        source: "auto",
        reason: "beach_ids",
      };
    }
    if (idx === 6) {
      return {
        result: "failed",
        version: version(atMs),
        at: iso(atMs),
        source: "auto",
        reason: "contract",
      };
    }
    return {
      result: "published",
      version: version(atMs),
      at: iso(atMs),
      source: "auto",
      beachCount: 206,
      changes: {
        notices: false,
        categoryCounts: counts,
        categoryDelta: { clear: 0, unavailable: 0, undetermined: 0 },
        delayedBeaches: 0,
        delayedDelta: 0,
      },
      gapBefore: false,
    };
  });
  await mockPublish(page, {
    overview: () => overview({ history: { ok: true, items } }),
  });
  await openPublish(page);

  await expect(history(page)).toHaveCount(5);
  const pager = page.getByRole("navigation", { name: "게시 기록 페이지" });
  await expect(pager).toContainText("12건 중 1–5");
  await expect(
    pager.getByRole("button", { name: "이전 게시 기록 페이지" }),
  ).toBeDisabled();

  // 1페이지 실패 행은 기본 선택되어 '닫기' 상태, 누르면 접히고 다시 '이유'로 바뀐다
  const togglePage1 = history(page)
    .nth(1)
    .getByRole("button", { name: /닫기|이유/ });
  await expect(togglePage1).toHaveAttribute("aria-expanded", "true");
  await togglePage1.click();
  await expect(togglePage1).toHaveAttribute("aria-expanded", "false");
  await togglePage1.click();
  await expect(togglePage1).toHaveAttribute("aria-expanded", "true");

  await pager.getByRole("button", { name: "다음 게시 기록 페이지" }).click();
  await expect(pager).toContainText("12건 중 6–10");
  await expect(history(page)).toHaveCount(5);
  const togglePage2 = history(page)
    .nth(1)
    .getByRole("button", { name: /이유|닫기/ });
  await togglePage2.click();
  const checksRegion = page.getByRole("region", { name: /검증 결과/ });
  await expect(checksRegion).toBeVisible();
  await expect(checksRegion).toContainText("데이터 형식 검사 실패");

  await pager.getByRole("button", { name: "다음 게시 기록 페이지" }).click();
  await expect(pager).toContainText("12건 중 11–12");
  await expect(history(page)).toHaveCount(2);
  await expect(
    pager.getByRole("button", { name: "다음 게시 기록 페이지" }),
  ).toBeDisabled();
});

test("지금 게시 확인 창은 Esc로 닫으면 누른 버튼으로 포커스가 돌아온다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page);
  await openPublish(page);

  const publishTrigger = page.getByRole("button", { name: "지금 게시" });
  await publishTrigger.click();
  const dialog = page.getByRole("dialog", {
    name: "대기 중인 변경 1건을 지금 게시할까요?",
  });
  await expect(dialog.getByRole("button", { name: "취소" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(publishTrigger).toBeFocused();
});

test("편집 권한(editor)은 데이터 게시를 볼 수 있지만 지금 게시·되돌리기·다시 적용이 비활성이다", async ({
  page,
}) => {
  await signIn(page, ["editor"]);
  await mockPublish(page);
  await openPublish(page);

  await expect(page.getByRole("button", { name: "지금 게시" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "다시 적용" })).toBeDisabled();
  await expect(
    history(page).nth(2).getByRole("button", { name: /되돌리기/ }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      '"노출 변경" 권한이 필요해요. 운영 책임자에게 요청해 주세요.',
    ),
  ).toBeVisible();
});

test("앱 설정이 응답에 있는데 비었거나 형식이 틀리면 '확인 못 함'을 표시한다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, {
    overview: () => overview({ settings: {} }),
  });
  await openPublish(page);

  await expect(page.getByText("서비스 점검 확인 못 함")).toBeVisible();
  await expect(page.getByText("최소 화면 버전 확인 못 함")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "GitHub에서 보기" }),
  ).toBeVisible();
});

test("같은 version을 가진 성공·실패 기록이 있어도 실패 행 선택 시 실패 검증 결과를 표시한다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, {
    overview: () =>
      overview({
        history: {
          ok: true,
          items: [
            {
              result: "published",
              version: V0,
              at: iso(base),
              source: "auto",
              beachCount: 206,
              changes: {
                notices: false,
                categoryCounts: counts,
                categoryDelta: { clear: 0, unavailable: 0, undetermined: 0 },
                delayedBeaches: 0,
                delayedDelta: 0,
              },
              gapBefore: false,
            },
            {
              result: "failed",
              version: V0,
              at: iso(base),
              source: "auto",
              reason: "beach_ids",
            },
          ],
        },
      }),
  });
  await openPublish(page);

  const checksRegion = page.getByRole("region", { name: /검증 결과/ });
  await expect(checksRegion).toContainText("실패 사유");
  await expect(checksRegion).toContainText(
    "해변 ID 대조 불일치(누락·추가·중복)",
  );
  await expect(checksRegion).not.toContainText("검증 통과");
});

test("미리보기에서 게시 확인 창으로 이동했다가 취소하면 변경 미리보기 버튼으로 포커스가 돌아간다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, {
    preview: () => ({
      status: 200,
      body: {
        generatedAt: "2026-11-13T10:30:00.000Z",
        sourceAt: "2026-11-13T10:25:00.000Z",
        counts,
        nextCounts: { clear: 180, unavailable: 24, undetermined: 2 },
        changes: [],
        changedCount: 0,
        checks: { beachIds: null, expected: 206, contractErrors: 0 },
      },
    }),
  });
  await openPublish(page);

  const previewTrigger = page.getByRole("button", { name: "변경 미리보기" });
  await previewTrigger.click();
  const panel = page.getByRole("dialog", { name: "변경 미리보기" });
  await expect(panel).toBeVisible();

  await panel.getByRole("button", { name: "지금 게시" }).click();
  const confirmDialog = page.getByRole("dialog");
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole("button", { name: "취소" }).click();

  await expect(previewTrigger).toBeFocused();
});
