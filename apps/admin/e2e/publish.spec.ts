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
import {
  localSiteDeployView,
  type LocalDeployScenario,
} from "../src/lib/auth/local-site-deploy";

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
    // 사이트 배포 칸(#472). 기본은 로컬 예시 ready. n은 몇 번째 조회인지(1부터)
    siteDeploy?: (n: number) => { status: number; body: unknown } | "hold";
  } = {},
) {
  const calls = {
    writes: [] as Write[],
    overviews: 0,
    previews: 0,
    siteDeploys: 0,
  };
  await page.route(/\/ops\/site-deploy$/, async (route: Route) => {
    calls.siteDeploys += 1;
    const reply = options.siteDeploy?.(calls.siteDeploys) ?? {
      status: 200,
      body: localSiteDeployView("ready", Date.now()),
    };
    // 응답을 보내지 않음(로딩·시간 제한 시험)
    if (reply === "hold") return;
    await route.fulfill({
      status: reply.status,
      contentType: "application/json",
      body: JSON.stringify(reply.body),
    });
  });
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

// ---- 사이트 배포 칸 (#472, 결정 기록 D27 · 화면 설계서 ADM-PUB '사이트 배포') ----
// 응답은 로컬 예시(src/lib/auth/local-site-deploy)와 같은 모양. 상황별로 고름

const deployReply = (scenario: LocalDeployScenario) => () => ({
  status: 200,
  body: localSiteDeployView(scenario, Date.now()),
});
const deployFail = {
  status: 500,
  body: { error: { code: "internal", requestId: "req-site-deploy" } },
};
const siteDeploy = (page: Page) =>
  page.getByRole("region", { name: "사이트 배포" });
const READY_TEXT = /배포할 수 있어요/;

test(
  "사이트 배포: 배포 가능 상태·사이트별 배포 커밋·바뀐 파일·커밋 목록·CI·다음 정기 배포·수동 요청 수·GitHub 링크·토큰 만료를 보여 준다",
  { tag: "@smoke" },
  async ({ page }) => {
    await signIn(page);
    await mockPublish(page);
    await openPublish(page);
    const region = siteDeploy(page);
    await expect(
      region.getByText(
        "데이터 게시는 특보·공지(수집 뒤 게시), 사이트 배포는 코드·해변 정보(하루 1번)",
      ),
    ).toBeVisible();
    await expect(
      region.getByText("main 최신 커밋을 배포할 수 있어요"),
    ).toBeVisible();
    await expect(region.getByText(/^\d{2}:\d{2} 조회 기준$/)).toBeVisible();

    const site = region.getByRole("region", { name: "사용자 사이트" });
    await expect(site.getByRole("link", { name: /^0000000/ })).toHaveAttribute(
      "href",
      /\/commit\/0000000c+$/,
    );
    await expect(site.getByRole("link", { name: /^GH-449/ })).toHaveAttribute(
      "href",
      /\/issues\/449$/,
    );
    await expect(
      site.getByText(/^\d{2}:\d{2} 확인 · 수동 배포 · /),
    ).toBeVisible();
    await expect(
      site.getByRole("link", { name: /^실행 보기/ }),
    ).toHaveAttribute("href", /\/actions\/runs\/9001$/);
    // 운영자 사이트는 실행과 표지가 맞지 않아 실행 방식·시각을 숨김
    const admin = region.getByRole("region", { name: "운영자 사이트" });
    await expect(admin.getByText(/^\d{2}:\d{2} 확인$/)).toBeVisible();
    await expect(admin.getByRole("link", { name: /^실행 보기/ })).toHaveCount(
      0,
    );

    // 바뀐 파일: 접힌 목록을 펼치면 분류 칩과 경로
    const files = site.getByText("바뀐 파일 4개 · 파일 목록");
    await expect(site.getByText("data/beaches/b0001.json")).toBeHidden();
    await files.click();
    await expect(site.getByText("data/beaches/b0001.json")).toBeVisible();
    for (const chip of ["해변 정보", "사용자 화면", "공통"]) {
      await expect(site.getByText(chip, { exact: true }).first()).toBeVisible();
    }
    await admin.getByText("바뀐 파일 2개 · 파일 목록").click();
    await expect(admin.getByText("운영 화면", { exact: true })).toBeVisible();
    await expect(
      admin.getByText(
        "apps/admin/src/components/notice-list.tsx에서 이름 바뀜",
      ),
    ).toBeVisible();

    // 커밋 목록은 하나로, 기본은 접힘 → '커밋 N개 보기'로 펼침(최대 10개, 넘치면 GitHub에서 전체 보기)
    const commits = region.getByRole("region", { name: "아직 안 나간 커밋" });
    await expect(commits.getByText("12개", { exact: true })).toBeVisible();
    const showCommits = commits.getByRole("button", { name: "커밋 12개 보기" });
    await expect(showCommits).toHaveAttribute("aria-expanded", "false");
    await expect(commits.locator("li")).toHaveCount(0);
    await showCommits.click();
    await expect(showCommits).toHaveAttribute("aria-expanded", "true");
    await expect(commits.locator("li")).toHaveCount(10);
    await expect(
      commits.getByRole("link", {
        name: /최근 10개만 보여요 · GitHub에서 전체 보기/,
      }),
    ).toHaveAttribute("href", /\/compare\/0000000c+\.\.\.000000cc+$/);

    await expect(region.getByText("통과", { exact: true })).toBeVisible();
    await expect(region.getByText(/^(오늘|내일) 05:17$/)).toBeVisible();
    await expect(
      region.getByText("오늘 수동 배포 요청 2회 · 1회 약 US$0.017"),
    ).toBeVisible();
    await expect(region.getByText(/실패·취소한 요청도 세요/)).toBeVisible();

    const open = region.getByRole("link", { name: /GitHub에서 배포 열기/ });
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("rel", /noopener/);
    await expect(open).toHaveAttribute(
      "href",
      "https://github.com/404soonotfound/baradun_v2/actions/workflows/deploy.yml",
    );
    await expect(
      region.getByText(
        "Run workflow → 브랜치 main으로 실행해요. 실행 전에 대상 커밋이 위 SHA와 같은지 확인하세요. 그사이 새 변경이 머지됐으면 그 커밋이 배포돼요.",
      ),
    ).toBeVisible();
    await expect(
      region.getByText(/^GitHub 조회 토큰 · 만료 \d{4}-\d{2}-\d{2}$/),
    ).toBeVisible();
    await expect(region.getByText(/만료 임박/)).toHaveCount(0);
    await expect(
      region.getByText("화면이 보이는 동안 1분마다 다시 읽어요"),
    ).toBeVisible();
    await expectNoA11yViolations(page);
  },
);

test("사이트 배포: 'GitHub에서 배포 열기'는 새 탭으로 열리고 지금 화면은 그대로다", async ({
  page,
}) => {
  await page.context().route("https://github.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<p>ok</p>",
    }),
  );
  await signIn(page);
  await mockPublish(page);
  await openPublish(page);
  const popup = page.waitForEvent("popup");
  await siteDeploy(page)
    .getByRole("link", { name: /GitHub에서 배포 열기/ })
    .click();
  const tab = await popup;
  expect(tab.url()).toContain("/actions/workflows/deploy.yml");
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await expect(
    page.getByRole("heading", { name: "데이터 게시", level: 1 }),
  ).toBeVisible();
});

test("사이트 배포: 배포 진행 중이면 실행 링크와 30초 다시 읽기를 보이고 '배포할 수 있어요'는 띄우지 않는다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, { siteDeploy: deployReply("deploying") });
  await openPublish(page);
  const region = siteDeploy(page);
  await expect(region.getByText("배포가 진행 중이에요")).toBeVisible();
  await expect(
    region.getByRole("link", { name: /^실행 보기/ }).first(),
  ).toHaveAttribute("href", /\/actions\/runs\/9002$/);
  await expect(region.getByText(/30초마다 다시 읽어요/)).toBeVisible();
  await expect(region.getByText(READY_TEXT)).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test("사이트 배포: 일시 정지면 수동 배포도 새로 시작하지 않는다고 알리고 정기 배포 멈춤을 보인다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, { siteDeploy: deployReply("paused") });
  await openPublish(page);
  const region = siteDeploy(page);
  await expect(region.getByText("배포가 멈춰 있어요(일시 정지)")).toBeVisible();
  await expect(
    region.getByText("정지를 풀기 전에는 수동 배포도 새로 시작하지 않아요"),
  ).toBeVisible();
  await expect(region.getByText("정기 배포 멈춤")).toBeVisible();
  await expect(region.getByText(READY_TEXT)).toHaveCount(0);
});

test("사이트 배포: CI가 끝나지 않았으면 그 상태와 CI '진행 중'을 보인다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, { siteDeploy: deployReply("ci_pending") });
  await openPublish(page);
  const region = siteDeploy(page);
  await expect(region.getByText("CI가 끝나지 않았어요")).toBeVisible();
  await expect(region.getByText("진행 중", { exact: true })).toBeVisible();
  await expect(region.getByText(READY_TEXT)).toHaveCount(0);
});

test("사이트 배포: 일부를 확인하지 못하면 0건·정상이 아니라 사유와 마지막으로 확인한 값을 보인다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, { siteDeploy: deployReply("partial") });
  await openPublish(page);
  const region = siteDeploy(page);
  await expect(
    region.getByText("GitHub 상태를 확인하지 못했어요"),
  ).toBeVisible();
  await expect(region.getByText(READY_TEXT)).toHaveCount(0);
  const site = region.getByRole("region", { name: "사용자 사이트" });
  await expect(site.getByText("변경 확인 못 함")).toBeVisible();
  await expect(
    site.getByText(/변경이 많아 다 확인하지 못했어요 · GitHub에서 확인하세요/),
  ).toBeVisible();
  await expect(site.getByText(/바뀐 파일 없음/)).toHaveCount(0);
  const admin = region.getByRole("region", { name: "운영자 사이트" });
  await expect(admin.getByText("배포 커밋 확인 못 함")).toBeVisible();
  await expect(
    admin
      .getByText(/GitHub 조회 한도에 걸렸어요 · \d{2}:\d{2} 이후 다시 확인해요/)
      .first(),
  ).toBeVisible();
  await expect(
    admin.getByText(/^마지막으로 확인한 값 · \d{2}:\d{2} 기준$/),
  ).toBeVisible();
  await expect(admin.getByText("0000005")).toBeVisible();
  await expect(
    region.getByText("오늘 수동 배포 요청 확인 못 함"),
  ).toBeVisible();
  await expect(
    region.getByText("오늘 수동 배포 요청 1회 · 1회 약 US$0.017"),
  ).toBeVisible();
  // 두 사이트 모두 변경을 확인하지 못함 → 커밋 목록도 빈 목록이 아니라 확인 못 함
  await expect(region.getByText("커밋 목록 확인 못 함")).toBeVisible();
  await expect(region.getByText("아직 안 나간 커밋이 없어요")).toHaveCount(0);
  await expect(region.getByText("만료 임박 · 20일 남음")).toBeVisible();
  await expectNoA11yViolations(page);
});

test("사이트 배포: 운영자 사이트 주소가 설정되지 않으면 그 사이트만 '설정이 필요해요'", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, { siteDeploy: deployReply("admin_unconfigured") });
  await openPublish(page);
  const region = siteDeploy(page);
  const admin = region.getByRole("region", { name: "운영자 사이트" });
  await expect(admin.getByText("배포 커밋 확인 못 함")).toBeVisible();
  await expect(admin.getByText(/설정이 필요해요/).first()).toBeVisible();
  await expect(
    region
      .getByRole("region", { name: "사용자 사이트" })
      .getByText("바뀐 파일 4개 · 파일 목록"),
  ).toBeVisible();
  // 한 사이트만 확인함 → 커밋 목록은 보이되 전부가 아닐 수 있다고 알리고 개수는 숨김
  await expect(
    region.getByText(
      "변경을 확인하지 못한 사이트가 있어 목록이 전부가 아닐 수 있어요",
    ),
  ).toBeVisible();
  await expect(
    region
      .getByRole("region", { name: "아직 안 나간 커밋" })
      .getByText("12개", { exact: true }),
  ).toHaveCount(0);
  // 단추도 전부인 것처럼 보이지 않게 '확인한 커밋'으로
  await expect(
    region.getByRole("button", { name: "확인한 커밋 12개 보기" }),
  ).toBeVisible();
  await expect(region.getByText(READY_TEXT)).toHaveCount(0);
});

test("사이트 배포: 응답 모양이 틀리면 칸마다 확인 못 함으로 보이고 GitHub 링크를 숨긴다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, {
    siteDeploy: () => ({
      status: 200,
      body: {
        generatedAt: new Date().toISOString(),
        readiness: "ready",
        workflowUrl: "javascript:alert(1)",
      },
    }),
  });
  await openPublish(page);
  const region = siteDeploy(page);
  await expect(
    region.getByText("GitHub 상태를 확인하지 못했어요"),
  ).toBeVisible();
  await expect(region.getByText(READY_TEXT)).toHaveCount(0);
  await expect(region.getByText("배포 커밋 확인 못 함")).toHaveCount(2);
  await expect(region.getByText("변경 확인 못 함")).toHaveCount(2);
  await expect(region.getByText("커밋 목록 확인 못 함")).toBeVisible();
  await expect(region.getByText("확인 못 함", { exact: true })).toBeVisible();
  await expect(
    region.getByText("GitHub 배포 화면 주소를 확인하지 못했어요"),
  ).toBeVisible();
  // 정기 배포 시각이 없어도 설정을 확인하지 못했으면 '멈춤'이 아니라 확인 못 함
  await expect(region.getByText("다음 정기 배포 확인 못 함")).toBeVisible();
  await expect(region.getByText("정기 배포 멈춤")).toHaveCount(0);
  await expect(
    region.getByRole("link", { name: /GitHub에서 배포 열기/ }),
  ).toHaveCount(0);
});

test("사이트 배포: 불러오지 못하면 무슨 일·영향·다음 행동을 알리고 '다시 불러오기'로 다시 읽는다", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockPublish(page, {
    siteDeploy: (n) => (n === 1 ? deployFail : deployReply("ready")()),
  });
  await openPublish(page);
  const region = siteDeploy(page);
  const alert = region.getByRole("alert");
  await expect(alert).toContainText("배포 정보를 불러오지 못했어요");
  await expect(alert).toContainText(
    "지금 사이트 반영 상태는 확인하지 못했어요",
  );
  await expect(alert).toContainText(
    "잠시 뒤 다시 불러오거나 GitHub에서 확인해 주세요",
  );
  await expect(alert).toContainText("req-site-deploy");
  await expect(region.getByText(READY_TEXT)).toHaveCount(0);
  await region.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(
    region.getByText("main 최신 커밋을 배포할 수 있어요"),
  ).toBeVisible();
  await expect(alert).toHaveCount(0);
  expect(calls.siteDeploys).toBe(2);
});

test("사이트 배포: 200이어도 본문을 읽을 수 없으면(생성 시각 없음) 확인 시각을 지어내지 않고 실패 문구", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, {
    siteDeploy: () => ({ status: 200, body: null }),
  });
  await openPublish(page);
  const region = siteDeploy(page);
  await expect(region.getByRole("alert")).toContainText(
    "배포 정보를 불러오지 못했어요",
  );
  await expect(region.getByText(/조회 기준/)).toHaveCount(0);
  await expect(region.getByText(READY_TEXT)).toHaveCount(0);
});

test("사이트 배포: 배포 커밋은 확인했고 커밋 제목만 못 읽으면 확인한 SHA는 그대로 보인다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, {
    siteDeploy: () => {
      const body = localSiteDeployView("ready", Date.now());
      const site = (body.sites as Record<string, unknown>[])[0]!;
      site.detail = {
        status: "unknown",
        reason: "timeout",
        checkedAt: new Date().toISOString(),
      };
      return { status: 200, body };
    },
  });
  await openPublish(page);
  const site = siteDeploy(page).getByRole("region", { name: "사용자 사이트" });
  await expect(site.getByRole("link", { name: /^0000000/ })).toBeVisible();
  await expect(site.getByText("커밋 제목 확인 못 함")).toBeVisible();
  await expect(site.getByText("배포 커밋 확인 못 함")).toHaveCount(0);
  await expect(siteDeploy(page).getByText(READY_TEXT)).toHaveCount(0);
});

test("사이트 배포: 다시 읽기가 실패해도 앞 값을 그대로 두고 언제 받은 값인지 알린다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, {
    siteDeploy: (n) => (n === 1 ? deployReply("ready")() : deployFail),
  });
  await openPublish(page);
  const region = siteDeploy(page);
  await expect(
    region.getByText("main 최신 커밋을 배포할 수 있어요"),
  ).toBeVisible();
  await region.getByRole("button", { name: "다시 불러오기" }).click();
  await expect(region.getByRole("alert")).toContainText(
    /아래는 \d{2}:\d{2}에 마지막으로 받은 값이에요/,
  );
  // 앞 값(커밋·파일)은 남기되, 지금 상태로 단정하는 '배포할 수 있어요'는 내림(D27-3)
  await expect(
    region.getByText("지금 배포 상태를 확인하지 못했어요"),
  ).toBeVisible();
  await expect(region.getByText(READY_TEXT)).toHaveCount(0);
  await expect(
    region
      .getByRole("region", { name: "사용자 사이트" })
      .getByText("바뀐 파일 4개 · 파일 목록"),
  ).toBeVisible();
});

test("사이트 배포: 응답이 15초 넘게 없으면 자리표시 대신 같은 칸 안에서 실패 문구", async ({
  page,
}) => {
  await page.clock.install();
  await signIn(page);
  const calls = await mockPublish(page, { siteDeploy: () => "hold" });
  await openPublish(page);
  const region = siteDeploy(page);
  await expect(
    region.getByRole("status").filter({ hasText: "사이트 배포 불러오는 중" }),
  ).toHaveCount(1);
  await page.clock.fastForward(5_100);
  await expect(region.getByText(/평소보다 오래 걸려요/)).toBeVisible();
  await page.clock.fastForward(10_000);
  await expect(region.getByRole("alert")).toContainText(
    "배포 정보를 불러오지 못했어요",
  );
  await expect(region.getByText(READY_TEXT)).toHaveCount(0);
  // 응답 없는 요청에 묶이지 않고 바로 다시 불러올 수 있음
  const reload = region.getByRole("button", { name: "다시 불러오기" });
  await expect(reload).not.toHaveAttribute("aria-disabled", "true");
  await reload.click();
  await expect.poll(() => calls.siteDeploys).toBe(2);
});

test("사이트 배포: 화면이 보이는 동안만 1분마다(진행 중이면 30초) 다시 읽고 숨은 탭은 쉰다", async ({
  page,
}) => {
  await page.clock.install();
  await signIn(page);
  let scenario: LocalDeployScenario = "ready";
  const calls = await mockPublish(page, {
    siteDeploy: () => deployReply(scenario)(),
  });
  await openPublish(page);
  await expect(
    siteDeploy(page).getByText("main 최신 커밋을 배포할 수 있어요"),
  ).toBeVisible();
  expect(calls.siteDeploys).toBe(1);

  await page.clock.fastForward(30_000);
  expect(calls.siteDeploys).toBe(1);
  await page.clock.fastForward(31_000);
  await expect.poll(() => calls.siteDeploys).toBe(2);

  // 진행 중으로 바뀌면 다음부터 30초
  scenario = "deploying";
  await page.clock.fastForward(61_000);
  await expect.poll(() => calls.siteDeploys).toBe(3);
  await expect(
    siteDeploy(page).getByText("배포가 진행 중이에요"),
  ).toBeVisible();
  await page.clock.fastForward(31_000);
  await expect.poll(() => calls.siteDeploys).toBe(4);

  // 숨은 탭은 쉼 → 다시 보이면 바로 읽음
  const setVisibility = (state: "hidden" | "visible") =>
    page.evaluate((value) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => value,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, state);
  await setVisibility("hidden");
  await page.clock.fastForward(5 * 60_000);
  expect(calls.siteDeploys).toBe(4);
  await setVisibility("visible");
  await expect.poll(() => calls.siteDeploys).toBe(5);
});

test("사이트 배포: 키보드로 다시 불러오기·파일 목록 펼치기·링크에 닿는다", async ({
  page,
}) => {
  await signIn(page);
  const calls = await mockPublish(page);
  await openPublish(page);
  const region = siteDeploy(page);
  await expect(
    region.getByText("main 최신 커밋을 배포할 수 있어요"),
  ).toBeVisible();
  const reload = region.getByRole("button", { name: "다시 불러오기" });
  await reload.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => calls.siteDeploys).toBe(2);

  const site = region.getByRole("region", { name: "사용자 사이트" });
  const summary = site.locator("summary");
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(site.getByText("data/beaches/b0001.json")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(site.getByText("data/beaches/b0001.json")).toBeHidden();

  // 커밋 목록 펼치기 단추: Enter·Space로 펼치고 접으며 aria-expanded가 따라감
  const showCommits = region.getByRole("button", { name: "커밋 12개 보기" });
  await showCommits.focus();
  await page.keyboard.press("Enter");
  await expect(showCommits).toHaveAttribute("aria-expanded", "true");
  await expect(
    region.getByRole("region", { name: "아직 안 나간 커밋" }).locator("li"),
  ).toHaveCount(10);
  await page.keyboard.press("Space");
  await expect(showCommits).toHaveAttribute("aria-expanded", "false");
  await expect(showCommits).toBeFocused();

  const open = region.getByRole("link", { name: /GitHub에서 배포 열기/ });
  await open.focus();
  await expect(open).toBeFocused();
  // 새 탭임을 접근 가능한 이름으로 알림
  await expect(open).toHaveAccessibleName(/새 탭에서 열림/);
});

test("사이트 배포: 보기 권한(viewer)도 볼 수 있다", async ({ page }) => {
  await signIn(page, ["viewer"]);
  await mockPublish(page);
  await openPublish(page);
  await expect(
    siteDeploy(page).getByText("main 최신 커밋을 배포할 수 있어요"),
  ).toBeVisible();
});

test("사이트 배포: 데모 계정은 '실제 운영자만 볼 수 있어요' 한 줄만 보이고 요청하지 않는다", async ({
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
  const calls = await mockPublish(page);
  await signInWithPassword(page, "/login/demo/", OPS);
  await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
  await openPublish(page);
  const region = siteDeploy(page);
  await expect(region.getByText("실제 운영자만 볼 수 있어요")).toBeVisible();
  await expect(
    region.getByRole("button", { name: "다시 불러오기" }),
  ).toHaveCount(0);
  expect(calls.siteDeploys).toBe(0);
  await expectNoA11yViolations(page);
});

test("사이트 배포: 배포할 수 있어도 두 사이트가 이미 main 최신이면 바뀌는 것이 없다고 함께 알린다", async ({
  page,
}) => {
  await signIn(page);
  await mockPublish(page, {
    siteDeploy: () => {
      const body = localSiteDeployView("ready", Date.now());
      for (const site of body.sites as {
        changes: { value: { files: unknown[]; commits: unknown[] } };
      }[]) {
        site.changes.value.files = [];
        site.changes.value.commits = [];
      }
      return { status: 200, body };
    },
  });
  await openPublish(page);
  const region = siteDeploy(page);
  await expect(
    region.getByText("main 최신 커밋을 배포할 수 있어요"),
  ).toBeVisible();
  await expect(
    region.getByText(
      "두 사이트 모두 main 최신 커밋과 같아요 · 배포해도 바뀌는 것이 없어요",
    ),
  ).toBeVisible();
  await expect(region.getByText("아직 안 나간 커밋이 없어요")).toBeVisible();
  await expect(region.getByText("바뀐 파일 없음")).toHaveCount(2);
});

test("사이트 배포: 로딩 자리표시와 값이 들어온 뒤 칸 높이가 같다(차이 2px 이하)", async ({
  page,
}) => {
  await signIn(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await mockPublish(page, { siteDeploy: () => "hold" });
  // 위 가짜 응답보다 나중에 건 경로가 먼저 받음: 문을 열 때까지 응답을 미룸
  await page.route(/\/ops\/site-deploy$/, async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(localSiteDeployView("ready", Date.now())),
    });
  });
  await openPublish(page);
  const region = siteDeploy(page);
  await expect(region.locator(".sk").first()).toBeVisible();
  const loading = (await region.boundingBox())!.height;
  release();
  await expect(region.getByText(/조회 기준/)).toBeVisible();
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) =>
          a.playState !== "running" ||
          a.effect?.getTiming().iterations === Infinity,
      ),
  );
  const loaded = (await region.boundingBox())!.height;
  expect(Math.abs(loaded - loading)).toBeLessThanOrEqual(2);
});
