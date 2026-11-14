import type { Page } from "@playwright/test";
import { localStatsView } from "../src/lib/auth/local-stats";
import { VIEW } from "./collection-data";
import {
  ME_OK,
  expect,
  expectNoA11yViolations,
  isDesktop,
  logout,
  mockCognito,
  mockOps,
  openMenu,
  signInWithPassword,
  srpScript,
  test,
} from "./fixtures";

// 운영 홈 (BRD-149, 화면 설계서 6장 ADM-HOME). 운영 API는 가짜 응답
// 홈은 로그인하자마자 읽으므로 가짜 응답을 로그인 전에 둠(mockOps 뒤에 걸어야 먼저 받음)

const OPS = "ops@example.test";

// 판단 출처(특보·해양 관측) 둘 다 정상인 수집 현황
const VIEW_OK = {
  ...VIEW,
  jobs: VIEW.jobs.map((job) =>
    job.job === "collect-ocean" && job.lastRun
      ? { ...job, lastRun: { ...job.lastRun, status: "complete" } }
      : job,
  ),
};

const PUBLISHED = {
  available: true,
  snapshotVersion: "20261111T030000Z",
  generatedAt: "2026-11-11T03:00:12Z", // KST 11/11 12:00
  maintenance: { active: false, until: null },
  beaches: {
    b0001: {
      category: "clear",
      reasons: [],
      validUntil: "2026-11-11T04:00:00Z",
    },
    b0002: {
      category: "undetermined",
      reasons: [
        {
          code: "warning_unknown",
          scope: "강원중부앞바다",
          source: "기상청",
          at: "2026-11-11T02:30:00Z", // KST 11:30
        },
      ],
      validUntil: "2026-11-11T04:00:00Z",
    },
    b0003: {
      category: "undetermined",
      reasons: [
        {
          code: "observation_delayed",
          scope: "삼척 파고부이",
          source: "기상청",
          at: "2026-11-11T00:38:00Z", // KST 09:38
        },
      ],
      validUntil: "2026-11-11T04:00:00Z",
    },
  },
};

const notice = (id: string, state: string, pendingEdit = false) => ({
  id,
  version: 1,
  draft: {},
  live: null,
  exposedAt: null,
  updatedAt: "2026-11-11T03:00:00Z",
  state,
  pendingEdit,
  hidden: false,
});

type Reply = { status: number; body: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
const fail: Reply = {
  status: 500,
  body: { error: { code: "internal", requestId: "req-7f3a2c91" } },
};

async function mockHome(
  page: Page,
  replies: {
    collection?: Reply;
    published?: Reply;
    inquiries?: Reply;
    notices?: Reply;
    stats?: Reply;
  } = {},
) {
  const routes: [RegExp, Reply][] = [
    [/\/ops\/collection$/, replies.collection ?? ok(VIEW_OK)],
    [/\/ops\/beaches\/published$/, replies.published ?? ok(PUBLISHED)],
    [
      /\/ops\/inquiries(\?.*)?$/,
      replies.inquiries ??
        ok({
          items: [],
          nextCursor: null,
          counts: { received: 0, in_progress: 1, resolved: 3, rejected: 0 },
        }),
    ],
    [
      /\/ops\/notices$/,
      replies.notices ?? ok({ items: [notice("n1", "live")] }),
    ],
    [
      /\/ops\/stats(\?.*)?$/,
      replies.stats ??
        ok(localStatsView("28d", Date.parse("2026-11-11T03:00:00Z"))),
    ],
  ];
  for (const [pattern, reply] of routes) {
    await page.route(pattern, (route) =>
      route.fulfill({
        status: reply.status,
        contentType: "application/json",
        body: JSON.stringify(reply.body),
      }),
    );
  }
}

async function signIn(
  page: Page,
  replies: Parameters<typeof mockHome>[1] = {},
) {
  await mockCognito(
    page,
    srpScript({ email: OPS, after: "tokens", groups: ["editor"] }),
  );
  await mockOps(page, ME_OK);
  // mockOps의 홈 기본 응답보다 나중에 걸어 먼저 받게 함
  await mockHome(page, replies);
  await signInWithPassword(page, "/login/", OPS);
  await expect(
    page.getByRole("heading", { name: "운영 홈", level: 1 }),
  ).toBeVisible();
}

// 시안 V1 세 칸·판단불가 표·할 일·이용(GH-453)
const block = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

// 판단 출처 한 줄: 모바일·태블릿만 보임. PC는 왼쪽 메뉴 상태 칸이 같은 내용이라 숨김(GH-453)
async function expectSourcesLine(page: Page, text: string) {
  const line = page.getByText(text, { exact: true });
  if (isDesktop(page)) {
    await expect(line).toBeAttached();
    await expect(line).toBeHidden();
  } else {
    await expect(line).toBeVisible();
  }
}

// PC 왼쪽 메뉴 아래 상태 칸(GH-450, 시안 V1·V6). 홈과 같은 수집 현황 응답으로 판단 출처를 봄
const sideStatus = (page: Page) =>
  page.getByRole("group", { name: "운영 상태" });

test("수집 현황은 홈이 한 번 읽고, PC가 아니면 숨은 왼쪽 상태 칸은 따로 부르지 않는다", async ({
  page,
}) => {
  const calls: string[] = [];
  page.on("request", (req) => {
    if (/\/ops\/collection(\?|$)/.test(req.url())) calls.push(req.url());
  });
  await signIn(page);
  await expectSourcesLine(page, "판단에 쓰는 출처가 모두 정상이에요");
  await page.waitForTimeout(500);
  // PC는 상태 칸이 보여 한 번 더 읽음(홈 화면 요청과 따로)
  expect(calls).toHaveLength(isDesktop(page) ? 2 : 1);
});

test("모두 정상: 판단 출처 정상 한 줄(모바일만), 세 칸·판단불가 표·이용, 할 일 없음", async ({
  page,
}) => {
  await signIn(page);

  await expectSourcesLine(page, "판단에 쓰는 출처가 모두 정상이에요");
  await expectSourcesLine(page, "기상청 해상 특보 정상");
  await expectSourcesLine(page, "기상청 해양 관측 정상");
  if (isDesktop(page)) {
    await expect(sideStatus(page).getByText("판단 출처 정상")).toBeVisible();
    await expect(sideStatus(page).getByText(/^앱 게시본 \d/)).toBeVisible();
  }
  // 지운 칸: 로그인 계정 줄·최근 변경(GH-453 검토)
  await expect(page.getByText(/로 로그인했어요/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "최근 변경" })).toHaveCount(0);
  // 머리: 기준 시각 + 세션 안내(D17-11 문구)
  await expect(page.getByText(/기준 · 화면이 보이는 동안 1분마다/)).toBeVisible();
  await expect(
    page.getByText(/^새로고침해도 로그인이 이어지고, 새 탭은/),
  ).toBeVisible();
  await expect(page.getByText(/새로고침하면 다시 로그인/)).toHaveCount(0);

  const beaches = block(page, "앱에 보이는 해변");
  await expect(beaches.getByText("3곳", { exact: true })).toBeVisible();
  await expect(beaches.getByText("게시본 11/11 12:00 기준")).toBeVisible();
  await expect(beaches.getByText("1곳", { exact: true })).toBeVisible();
  await expect(beaches.getByText("2곳", { exact: true })).toBeVisible();
  await expect(
    beaches.getByText("판단불가 2곳은 경포해수욕장·사근진해수욕장이에요."),
  ).toBeVisible();
  // 가짜 게시본의 유효 시각은 모두 지남: 분류는 그대로 두고 따로 알림
  await expect(
    beaches.getByText(
      "유효 시각이 지난 해변 3곳이 있어요. 해변 관리에서 확인해 주세요.",
    ),
  ).toBeVisible();
  await expect(beaches.getByText(/앱이 점검 중이라/)).toHaveCount(0);

  const collection = block(page, "수집");
  // 배지는 모든 출처 기준(가짜 수집 현황은 참고 출처에 기록 없음이 있어 '문제 N')
  await expect(collection.getByText(/^(정상|문제 \d)$/)).toBeVisible();
  await expect(collection.getByText("최근 24시간 성공")).toBeVisible();
  await expect(collection.getByText("국립해양조사원 이안류")).toBeVisible();

  const inquiries = block(page, "문의");
  // 상태별 수 0·1·3·0 → 합 4건, 새 문의 0건이면 '새' 배지 없음
  await expect(inquiries.getByText("4건", { exact: true })).toBeVisible();
  await expect(inquiries.getByText(/^새 \d/)).toHaveCount(0);

  // 판단불가 해변 표: 이름·사유 먼저 배지·범위·시각(PC 표, 모바일 카드)
  const table = block(page, "판단불가 해변");
  const shown = table.locator(isDesktop(page) ? "table" : "ul");
  await expect(shown.getByText("경포해수욕장")).toBeVisible();
  await expect(shown.getByText("특보 확인 못 함")).toBeVisible();
  await expect(shown.getByText(/강원중부앞바다 · 기상청/)).toBeVisible();
  await expect(shown.getByText(/11:30 마지막 확인/)).toBeVisible();
  await expect(shown.getByText("관측 지연")).toBeVisible();
  await expect(shown.getByText(/09:38 측정/)).toBeVisible();
  await expect(table.getByText("b0002")).toHaveCount(0);

  // 이용: GA 28일 합계·지금 사용 중·기간 추이(trends) 일별 그래프·앞 기간 비교
  const usage = block(page, "이용");
  await expect(usage.getByText("지금 사용 중 14명 · 최근 30분")).toBeVisible();
  // 기간 표시는 응답의 KST 날짜(양 끝 포함)
  await expect(
    usage.getByText("10월 15일 – 11월 11일 · 앞 28일과 비교", { exact: true }),
  ).toBeVisible();
  // 이용 칸 자기 기준 시각(GA 집계 받은 시각, 머리의 1분 주기와 따로 5분마다)
  await expect(
    usage.getByText("12:00 기준 · 5분마다 다시 읽어요", { exact: true }),
  ).toBeVisible();
  await expect(usage.getByText("3,960", { exact: true })).toBeVisible();
  await expect(usage.getByText("9,240", { exact: true })).toBeVisible();
  // 앞 28일 3,344·7,634 → +18.4%·+21%(화면에서 계산)
  await expect(usage.getByText("앞 28일 3,344")).toBeVisible();
  await expect(usage.getByText("앞 28일 7,634")).toBeVisible();
  await expect(usage.getByText("+18.4%")).toBeVisible();
  await expect(usage.getByText("+21%")).toBeVisible();
  await expect(usage.getByText("일별 추이는 아직 보여 드릴 수 없어요")).toHaveCount(0);
  // 일별 28일 × 사용자·화면 조회
  await expect(usage.locator("svg rect")).toHaveCount(56);

  await expect(page.getByText("지금 할 일이 없어요")).toBeVisible();
  const prs = page.getByRole("link", { name: /해변 정보 변경 PR 보기/ });
  await expect(prs).toHaveAttribute("target", "_blank");
  await expect(prs).toHaveAttribute("href", /\/baradun_v2\/pulls$/);

  await expectNoA11yViolations(page);
});

test("이름표에 없는 판단불가 해변은 ID가 아니라 '이름 확인 못 함', 6곳부터는 판단불가 표를 쪽으로 나눈다", async ({
  page,
}) => {
  const beaches: Record<string, unknown> = {
    b9999: {
      category: "undetermined",
      reasons: [],
      validUntil: "2026-11-11T04:00:00Z",
    },
  };
  for (const id of ["b0002", "b0003", "b0004", "b0005", "b0006"]) {
    beaches[id] = PUBLISHED.beaches.b0002;
  }
  await signIn(page, { published: ok({ ...PUBLISHED, beaches }) });
  const table = block(page, "판단불가 해변");
  await expect(
    table.getByRole("navigation", { name: "판단불가 해변 페이지" }),
  ).toBeVisible();
  await expect(table.getByText("6건 중 1–5")).toBeVisible();
  await table.getByRole("button", { name: /다음/ }).click();
  const shown = table.locator(isDesktop(page) ? "table" : "ul");
  await expect(shown.getByText("이름 확인 못 함")).toBeVisible();
  await expect(shown.getByText("사유 확인 못 함")).toBeVisible();
  await expect(table.getByText("b9999")).toHaveCount(0);
  await expect(
    block(page, "앱에 보이는 해변").getByText(/외 3곳이에요/),
  ).toBeVisible();
});

test("게시본이 점검 중이면 앱에 보이는 해변 칸에 점검 안내를 더하고 개수는 마지막 게시본 그대로(D23-11)", async ({
  page,
}) => {
  await signIn(page, {
    published: ok({
      ...PUBLISHED,
      maintenance: { active: true, until: null },
    }),
  });
  const beaches = block(page, "앱에 보이는 해변");
  await expect(beaches.getByText("3곳", { exact: true })).toBeVisible();
  await expect(
    beaches.getByText(
      "앱이 점검 중이라 해변 상태를 보여 주지 않아요. 개수는 마지막 게시본 기준이에요.",
    ),
  ).toBeVisible();
  await expectNoA11yViolations(page);
});

test("판단불가 사유가 여럿이면 배지를 모두 보이고, 이용 칸은 기간 통계 실패와 일별 그래프를 응답대로 보인다", async ({
  page,
}) => {
  const full = localStatsView("28d", Date.parse("2026-11-11T03:00:00Z"));
  // 기간 추이가 없는 응답(이전 서버): 일별 그래프 대신 한 줄
  const { trends, ...stats } = full;
  await signIn(page, {
    published: ok({
      ...PUBLISHED,
      beaches: {
        ...PUBLISHED.beaches,
        b0002: {
          ...PUBLISHED.beaches.b0002,
          reasons: [
            ...PUBLISHED.beaches.b0002.reasons,
            {
              code: "observation_delayed",
              scope: "강릉 파고부이",
              source: "기상청",
              at: "2026-11-11T00:38:00Z",
            },
          ],
        },
      },
    }),
    stats: ok({
      ...stats,
      period: { ...stats.period, status: "unavailable" },
    }),
  });
  const table = block(page, "판단불가 해변");
  const shown = table.locator(isDesktop(page) ? "table" : "ul");
  const row = shown
    .locator(isDesktop(page) ? "tr" : "li")
    .filter({ hasText: "경포해수욕장" });
  await expect(row.getByText("특보 확인 못 함")).toBeVisible();
  await expect(row.getByText("관측 지연")).toBeVisible();

  // 기간 통계 실패: 값은 확인 못 함 + 무슨 일·영향 + 다시 시도
  const usage = block(page, "이용");
  await expect(
    usage.getByText(/^기간 통계를 불러오지 못해 사용자·화면 조회를 확인하지 못했어요/),
  ).toBeVisible();
  await expect(usage.getByRole("button", { name: "다시 시도" })).toBeVisible();
  await expect(usage.getByText("확인 못 함", { exact: true })).toHaveCount(2);
  await expect(
    usage.getByText("일별 추이는 아직 보여 드릴 수 없어요", { exact: true }),
  ).toBeVisible();
  await expect(usage.getByText("최근 28일 · 오늘 포함")).toBeVisible();
  await expect(usage.locator("svg rect")).toHaveCount(0);

  // 다시 시도: 일별 칸이 생긴 응답이면 그래프(값이 없는 날은 막대 대신 옅은 빈칸), 앞 기간 null이면 배지 없음
  await page.unroute(/\/ops\/stats(\?.*)?$/);
  await page.route(/\/ops\/stats(\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...stats,
        trends: {
          ...trends,
          startDate: "2026-11-10",
          previous: null,
          daily: {
            rows: [
              { date: "2026-11-10", activeUsers: 120, pageViews: 300 },
              { date: "2026-11-11", activeUsers: null, pageViews: 280 },
            ],
            metadata: trends!.daily!.metadata,
          },
        },
      }),
    }),
  );
  await usage.getByRole("button", { name: "다시 시도" }).click();
  await expect(usage.getByText("3,960", { exact: true })).toBeVisible();
  await expect(usage.getByText("11월 10일 – 11월 11일", { exact: true })).toBeVisible();
  // 사용자 막대 1 + 빈칸 1, 화면 조회 막대 2
  await expect(usage.locator("svg rect")).toHaveCount(4);
  await expect(usage.locator("svg rect[data-empty]")).toHaveCount(1);
  await expect(usage.getByText("옅은 칸은 확인 못 한 값이에요")).toBeVisible();
  await expect(usage.getByText("앞 기간 대비")).toHaveCount(0);
  await expect(usage.getByText(/^앞 28일/)).toHaveCount(0);
  await expect(usage.getByText("일별 추이는 아직 보여 드릴 수 없어요")).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test("문의 칸 최근 7일 접수·완료와 가장 오래된 미처리 접수, 수집 칸 다음 수집 시각(GH-478)", async ({
  page,
}) => {
  const generatedAt = "2026-11-11T03:00:00.000Z";
  await signIn(page, {
    collection: ok({
      ...VIEW_OK,
      generatedAt,
      jobs: VIEW_OK.jobs.map((job) => ({
        ...job,
        nextScheduledAt:
          job.job === "collect-warnings"
            ? "2026-11-11T05:48:00.000Z" // KST 14:48
            : job.job === "collect-ocean"
              ? "2026-11-11T05:40:00.000Z" // KST 14:40
              : "2026-11-11T05:00:00.000Z", // 참고 출처는 보지 않음
      })),
    }),
    inquiries: ok({
      items: [],
      nextCursor: null,
      counts: {
        received: 2,
        in_progress: 1,
        resolved: 9,
        rejected: 1,
        receivedLast7d: 11,
        resolvedLast7d: 6,
        oldestUnprocessedAt: "2026-10-31T04:27:00.000Z", // KST 10/31 13:27
      },
    }),
  });
  const collection = block(page, "수집");
  await expect(collection.getByText(/^다음 수집 14:40이에요\./)).toBeVisible();
  await expect(collection.getByText(/출처별 지연·장애 기록은/)).toHaveCount(0);

  const inquiries = block(page, "문의");
  await expect(inquiries.getByText("11건", { exact: true })).toBeVisible();
  await expect(
    inquiries.getByText("최근 7일 접수 · 보관 중 13건", { exact: true }),
  ).toBeVisible();
  await expect(inquiries.getByText("최근 7일 완료")).toBeVisible();
  // 최근 7일 완료는 수만(완료에 7일 전 접수가 섞여 ÷ 최근 7일 접수 비율을 만들지 않음)
  await expect(
    inquiries.getByRole("listitem").filter({ hasText: "최근 7일 완료" }),
  ).toContainText("6건");
  await expect(
    inquiries.getByRole("listitem").filter({ hasText: "최근 7일 완료" }),
  ).not.toContainText("/");
  await expect(
    inquiries.getByRole("listitem").filter({ hasText: "접수" }).first(),
  ).toContainText("2/13");
  await expect(
    inquiries.getByText(/^가장 오래된 미처리 접수 10\/31 13:27/),
  ).toBeVisible();
  await expect(inquiries.getByText(/반려/)).toHaveCount(0);

  const todo = block(page, "할 일");
  await expect(
    todo.getByText("접수 문의 2건이 기다려요", { exact: true }),
  ).toBeVisible();
  // 서버 값은 접수·확인 중을 함께 본 가장 오래된 미처리 → 확인 중이 있으면 범위를 밝힘
  await expect(
    todo.getByText("확인 중 포함 가장 오래된 것 10/31 13:27", { exact: true }),
  ).toBeVisible();
  await expectNoA11yViolations(page);
});

test("문의 최근 7일 값이 null(조회 실패)이면 0이 아니라 확인 못 함, 다음 수집 시각이 없으면 고정 안내", async ({
  page,
}) => {
  await signIn(page, {
    inquiries: ok({
      items: [],
      nextCursor: null,
      counts: {
        received: 1,
        in_progress: 0,
        resolved: 3,
        rejected: 0,
        receivedLast7d: null,
        resolvedLast7d: null,
        oldestUnprocessedAt: null,
      },
    }),
  });
  await expect(
    block(page, "수집").getByText(/^출처별 지연·장애 기록은 수집 현황에서 봐요\./),
  ).toBeVisible();
  const inquiries = block(page, "문의");
  await expect(
    inquiries.getByText("최근 7일 접수 · 보관 중 4건", { exact: true }),
  ).toBeVisible();
  await expect(inquiries.getByText("확인 못 함", { exact: true })).toHaveCount(2);
  await expect(inquiries.getByText("0건", { exact: true })).toHaveCount(0);
  // 미처리 1건이 있는데 시각이 null: 없음이 아니라 확인 못 함
  await expect(
    inquiries.getByText(/^가장 오래된 미처리 접수 확인 못 함/),
  ).toBeVisible();
  await expect(block(page, "할 일").getByText(/가장 오래된 것/)).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test("데모 계정은 한 번만 읽으므로 머리·이용 칸에 다시 읽기 주기 안내를 붙이지 않는다", async ({
  page,
}) => {
  await mockCognito(
    page,
    srpScript({ email: "demo@example.test", groups: ["sample"], after: "tokens" }),
  );
  await mockOps(page, ME_OK);
  await mockHome(page);
  await signInWithPassword(page, "/login/demo/", "demo@example.test");
  await expect(
    page.getByRole("heading", { name: "운영 홈", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(/^\d+\/\d+ \d{2}:\d{2} 기준$/)).toBeVisible();
  await expect(page.getByText(/1분마다 다시 읽어요/)).toHaveCount(0);
  const usage = block(page, "이용");
  await expect(usage.getByText("12:00 기준", { exact: true })).toBeVisible();
  await expect(usage.getByText(/5분마다/)).toHaveCount(0);
});

test("다음 수집 시각이 null(못 읽음)이면 고정 안내로 숨기지 않고 확인 못 함", async ({
  page,
}) => {
  await signIn(page, {
    collection: ok({
      ...VIEW_OK,
      jobs: VIEW_OK.jobs.map((job) => ({
        ...job,
        nextScheduledAt:
          job.job === "collect-ocean" ? null : "2026-11-11T05:48:00.000Z",
      })),
    }),
  });
  const collection = block(page, "수집");
  await expect(
    collection.getByText(/^다음 수집 시각을 확인하지 못했어요\./),
  ).toBeVisible();
  await expect(collection.getByText(/출처별 지연·장애 기록은/)).toHaveCount(0);
  await expect(collection.getByText(/^다음 수집 \d/)).toHaveCount(0);
});

test("판단 출처 문제·새 문의·수정 대기 공지가 있으면 문제 줄과 할 일 줄이 생긴다", async ({
  page,
}) => {
  await signIn(page, {
    // 해양 관측 일부 실패, 특보 지연
    collection: ok({
      ...VIEW,
      jobs: VIEW.jobs.map((job) =>
        job.job === "collect-warnings" ? { ...job, overdue: true } : job,
      ),
    }),
    inquiries: ok({
      items: [],
      nextCursor: null,
      counts: { received: 2, in_progress: 0, resolved: 0, rejected: 0 },
    }),
    notices: ok({
      items: [notice("n1", "live", true), notice("n2", "scheduled")],
    }),
  });

  if (isDesktop(page)) {
    // PC: 문제 줄은 숨기고 왼쪽 메뉴 상태 칸이 알림
    await expectSourcesLine(page, "판단에 쓰는 출처에 문제가 있어요");
    await expect(
      sideStatus(page).getByText("판단 출처 문제 2", { exact: true }),
    ).toBeVisible();
  } else {
    const alert = page.getByRole("alert").filter({
      hasText: "판단에 쓰는 출처에 문제가 있어요",
    });
    await expect(alert).toBeVisible();
    await expect(alert.getByText("기상청 해상 특보 지연")).toBeVisible();
    await expect(alert.getByText("기상청 해양 관측 일부 실패")).toBeVisible();
    await expect(
      alert.getByRole("link", { name: "수집 현황 보기" }),
    ).toHaveAttribute("href", "/collection/");
  }
  await expect(
    block(page, "수집").getByText(/^문제 \d/),
  ).toBeVisible();
  await expect(block(page, "문의").getByText("새 2")).toBeVisible();

  const todo = block(page, "할 일");
  await expect(
    todo.getByText("판단 출처 2곳에 문제가 있어요", { exact: true }),
  ).toBeVisible();
  await expect(
    todo.getByText("기상청 해상 특보 지연 · 기상청 해양 관측 일부 실패"),
  ).toBeVisible();
  await expect(
    todo.getByRole("link", { name: "수집 현황 · 판단 출처 2곳에 문제가 있어요" }),
  ).toHaveAttribute("href", "/collection/");
  await expect(
    todo.getByRole("link", { name: "열기 · 접수 문의 2건이 기다려요" }),
  ).toHaveAttribute("href", "/inquiries/");
  await expect(
    todo.getByRole("link", { name: "게시 · 공지 1건이 게시 대기 중이에요" }),
  ).toHaveAttribute("href", "/publish/");
  await expect(page.getByText("지금 할 일이 없어요")).toHaveCount(0);
  await expectNoA11yViolations(page);

  // 화면 안 이동(로그인 유지)
  await todo
    .getByRole("link", { name: "열기 · 접수 문의 2건이 기다려요" })
    .click();
  await expect(page).toHaveURL(/\/inquiries\/$/);
  await expect(
    page.getByRole("heading", { name: "문의", level: 1 }),
  ).toBeVisible();
});

test("불러오지 못한 값은 0·정상·'할 일 없음'으로 바꾸지 않고, 칸마다 같은 자리에서 다시 시도한다", async ({
  page,
}) => {
  await signIn(page, {
    collection: fail,
    published: ok({ available: false, reason: "read_failed" }),
    inquiries: fail,
    notices: fail,
    stats: fail,
  });

  if (isDesktop(page)) {
    await expectSourcesLine(page, "판단에 쓰는 출처 상태를 불러오지 못했어요");
    await expect(sideStatus(page).getByText("상태 확인 못 함")).toBeVisible();
    await expect(
      sideStatus(page).getByText("앱 게시본 확인 못 함"),
    ).toBeVisible();
    await expect(sideStatus(page).getByText("판단 출처 정상")).toHaveCount(0);
  } else {
    const sources = page.getByRole("alert").filter({
      hasText: "판단에 쓰는 출처 상태를 불러오지 못했어요",
    });
    await expect(sources).toBeVisible();
    await expect(sources.getByText("오류 번호 req-7f3a2c91")).toBeVisible();
  }
  await expect(
    page.getByText("판단에 쓰는 출처가 모두 정상이에요"),
  ).toHaveCount(0);

  // 세 칸·이용 모두 '확인 못 함'(0건·0곳·정상이 아님) + 칸 안의 다시 시도
  for (const name of ["앱에 보이는 해변", "수집", "문의"]) {
    const b = block(page, name);
    await expect(b.getByText("확인 못 함", { exact: true })).toBeVisible();
    await expect(b.getByText(/^0(건|곳)$/)).toHaveCount(0);
    await expect(
      b.getByText("이 칸을 불러오지 못했어요. 앱 사용자 화면에는 영향이 없어요."),
    ).toBeVisible();
    await expect(b.getByRole("button", { name: "다시 시도" })).toBeVisible();
  }
  await expect(block(page, "수집").getByText("정상", { exact: true })).toHaveCount(0);
  await expect(
    block(page, "판단불가 해변").getByText("지금 판단불가 해변이 없어요"),
  ).toHaveCount(0);
  await expect(
    block(page, "이용").getByText("지금 사용 중 확인 못 함 · 최근 30분"),
  ).toBeVisible();
  // 응답 전체 실패: 그래프 칸마다 '다른 칸은 그대로예요'를 두지 않고 칸 실패 줄 하나
  await expect(
    block(page, "이용").getByText(/이 항목을 불러오지 못했어요/),
  ).toHaveCount(0);

  await expect(
    page.getByText(
      "일부 정보를 불러오지 못해 할 일을 다 확인하지 못했어요. 다시 시도해 주세요.",
    ),
  ).toBeVisible();
  await expect(page.getByText("지금 할 일이 없어요")).toHaveCount(0);
  await expectNoA11yViolations(page);

  // 문의 칸의 다시 시도: 그 칸만 다시 읽어 값으로 바뀜
  await page.unroute(/\/ops\/inquiries(\?.*)?$/);
  await page.route(/\/ops\/inquiries(\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [],
        nextCursor: null,
        counts: { received: 1, in_progress: 0, resolved: 0, rejected: 0 },
      }),
    }),
  );
  await block(page, "문의").getByRole("button", { name: "다시 시도" }).click();
  await expect(block(page, "문의").getByText("새 1")).toBeVisible();
  await expect(
    block(page, "문의").getByText("1건", { exact: true }),
  ).toBeVisible();
});

test("한 칸의 응답이 오지 않아도 판단 출처 줄과 다른 칸은 먼저 보이고, 그 칸만 자리표시로 남는다", async ({
  page,
}) => {
  await mockCognito(
    page,
    srpScript({ email: OPS, after: "tokens", groups: ["editor"] }),
  );
  await mockOps(page, ME_OK);
  await mockHome(page);
  // 이용 통계 응답이 오지 않음(시간 초과 전). 나중에 건 route가 먼저 받음
  await page.route(/\/ops\/stats(\?.*)?$/, () => new Promise<void>(() => {}));
  await signInWithPassword(page, "/login/", OPS);
  await expectSourcesLine(page, "판단에 쓰는 출처가 모두 정상이에요");
  await expect(page.getByText("지금 할 일이 없어요")).toBeVisible();
  // 이용 칸만 값 자리 자리표시(GH-462), 다른 칸은 값. 화면 읽기에는 '운영 홈 불러오는 중' 한 번
  await expect(block(page, "이용").locator(".sk").first()).toBeVisible();
  await expect(block(page, "문의").locator(".sk")).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "운영 홈 불러오는 중" }),
  ).toHaveCount(1);
});

// ---- 로딩 (GH-462, 캔버스 로딩 보드 L0·LS·LP) ----

const HOME_PART_URLS =
  /\/ops\/(collection|beaches\/published|inquiries(\?.*)?|notices|stats(\?.*)?)$/;

// 운영 홈 칸 응답을 gate가 풀릴 때까지 붙잡음(풀리면 앞서 건 가짜 응답으로 넘김)
async function holdHome(page: Page, gate: Promise<void>) {
  await page.route(HOME_PART_URLS, async (route) => {
    await gate;
    await route.fallback();
  });
}

test("다시 읽기가 실패하면 판단 출처 줄은 불러오지 못함으로 바꾸고, 다른 칸은 앞 값에 '마지막으로 받은 값'과 'HH:MM 기준' 줄, 다시 읽는 동안 회전 표시", async ({
  page,
}) => {
  await page.clock.install();
  await mockCognito(
    page,
    srpScript({ email: OPS, after: "tokens", groups: ["editor"] }),
  );
  await mockOps(page, ME_OK);
  await mockHome(page);
  await signInWithPassword(page, "/login/", OPS);
  await expectSourcesLine(page, "판단에 쓰는 출처가 모두 정상이에요");
  await expect(page.getByText(/기준 · 화면이 보이는 동안/)).toBeVisible();

  // 1분 뒤 다시 읽기: 수집 현황(판단 출처)과 문의가 늦게 실패
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/ops\/(collection|inquiries(\?.*)?)$/, async (route) => {
    await gate;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify(fail.body),
    });
  });
  await page.clock.fastForward(61_000);
  await expect(page.getByText("다시 읽는 중")).toBeVisible();
  // 다시 읽는 동안 값은 그대로(자리표시로 바꾸지 않음)
  await expectSourcesLine(page, "판단에 쓰는 출처가 모두 정상이에요");
  release();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /^마지막으로 받은 값이에요 · \d{2}:\d{2} 기준/ }),
  ).toBeVisible();
  await expect(page.getByText("다시 읽는 중")).toHaveCount(0);
  // 판단 출처는 앞의 '정상'을 두지 않음(조회 실패를 정상으로 보이지 않게)
  await expectSourcesLine(page, "판단에 쓰는 출처 상태를 불러오지 못했어요");
  await expect(
    page.getByText("판단에 쓰는 출처가 모두 정상이에요"),
  ).toHaveCount(0);
  // 문의 칸은 앞 값을 두고 그 칸에 표시(화면을 비우지 않음)
  const inquiries = block(page, "문의");
  await expect(inquiries.getByText("4건", { exact: true })).toBeVisible();
  await expect(inquiries).toContainText("마지막으로 받은 값");
});

test("서버 세션 확인이 실패하면 로딩 표시를 끝내고 오류 알림만 남긴다", async ({
  page,
}) => {
  await mockCognito(
    page,
    srpScript({ email: OPS, after: "tokens", groups: ["editor"] }),
  );
  await mockOps(page, fail);
  await mockHome(page);
  await signInWithPassword(page, "/login/", OPS);
  await expect(
    page.getByText(
      "운영 서버가 응답하지 않아요. 앱 사용자 화면에는 영향이 없어요.",
    ),
  ).toBeVisible();
  await expect(page.locator("#main main")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(
    page.getByRole("status").filter({ hasText: "운영 홈 불러오는 중" }),
  ).toHaveCount(0);
  await expect(page.locator("#main main .sk")).toHaveCount(0);
});

test("운영 홈으로 이동하면 제목·칸 이름·목록 틀이 먼저 보이고 값 자리만 자리표시", async ({
  page,
}) => {
  await mockCognito(
    page,
    srpScript({ email: OPS, after: "tokens", groups: ["editor"] }),
  );
  await mockOps(page, ME_OK);
  await mockHome(page);
  await signInWithPassword(page, "/login/", OPS);
  await expect(page.getByText(/기준 · 화면이 보이는 동안/)).toBeVisible();
  await page.goto("/collection/");
  await expect(
    page.getByRole("heading", { name: "수집 현황", level: 1 }),
  ).toBeVisible();

  // 돌아온 운영 홈의 칸 응답은 오지 않음
  await holdHome(page, new Promise<void>(() => {}));
  await openMenu(page);
  await page
    .getByRole("navigation", { name: "운영 메뉴" })
    .getByRole("link", { name: "운영 홈" })
    .click();
  await expect(
    page.getByRole("heading", { name: "운영 홈", level: 1 }),
  ).toBeVisible();
  for (const name of [
    "앱에 보이는 해변",
    "수집",
    "문의",
    "판단불가 해변",
    "할 일",
    "이용",
  ]) {
    await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
  }
  const body = page.locator("#main main");
  await expect(body).toHaveAttribute("aria-busy", "true");
  // 150ms 뒤 자리표시가 보임(값 자리: 판단 출처 줄(모바일)·카드 값·판단불가 표·할 일·이용·기준 시각)
  await expect(body.locator(".sk").first()).toBeVisible();
  await expect(block(page, "이용").locator(".sk").first()).toBeVisible();
  await expect(body.locator(".sk-wait")).toHaveCount(0);
});

test("로딩이 끝나 값으로 바뀌어도 포커스를 옮기지 않는다", async ({ page }) => {
  await mockCognito(
    page,
    srpScript({ email: OPS, after: "tokens", groups: ["editor"] }),
  );
  await mockOps(page, ME_OK);
  await mockHome(page);
  let release!: () => void;
  await holdHome(page, new Promise<void>((resolve) => (release = resolve)));
  await signInWithPassword(page, "/login/", OPS);
  await expect(block(page, "이용").locator(".sk").first()).toBeVisible();
  const link = page.getByRole("link", { name: /해변 정보 변경 PR 보기/ });
  await link.focus();
  await expect(link).toBeFocused();
  release();
  await expectSourcesLine(page, "판단에 쓰는 출처가 모두 정상이에요");
  await expect(page.getByText(/기준 · 화면이 보이는 동안/)).toBeVisible();
  await expect(link).toBeFocused();
});

test("로그아웃하면 로그인 화면으로 가는 동안에도 받아 둔 운영 데이터를 그리지 않는다", async ({
  page,
}) => {
  test.skip(
    !isDesktop(page),
    "로그아웃 상태 틀(왼쪽 사용자 칸 자리표시)은 PC 메뉴에서 봄",
  );
  await mockCognito(
    page,
    srpScript({ email: OPS, after: "tokens", groups: ["editor"] }),
  );
  await mockOps(page, ME_OK);
  await mockHome(page);
  await signInWithPassword(page, "/login/", OPS);
  await expectSourcesLine(page, "판단에 쓰는 출처가 모두 정상이에요");
  // 공통 틀이 로그아웃 상태로 그려진 순간(사용자 칸 자리표시)에 운영 데이터가 함께 남아 있으면 기록
  await page.evaluate(() => {
    const w = window as unknown as { leaked: string[] };
    w.leaked = [];
    new MutationObserver(() => {
      if (!document.querySelector("aside .sk.rounded-full")) return;
      const text = document.querySelector("#main")?.textContent ?? "";
      for (const value of [
        "판단에 쓰는 출처가 모두 정상이에요",
        "경포해수욕장",
      ]) {
        if (text.includes(value)) w.leaked.push(value);
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await logout(page);
  await expect(page).toHaveURL(/\/login\/$/);
  expect(
    await page.evaluate(
      () => (window as unknown as { leaked: string[] }).leaked,
    ),
  ).toEqual([]);
});
