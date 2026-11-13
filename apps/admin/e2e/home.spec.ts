import type { Page } from "@playwright/test";
import { VIEW } from "./collection-data";
import {
  ME_OK,
  expect,
  expectNoA11yViolations,
  mockCognito,
  mockOps,
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
      reasons: [],
      validUntil: "2026-11-11T04:00:00Z",
    },
    b0003: {
      category: "undetermined",
      reasons: [],
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

const AUDIT_ITEM = {
  at: "2026-11-11T02:30:00Z", // KST 11/11 11:30
  actorSub: "sub-1",
  actorKind: "operator",
  role: "editor",
  action: "notice.create",
  target: { kind: "notice", id: "n1" },
  targetLabel: "정기 점검 안내",
  changes: [],
  requestId: "req-00000001",
};

// 데모 계정의 조회 기록: 변경이 아니라 최근 변경에 나오지 않아야 함
const SAMPLE_READ = {
  ...AUDIT_ITEM,
  at: "2026-11-11T02:40:00Z",
  actorSub: "sub-demo",
  actorKind: "sample",
  role: "sample",
  action: "sample.read",
  target: { kind: "collection", id: "collection" },
  targetLabel: undefined,
  requestId: "req-00000002",
};

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
    audit?: Reply;
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
      /\/ops\/audit(\?.*)?$/,
      replies.audit ??
        ok({ filter: {}, items: [SAMPLE_READ, AUDIT_ITEM], nextCursor: null }),
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

const cardsOf = (page: Page) => page.locator("dl[aria-label='운영 요약']");

test("모두 정상: 판단 출처 정상 한 줄, 요약 카드, 할 일 없음, 최근 변경", async ({
  page,
}) => {
  await signIn(page);

  await expect(
    page.getByText("판단에 쓰는 출처가 모두 정상이에요"),
  ).toBeVisible();
  await expect(page.getByText("기상청 해상 특보 정상")).toBeVisible();
  await expect(page.getByText("기상청 해양 관측 정상")).toBeVisible();

  const cards = cardsOf(page);
  await expect(cards.getByText("0건", { exact: true })).toBeVisible();
  await expect(cards.getByText("2곳", { exact: true })).toBeVisible();
  await expect(cards.getByText("11/11 12:00")).toBeVisible();
  await expect(
    cards.getByText("예약 공지 0건 · 수정 대기 공지 0건"),
  ).toBeVisible();
  // 가짜 게시본의 유효 시각은 모두 지남: 분류는 그대로 두고 따로 알림
  await expect(
    cards.getByText(
      "유효 시각이 지난 해변 3곳이 있어요. 해변 관리에서 확인해 주세요.",
    ),
  ).toBeVisible();
  // 이용 통계 연결 전: 숫자를 지어내지 않음
  await expect(cards.getByText("연결 전")).toBeVisible();

  await expect(page.getByText("지금 할 일이 없어요")).toBeVisible();
  const prs = page.getByRole("link", { name: /해변 정보 변경 PR 보기/ });
  await expect(prs).toHaveAttribute("target", "_blank");
  await expect(prs).toHaveAttribute("href", /\/baradun_v2\/pulls$/);

  const recent = page.getByRole("region", { name: "최근 변경" });
  await expect(recent.getByText("정기 점검 안내")).toBeVisible();
  await expect(recent.getByText("11/11 11:30")).toBeVisible();
  // 변경 이력 화면과 같은 종류·요약 표시, 조회 기록은 뺌
  await expect(
    recent.getByRole("link", { name: "정기 점검 안내" }),
  ).toHaveAttribute("href", "/notices/?id=n1");
  await expect(recent.getByText("새 공지")).toBeVisible();
  await expect(recent.getByRole("listitem")).toHaveCount(1);
  await expect(recent.getByText(/sample\.read|조회/)).toHaveCount(0);
  await expectNoA11yViolations(page);
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

  const alert = page.getByRole("alert").filter({
    hasText: "판단에 쓰는 출처에 문제가 있어요",
  });
  await expect(alert).toBeVisible();
  await expect(alert.getByText("기상청 해상 특보 지연")).toBeVisible();
  await expect(alert.getByText("기상청 해양 관측 일부 실패")).toBeVisible();
  await expect(
    alert.getByRole("link", { name: "수집 현황 보기" }),
  ).toHaveAttribute("href", "/collection/");

  await expect(
    page.getByText("예약 공지 1건 · 수정 대기 공지 1건"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "판단 출처 2곳 확인하기" }),
  ).toHaveAttribute("href", "/collection/");
  await expect(
    page.getByRole("link", { name: "새 문의 2건 확인하기" }),
  ).toHaveAttribute("href", "/inquiries/");
  await expect(
    page.getByRole("link", { name: "수정 대기 공지 1건 확인하기" }),
  ).toHaveAttribute("href", "/notices/");
  await expect(page.getByText("지금 할 일이 없어요")).toHaveCount(0);
  await expectNoA11yViolations(page);

  // 화면 안 이동(로그인 유지)
  await page.getByRole("link", { name: "새 문의 2건 확인하기" }).click();
  await expect(page).toHaveURL(/\/inquiries\/$/);
  await expect(
    page.getByRole("heading", { name: "문의", level: 1 }),
  ).toBeVisible();
});

test("불러오지 못한 값은 0·정상·'할 일 없음'으로 바꾸지 않고, 변경 이력을 못 보는 계정은 그렇게 알린다", async ({
  page,
}) => {
  await signIn(page, {
    collection: fail,
    published: ok({ available: false, reason: "read_failed" }),
    inquiries: fail,
    notices: fail,
    audit: {
      status: 403,
      body: { error: { code: "forbidden", requestId: "req-2" } },
    },
  });

  const sources = page.getByRole("alert").filter({
    hasText: "판단에 쓰는 출처 상태를 불러오지 못했어요",
  });
  await expect(sources).toBeVisible();
  await expect(sources.getByText("오류 번호 req-7f3a2c91")).toBeVisible();
  await expect(
    page.getByText("판단에 쓰는 출처가 모두 정상이에요"),
  ).toHaveCount(0);

  const cards = cardsOf(page);
  // 새 문의·판단불가 해변·지금 게시본 모두 '확인 못 함'(0건·0곳이 아님)
  await expect(cards.getByText("확인 못 함", { exact: true })).toHaveCount(3);
  await expect(cards.getByText("0건", { exact: true })).toHaveCount(0);
  await expect(cards.getByText("0곳", { exact: true })).toHaveCount(0);
  await expect(cards.getByText("공지 상태는 확인 못 함")).toBeVisible();

  await expect(
    page.getByText(
      "일부 정보를 불러오지 못해 할 일을 다 확인하지 못했어요. 다시 시도해 주세요.",
    ),
  ).toBeVisible();
  await expect(page.getByText("지금 할 일이 없어요")).toHaveCount(0);
  await expect(
    page.getByText("이 계정으로는 변경 이력을 볼 수 없어요"),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "변경 이력 전체 보기" }),
  ).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test("한 칸의 응답이 오지 않아도 판단 출처 줄과 다른 칸은 먼저 보이고, 그 칸만 불러오는 중으로 남는다", async ({
  page,
}) => {
  await mockCognito(
    page,
    srpScript({ email: OPS, after: "tokens", groups: ["editor"] }),
  );
  await mockOps(page, ME_OK);
  await mockHome(page);
  // 변경 이력 응답이 오지 않음(시간 초과 전). 나중에 건 route가 먼저 받음
  await page.route(/\/ops\/audit(\?.*)?$/, () => new Promise<void>(() => {}));
  await signInWithPassword(page, "/login/", OPS);
  await expect(
    page.getByText("판단에 쓰는 출처가 모두 정상이에요"),
  ).toBeVisible();
  await expect(page.getByText("지금 할 일이 없어요")).toBeVisible();
  await expect(page.getByText("최근 변경을 불러오는 중이에요")).toBeVisible();
});
