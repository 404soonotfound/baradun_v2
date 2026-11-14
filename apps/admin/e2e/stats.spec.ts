import type { Page, Route } from "@playwright/test";
import { localStatsView } from "../src/lib/auth/local-stats";
import {
  ME_OK,
  expect,
  expectNoA11yViolations,
  mockCognito,
  mockOps,
  openMenu,
  signInWithPassword,
  srpScript,
  test,
} from "./fixtures";

// 이용 통계 (BRD-154·GH-333, 화면 설계서 6장 ADM-STATS)

const OPS = "ops@example.test";

async function mockStats(
  page: Page,
  handler: (range: string) => { status?: number; body: object },
) {
  const ranges: string[] = [];
  await page.route(/\/ops\/stats(\?.*)?$/, async (route: Route) => {
    const url = new URL(route.request().url());
    const range = url.searchParams.get("range") ?? "7d";
    ranges.push(range);
    const res = handler(range);
    await route.fulfill({
      status: res.status ?? 200,
      contentType: "application/json",
      body: JSON.stringify(res.body),
    });
  });
  return ranges;
}

async function openStats(page: Page) {
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
    .getByRole("link", { name: "이용 통계" })
    .click();
  await expect(
    page.getByRole("heading", { name: "이용 통계", level: 1 }),
  ).toBeVisible();
}

const section = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });

const MISSING_ALL =
  "일별·시간대별 추이, 앞 기간 비교, 많이 본 화면, 들어온 경로는 아직 보여 드릴 수 없어요";

// 기간 추이가 없는 응답(이전 서버): 칸을 숨기고 한 줄 안내
const withoutTrends = (body: ReturnType<typeof localStatsView>) => {
  const copy: Record<string, unknown> = { ...body };
  delete copy.trends;
  return copy;
};

const NO_LIMITS = { thresholding: false, sampling: false, otherRowLoss: false };

test("정상 조회: 머리 '지금 사용 중', 기본 28일, 기간 날짜·앞 기간 비교, 추이·많이 본 화면·들어온 경로, 기간 전환", async ({
  page,
}) => {
  const ranges = await mockStats(page, (range) => ({
    body: localStatsView(
      range === "today" || range === "7d" || range === "60d" ? range : "28d",
    ),
  }));
  await openStats(page);

  await expect(page.getByText(/^지금 사용 중\s*14명\s*· 최근 30분$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "28일" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // 기간 표시: 응답의 KST 날짜(양 끝 포함) + 앞 기간 비교
  await expect(
    page.getByText(
      /^Google Analytics · 비식별 이용 이벤트만 수집해요 · \d+월 \d+일 – \d+월 \d+일, 앞 28일과 비교$/,
    ),
  ).toBeVisible();
  await expect(page.getByText("통계 기준 시간대가 달라요")).toHaveCount(0);
  // 28일 예시: 사용자 3,960 · 화면 조회 9,240 · 사용자당 2.3 · 새 사용자 2,464 ÷ 3,960 = 62%
  const kpi = page.locator("dl");
  await expect(kpi.getByText("3,960", { exact: true })).toBeVisible();
  await expect(kpi.getByText("9,240", { exact: true })).toBeVisible();
  await expect(kpi.getByText("2.3", { exact: true })).toBeVisible();
  await expect(kpi.getByText("62%", { exact: true })).toBeVisible();
  // 앞 28일 3,344·7,634 → 화면에서 계산한 +18.4%·+21%
  await expect(kpi.getByText("+18.4%")).toBeVisible();
  await expect(kpi.getByText("+21%")).toBeVisible();
  await expect(kpi.getByText("앞 28일 3,344")).toBeVisible();
  await expect(kpi.getByText("앞 28일 7,634")).toBeVisible();
  await expect(kpi.getByText("앞 기간 대비")).toHaveCount(2);

  const beaches = section(page, "많이 본 해변");
  await expect(beaches.getByText("해운대해수욕장")).toBeVisible();
  await expect(beaches.getByText("광안리해수욕장")).toBeVisible();
  await expect(beaches.getByText("경포해수욕장")).toBeVisible();
  await expect(beaches.getByText(/\/spots\/|haeundae|gwangan-ri/)).toHaveCount(0);

  // 추이 칸: 응답 목록대로(한 줄 안내 없음)
  await expect(page.getByText(/아직 보여 드릴 수 없어요/)).toHaveCount(0);
  await expect(section(page, "일별 사용자").locator("svg rect")).toHaveCount(28);
  await expect(section(page, "일별 화면 조회").locator("svg rect")).toHaveCount(28);
  const hourly = section(page, "시간대별 사용자");
  await expect(hourly.getByText("평균 · 28일")).toBeVisible();
  await expect(hourly.getByRole("columnheader", { name: "평균 사용자" })).toBeAttached();
  await expect(hourly.locator("svg rect")).toHaveCount(24);

  // 많이 본 화면: 경로를 화면 이름표·해변 이름으로, /en/도 같은 이름(+ English)
  const screens = section(page, "많이 본 화면");
  for (const name of ["홈", "해운대해수욕장", "탐색", "안전·데이터 안내"]) {
    await expect(screens.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(
    screens.getByRole("listitem").filter({ hasText: "검색" }),
  ).toContainText("English");
  await expect(screens.getByText(/^\/|haeundae/)).toHaveCount(0);
  // 들어온 경로: GA 기본 채널 이름을 우리말로
  const referrers = section(page, "들어온 경로");
  for (const name of ["직접 방문", "검색", "소셜", "다른 사이트"]) {
    await expect(referrers.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(referrers.getByText(/Organic|Direct/)).toHaveCount(0);

  await expect(page.getByText("수집 이벤트")).toHaveCount(0);
  await expect(section(page, "기기").getByText("모바일")).toBeVisible();
  await expect(section(page, "화면 언어").getByText("한국어")).toBeVisible();
  await expect(page.getByText(/일부 숫자 (숨김|제한)이 있어요/)).toHaveCount(0);

  await expectNoA11yViolations(page);

  // 오늘: 서버가 앞 기간을 null로 줌 → 비교 배지·앞 값 줄 숨김, 기간 표시는 하루
  await page.getByRole("button", { name: "오늘" }).click();
  await expect(
    page.getByText(
      /^Google Analytics · 비식별 이용 이벤트만 수집해요 · (\d+)월 (\d+)일 – \1월 \2일$/,
    ),
  ).toBeVisible();
  await expect(kpi.getByText("180", { exact: true })).toBeVisible();
  await expect(kpi.getByText("앞 기간 대비")).toHaveCount(0);
  await expect(kpi.getByText(/^앞 /)).toHaveCount(0);
  await expect(hourly.getByText("평균 · 오늘")).toBeVisible();
  // 아직 지나지 않은 시간은 결측(옅은 빈칸)이 아니라 비움
  await expect(hourly.locator("svg rect[data-empty]")).toHaveCount(0);
  await expect(hourly.getByText(/옅은 칸은/)).toHaveCount(0);
  expect(ranges).toEqual(["28d", "today"]);
});

test("기간 추이가 없거나 목록이 응답에 없으면 칸을 숨기고 한 줄 안내, 목록 null은 칸 안 실패, 행 수치 null은 확인 못 함", async ({
  page,
}) => {
  const base = localStatsView("28d");
  let body: object = withoutTrends(base);
  await mockStats(page, () => ({ body }));
  await openStats(page);

  // trends 없음: 추이 칸 모두 숨김 + 기간 표시 아래 한 줄(기간 표시는 기간 이름)
  await expect(page.getByText(MISSING_ALL, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Google Analytics · 비식별 이용 이벤트만 수집해요 · 최근 28일"),
  ).toBeVisible();
  for (const name of [
    "일별 사용자",
    "시간대별 사용자",
    "일별 화면 조회",
    "많이 본 화면",
    "들어온 경로",
  ]) {
    await expect(section(page, name)).toHaveCount(0);
  }
  await expect(page.getByText("새 사용자 비율")).toHaveCount(0);
  await expectNoA11yViolations(page);

  // 목록 일부만 응답에 있음: referrers 없음(숨김·줄), hourly null(칸 안 실패), 행 수치 null
  const trends = { ...base.trends! } as Record<string, unknown>;
  delete trends.referrers;
  body = {
    ...base,
    trends: {
      ...trends,
      hourly: null,
      previous: { ...base.trends!.previous!, pageViews: null },
      daily: {
        rows: [
          { date: "2026-11-12", activeUsers: 120, pageViews: 300 },
          { date: "2026-11-13", activeUsers: null, pageViews: 280 },
        ],
        metadata: NO_LIMITS,
      },
      topScreens: {
        rows: [
          { path: "/", pageViews: null, other: false },
          { path: "/spots/gwangalli/", pageViews: 4, other: false },
          { path: "/admin-preview/", pageViews: 3, other: false },
          { path: "(other)", pageViews: 2, other: true },
        ],
        metadata: NO_LIMITS,
      },
    },
    period: {
      ...base.period,
      // 5개 이상이면 도넛은 앞 3개 + 기타
      languages: [
        { language: "ko", activeUsers: 100 },
        { language: "en", activeUsers: 40 },
        { language: "ja", activeUsers: 20 },
        { language: "zh", activeUsers: 10 },
        { language: "fr", activeUsers: 10 },
      ],
    },
  };
  await page.getByRole("button", { name: "새로 고침" }).click();
  await expect(
    page.getByText("들어온 경로는 아직 보여 드릴 수 없어요", { exact: true }),
  ).toBeVisible();
  await expect(section(page, "들어온 경로")).toHaveCount(0);
  // 일별: 값이 없는 날은 0이 아닌 옅은 빈칸 + 표 '–' + 범례
  const daily = section(page, "일별 사용자");
  await expect(daily.getByText("11/12").first()).toBeAttached();
  await expect(daily.locator("svg rect")).toHaveCount(2);
  await expect(daily.locator("svg rect[data-empty]")).toHaveCount(1);
  await expect(daily.getByRole("cell", { name: "–" })).toBeAttached();
  await expect(daily.getByText("· 옅은 칸은 확인 못 한 값이에요")).toBeVisible();
  await expect(section(page, "일별 화면 조회").locator("svg rect[data-empty]")).toHaveCount(0);
  await expect(
    section(page, "시간대별 사용자").getByText(/이 항목을 불러오지 못했어요/),
  ).toBeVisible();
  // 앞 기간 화면 조회 null: 사용자만 배지, 화면 조회는 '앞 28일 –'
  const kpi = page.locator("dl");
  await expect(kpi.getByText("+18.4%")).toHaveCount(1);
  await expect(kpi.getByText("앞 28일 –")).toBeVisible();
  const languages = section(page, "화면 언어");
  await expect(languages.getByRole("listitem")).toHaveCount(4);
  // 기타 = zh 10 + fr 10 → 20 / 180 = 11%
  await expect(
    languages.getByRole("listitem").filter({ hasText: "기타" }),
  ).toContainText("11%");
  // 많이 본 화면: 수치 null은 그 자리만 확인 못 함, 해변 이름 못 찾음, 모르는 경로는 경로 그대로, (other)는 기타
  const screens = section(page, "많이 본 화면");
  await expect(
    screens.getByRole("listitem").filter({ hasText: "홈" }),
  ).toContainText("확인 못 함");
  await expect(screens.getByText("이름 확인 못 함")).toBeVisible();
  await expect(screens.getByText(/gwangalli/)).toHaveCount(0);
  await expect(screens.getByText("/admin-preview/", { exact: true })).toBeVisible();
  await expect(screens.getByText("기타", { exact: true })).toBeVisible();
  await expect(screens.getByText("(other)")).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test("GA4 속성 시간대가 서울과 다르면 기간 표시 옆에 알리고, 받지 못한 목록은 그 사유로 안내", async ({
  page,
}) => {
  const base = localStatsView("28d");
  await mockStats(page, () => ({
    body: {
      ...base,
      trends: {
        ...base.trends!,
        ga4TimeZone: "America/Los_Angeles",
        timeZoneMismatch: true,
        daily: null,
        hourly: null,
        previous: null,
        topScreens: null,
        referrers: null,
        newUsers: null,
        newUsersMetadata: null,
      },
    },
  }));
  await openStats(page);
  await expect(page.getByText("통계 기준 시간대가 달라요")).toBeVisible();
  await expect(page.getByText(/GA4 속성 시간대 America\/Los_Angeles/)).toBeVisible();
  for (const name of ["일별 사용자", "시간대별 사용자", "많이 본 화면", "들어온 경로"]) {
    await expect(
      section(page, name).getByText(/GA4 속성 시간대가 서울과 달라/),
    ).toBeVisible();
  }
  // 목록이 null이면 칸은 남음(한 줄 안내 없음), 새 사용자 비율은 –
  await expect(page.getByText(/아직 보여 드릴 수 없어요/)).toHaveCount(0);
  await expect(page.locator("dl").getByText("앞 기간 대비")).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test("이름표에 없는 해변은 slug·경로가 아니라 '이름 확인 못 함'", async ({
  page,
}) => {
  const base = localStatsView("28d");
  await mockStats(page, () => ({
    body: {
      ...base,
      period: {
        ...base.period,
        topBeaches: [
          { path: "/spots/gwangalli", slug: "gwangalli", pageViews: 64 },
          { path: "/spots/", slug: null, pageViews: 3 },
        ],
      },
    },
  }));
  await openStats(page);
  const beaches = section(page, "많이 본 해변");
  await expect(beaches.getByText("이름 확인 못 함")).toHaveCount(2);
  await expect(beaches.getByText(/gwangalli|\/spots/)).toHaveCount(0);
});

test("숫자 숨김 안내는 응답을 받은 뒤 metadata가 있을 때만, 빈 값(null)은 0이 아닌 확인 못 함·–", async ({
  page,
}) => {
  const base = localStatsView("28d");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/ops\/stats(\?.*)?$/, async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...base,
        cached: true,
        realtime: { status: "ok", activeUsers: null, pageViews: 10 },
        period: {
          ...base.period,
          devices: [
            { category: "mobile", activeUsers: null },
            { category: "desktop", activeUsers: 40 },
          ],
          metadata: { thresholding: true, sampling: true, otherRowLoss: false },
        },
        // 추이 목록의 metadata도 같은 안내로 합침('기타' 묶음)
        trends: {
          ...base.trends!,
          referrers: {
            ...base.trends!.referrers!,
            metadata: { thresholding: false, sampling: false, otherRowLoss: true },
          },
        },
      }),
    });
  });
  await openStats(page);
  // 응답 전: 자리표시만, 숨김 안내 자리는 두지 않음(L7). 첫 응답 전에는 지금 서버가 주는 칸 모두 자리표시
  await expect(page.locator("#main .sk").first()).toBeVisible();
  await expect(page.getByText(/일부 숫자 숨김이 있어요/)).toHaveCount(0);
  await expect(page.getByText(MISSING_ALL)).toHaveCount(0);
  await expect(section(page, "일별 사용자").locator(".sk").first()).toBeVisible();
  await expect(section(page, "많이 본 화면").locator(".sk").first()).toBeAttached();
  release();

  await expect(page.getByText("잠시 저장된 응답")).toBeVisible();
  const notice = page
    .getByRole("status")
    .filter({ hasText: "이 기간 결과에 일부 숫자 숨김이 있어요." });
  await expect(notice).toBeVisible();
  await expect(notice.getByText(/GA가 가렸어요/)).toBeVisible();
  await expect(notice.getByText(/표본으로 계산/)).toBeVisible();
  await expect(notice.getByText(/'기타'로 묶였어요/)).toBeVisible();
  // 지금 사용 중 숫자가 비면 확인 못 함
  await expect(page.getByText("확인 못 함", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("0명", { exact: true })).toHaveCount(0);
  // 기기 합을 알 수 없으면 비율·합계를 추정하지 않음. 받은 행(PC 40명)은 남기고 결측 행만 확인 못 함
  const devices = section(page, "기기");
  await expect(devices.getByText("–").first()).toBeVisible();
  await expect(
    devices.getByRole("listitem").filter({ hasText: "PC" }),
  ).toContainText("40명");
  await expect(
    devices.getByRole("listitem").filter({ hasText: "모바일" }),
  ).toContainText("확인 못 함");
  await expect(devices.getByText(/%$/)).toHaveCount(0);
  await expect(
    devices.getByText("합계를 확인하지 못해 비율 대신 사용자 수예요"),
  ).toBeVisible();
  await expectNoA11yViolations(page);
});

test("GA4 미연결(configured: false)과 조회 실패(500) 뒤 같은 자리에서 다시 시도", async ({
  page,
}) => {
  await mockStats(page, () => ({
    body: { ...localStatsView("28d"), configured: false },
  }));
  await openStats(page);
  await expect(
    page.getByText("GA4 연동이 아직 설정되지 않았어요"),
  ).toBeVisible();
  await expectNoA11yViolations(page);

  await page.unroute(/\/ops\/stats(\?.*)?$/);
  await mockStats(page, () => ({
    status: 500,
    body: { error: { code: "internal", requestId: "req-1" } },
  }));
  await page.getByRole("button", { name: "새로 고침" }).click();
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "이용 통계를 불러오지 못했어요." });
  await expect(alert).toBeVisible();
  await expect(alert.getByText("오류 번호 req-1")).toBeVisible();

  await page.unroute(/\/ops\/stats(\?.*)?$/);
  await mockStats(page, () => ({ body: localStatsView("28d") }));
  await alert.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByText("14명", { exact: true })).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test("새로 고침하는 동안 받은 값을 두고 회전 표시, 응답이 15초 넘게 없으면 같은 자리에서 실패", async ({
  page,
}) => {
  await page.clock.install();
  await mockStats(page, () => ({ body: localStatsView("28d") }));
  await openStats(page);
  await expect(page.getByText("14명", { exact: true })).toBeVisible();

  await page.unroute(/\/ops\/stats(\?.*)?$/);
  await page.route(/\/ops\/stats(\?.*)?$/, () => new Promise<void>(() => {}));
  await page.getByRole("button", { name: "새로 고침" }).click();
  await expect(page.getByText("다시 읽는 중")).toBeVisible();
  // 값 유지(자리표시로 바꾸지 않음)
  await expect(page.getByText("14명", { exact: true })).toBeVisible();
  await expect(section(page, "많이 본 해변").getByText("해운대해수욕장")).toBeVisible();

  // 기간을 바꾸면 다른 기간 값이라 자리표시, 15초 뒤 같은 자리 실패
  await page.getByRole("button", { name: "7일" }).click();
  await expect(page.getByText("14명", { exact: true })).toHaveCount(0);
  await page.clock.fastForward(16_000);
  await expect(
    page.getByRole("alert").filter({ hasText: "이용 통계를 불러오지 못했어요." }),
  ).toBeVisible();
});

test("예시 데이터 배지와 세부 리포트 일부 실패(null) 구분 표시", async ({
  page,
}) => {
  const base = localStatsView("28d");
  await mockStats(page, () => ({
    body: {
      ...base,
      sample: true,
      period: {
        ...base.period,
        topBeaches: null,
      },
    },
  }));
  await openStats(page);

  await expect(page.getByText("예시 데이터")).toBeVisible();
  await expect(
    section(page, "많이 본 해변").getByText(
      "이 항목을 불러오지 못했어요. 다른 칸은 그대로예요. 잠시 뒤 다시 시도해 주세요.",
    ),
  ).toBeVisible();
  await expect(
    page.getByText("집계된 해변 방문 기록이 없어요."),
  ).toHaveCount(0);
  await expectNoA11yViolations(page);
});
