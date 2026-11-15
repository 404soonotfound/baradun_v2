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
  tokensFor,
} from "./fixtures";

// 해변 관리 목록·상세 (BRD-150·GH-329, 화면 설계서 6장 ADM-BCH). 운영 API는 가짜 응답
// - 해변 정보는 빌드 때 저장소 파일에서 읽은 값(실제 data/). 지금 표시 상태·운영 메모만 운영 API
// - 상태를 못 받으면 모든 해변이 '확인 못 함'(판단불가 계열). '특보 없음'으로 보이지 않아야 함

const OPS = "ops@example.test";

// 게시 분류를 믿을 수 있는 시각. 시험 중 지나지 않게 지금보다 뒤로 둠
const VALID_UNTIL = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

// 게시본 파고·파주기(#502). 측정 칸이 오늘 시각(HH:MM)으로 보이게 지금 기준으로 둠
const minutesAgo = (m: number) =>
  new Date(Date.now() - m * 60_000).toISOString();
const wave = (
  unit: "m" | "s",
  value: number | null,
  observedAt: string | null,
  state: "fresh" | "delayed" | "none",
) => ({ value, unit, observedAt, state });

const PUBLISHED = {
  available: true,
  snapshotVersion: "20261111T030000Z",
  generatedAt: "2026-11-11T03:00:12Z",
  maintenance: { active: false, until: null },
  beaches: {
    b0001: {
      category: "clear",
      reasons: [],
      validUntil: VALID_UNTIL,
      observation: {
        metrics: {
          waveHeight: wave("m", 0.6, minutesAgo(1), "fresh"),
          wavePeriod: wave("s", 8, minutesAgo(1), "fresh"),
        },
      },
    },
    b0002: {
      category: "unavailable",
      validUntil: VALID_UNTIL,
      observation: {
        metrics: {
          waveHeight: wave("m", 1.8, minutesAgo(1), "fresh"),
          // 모양이 틀린 칸은 그 칸만 '확인 못 함'
          wavePeriod: wave("s", null, minutesAgo(1), "fresh"),
        },
      },
      reasons: [
        {
          code: "warning",
          type: "wind_wave",
          level: "advisory",
          scope: "강원중부앞바다",
          source: "기상청",
          at: "2026-11-11T02:00:00Z",
        },
      ],
    },
    b0004: {
      category: "undetermined",
      validUntil: VALID_UNTIL,
      reasons: [
        {
          code: "observation_delayed",
          scope: "연곡 파고부이",
          source: "기상청",
          at: "2026-11-11T01:00:00Z",
        },
      ],
      observation: {
        metrics: {
          waveHeight: wave("m", 1.2, minutesAgo(2), "delayed"),
          wavePeriod: wave("s", null, null, "none"),
        },
      },
    },
  },
};

async function mockPublished(
  page: Page,
  reply: { status: number; body: unknown } = { status: 200, body: PUBLISHED },
) {
  let calls = 0;
  await page.route(/\/ops\/beaches\/published$/, async (route: Route) => {
    calls += 1;
    await route.fulfill({
      status: reply.status,
      contentType: "application/json",
      body: JSON.stringify(reply.body),
    });
  });
  return () => calls;
}

interface MemoState {
  memo: string | null;
  version: number;
  updatedAt: string | null;
}

async function mockMemo(
  page: Page,
  state: MemoState = { memo: null, version: 0, updatedAt: null },
) {
  const puts: { body: unknown; key: string | undefined }[] = [];
  let gets = 0;
  await page.route(/\/ops\/beaches\/b\d{4}\/memo$/, async (route: Route) => {
    const request = route.request();
    const beachId = /beaches\/(b\d{4})\//.exec(request.url())![1];
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as {
        version: number;
        memo: string | null;
      };
      puts.push({ body, key: request.headers()["x-idempotency-key"] });
      if (body.version !== state.version) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "conflict",
              reason: "version",
              requestId: "req-409",
            },
          }),
        });
        return;
      }
      state.memo = body.memo;
      state.version += 1;
      state.updatedAt = "2026-11-11T03:10:00Z";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ beachId, version: state.version }),
      });
      return;
    }
    gets += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ beachId, ...state }),
    });
  });
  return { puts, gets: () => gets, state };
}

async function signIn(page: Page, groups: string[]) {
  const sample = groups.includes("sample");
  const authTime = Math.floor(Date.now() / 1000) - 60;
  await mockCognito(
    page,
    srpScript({ email: OPS, after: "tokens", groups, authTime }),
    (target) =>
      target === "GetTokensFromRefreshToken"
        ? {
            body: {
              AuthenticationResult: tokensFor(OPS, groups, 900, authTime),
            },
          }
        : undefined,
  );
  await mockOps(
    page,
    sample
      ? {
          status: 200,
          body: {
            kind: "sample",
            role: "sample",
            authTime: "",
            sessionExpiresAt: "",
          },
        }
      : ME_OK,
  );
  await signInWithPassword(page, sample ? "/login/demo/" : "/login/", OPS);
  await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
  await expectHomeLoaded(page);
}

async function openBeaches(page: Page) {
  await openMenu(page);
  await page
    .getByRole("navigation", { name: "운영 메뉴" })
    .filter({ visible: true })
    .getByRole("link", { name: "해변", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "해변", level: 1 }),
  ).toBeVisible();
}

// 화면 너비에 맞는 해변 한 줄(PC 표 줄, 모바일 카드)
const beachRow = (page: Page, name: string) =>
  (isMobile(page) ? page.locator("main ul > li") : page.locator("tbody tr"))
    .filter({ visible: true })
    .filter({ hasText: name });

const allBeachRows = (page: Page) =>
  (isMobile(page)
    ? page.locator("main ul > li")
    : page.locator("tbody tr")
  ).filter({ visible: true });

const tabButton = (page: Page, label: string) =>
  page
    .getByRole("group", { name: "해변 분류" })
    .filter({ visible: true })
    .getByRole("button", { name: new RegExp(`^${label}(?:\\s|\\d|—|$)`) });

// 모바일 카드·표에 axe를 돌릴 때 한 줄로 좁혀 빠르게 검사
async function narrowForAxe(page: Page) {
  await page.getByLabel("해변 찾기").fill("강릉");
  await expect(page.getByText(/^\d+건 중 \d+–\d+$/)).not.toHaveText(
    "222건 중 1–11",
  );
}

async function openDetail(page: Page, name: string) {
  const row = beachRow(page, name);
  if ((await row.count()) === 0) {
    await page.getByLabel("해변 찾기").fill(name);
    await expect(row.first()).toBeVisible();
  }
  await row.getByRole("link", { name }).first().click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

test("목록: 저장소의 222곳을 한 줄 표(11행/쪽)·공식 특보 구역 이름으로 보여 주고 지금 표시 상태는 사유 먼저", async ({
  page,
}) => {
  await mockPublished(page);
  await signIn(page, ["viewer"]);
  await openBeaches(page);

  await expect(page.getByText("222건 중 1–11")).toBeVisible();
  await expect(page.getByText("1 / 21")).toBeVisible();
  await expect(allBeachRows(page)).toHaveCount(11);
  await expect(
    page.getByText(
      "해변 정보는 저장소가 원본이에요. 고치면 PR 머지 뒤 사이트가 다시 배포되면서 반영돼요.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /GitHub에서 고치기/ }),
  ).toHaveAttribute(
    "href",
    "https://github.com/404soonotfound/baradun_v2/tree/main/data/beaches",
  );
  // 편집 칸·노출 토글·일괄 변경·출입 통제·style 속성 없음
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(page.getByText("출입 통제")).toHaveCount(0);
  expect(await page.locator("main [style]").count()).toBe(0);

  // 탭별 개수 확인(판단불가 220, 이용불가 1, 비노출 0, 가까운 관측 없음 71, 구역 검증 안 됨 0)
  await expect(tabButton(page, "전체")).toContainText("222");
  await expect(tabButton(page, "판단불가")).toContainText("220");
  await expect(tabButton(page, "이용불가")).toContainText("1");
  await expect(tabButton(page, "비노출")).toContainText("0");
  await expect(tabButton(page, "가까운 관측 없음")).toContainText("71");
  await expect(tabButton(page, "구역 검증 안 됨")).toContainText("0");

  // 첫 쪽에 판단불가(관측 지연)·이용불가(풍랑주의보)·미확인 해변이 사유 먼저로 보임
  const blocked = beachRow(page, "경포해수욕장");
  await expect(blocked).toContainText("풍랑주의보");
  await expect(blocked).toContainText("이용불가");
  await expect(blocked).toContainText("강원중부앞바다");
  await expect(blocked).not.toContainText("S1151200");

  const delayed = beachRow(page, "사천진해수욕장");
  await expect(delayed).toContainText("관측 지연");
  await expect(delayed).toContainText("판단불가");

  // 게시본에 없는 해변은 '확인 못 함'(특보 없음으로 채우지 않음)
  const missing = beachRow(page, "금진해수욕장");
  await expect(missing).toContainText("확인 못 함");
  await expect(missing).not.toContainText("특보 없음");

  // PC(1280×800): 222곳 목록에서도 한 화면 안팎 높이·가로 넘침 없음
  if (!isMobile(page)) {
    const metrics = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    expect(metrics.scrollHeight).toBeLessThanOrEqual(1050);
  }

  await narrowForAxe(page);
  await expectNoA11yViolations(page);
});

test("목록: 탭·별칭 찾기·지역(지리순)·특보 구역·페이징·주소 쿼리 유지·키보드 행 열기·빈 목록", async ({
  page,
}) => {
  await mockPublished(page);
  await mockMemo(page);
  await signIn(page, ["viewer"]);
  await openBeaches(page);

  // 탭 거르기: '가까운 관측 없음'은 표시 필터일 뿐 앱 표시를 바꾸지 않음
  await tabButton(page, "가까운 관측 없음").click();
  await expect(page).toHaveURL(/\btab=no_station\b/);
  await expect(page.getByText("71건 중 1–11")).toBeVisible();
  await expect(allBeachRows(page).first()).toContainText("가까운 관측 없음");
  await expect(allBeachRows(page).first()).toContainText("확인 못 함");

  await tabButton(page, "이용불가").click();
  await expect(page).toHaveURL(/\btab=unavailable\b/);
  await expect(page.getByText("1건 중 1–1")).toBeVisible();
  await expect(beachRow(page, "경포해수욕장")).toBeVisible();

  await tabButton(page, "전체").click();
  await expect(page.getByText("222건 중 1–11")).toBeVisible();

  // 페이징 + 새로 고침·뒤로 가기 쿼리 유지
  await page.getByRole("button", { name: "다음 해변 목록 페이지" }).click();
  await expect(page).toHaveURL(/\bpage=2\b/);
  await expect(page.getByText("222건 중 12–22")).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\bpage=2\b/);
  await expect(page.getByText("222건 중 12–22")).toBeVisible();
  await page.goBack();
  await expect(page.getByText("222건 중 1–11")).toBeVisible();

  // 지역 필터(지리 순서) + 특보 구역 필터 + 새로 고침 유지
  await page.getByRole("button", { name: "지역", exact: true }).click();
  const regionMenu = page.getByRole("group", { name: "지역 고르기" });
  const regionLabels = await regionMenu.getByRole("button").allTextContents();
  expect(regionLabels.slice(1)).toEqual([
    "강원",
    "경북",
    "울산",
    "부산",
    "경남",
    "전남",
    "전북",
    "충남",
    "인천",
    "제주",
  ]);
  await regionMenu
    .getByRole("button", { name: "강원", exact: true })
    .press("Enter");
  await expect(page).toHaveURL(/\bsido=%EA%B0%95%EC%9B%90\b/);
  await expect(page.getByText("91건 중 1–11")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "지역: 강원", exact: true }),
  ).toBeFocused();

  await page.getByRole("button", { name: "특보 구역", exact: true }).click();
  const zoneMenu = page.getByRole("group", { name: "특보 구역 고르기" });
  await zoneMenu
    .getByRole("button", { name: "강원중부앞바다", exact: true })
    .click();
  await expect(page).toHaveURL(/\bzone=S1151200\b/);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "지역: 강원", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "특보 구역: 강원중부앞바다",
      exact: true,
    }),
  ).toBeVisible();

  // 키보드로 행 열기 → 뒤로 가기 시 필터·탭 쿼리 복원
  const rowLink = beachRow(page, "경포해수욕장")
    .getByRole("link", { name: /경포해수욕장/ })
    .first();
  await rowLink.focus();
  await rowLink.press("Enter");
  await expect(
    page.getByRole("heading", { name: "경포해수욕장", level: 1 }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\bzone=S1151200\b/);

  // 조건 지우기 후 별칭 찾기('승공' → 상맹방해수욕장)
  await page.getByRole("button", { name: "지역 거르기 지우기" }).press("Enter");
  await expect(page).not.toHaveURL(/\bsido=/);
  await expect(
    page.getByRole("button", { name: "지역", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "특보 구역 거르기 지우기" }).click();
  await page.getByLabel("해변 찾기").fill("승공");
  await expect(beachRow(page, "상맹방해수욕장")).toHaveCount(1);

  // 빈 검색 안내 + 조건 지우기(시안 E7)
  await page.getByLabel("해변 찾기").fill("없는해변xyz");
  await expect(
    page.getByText('"없는해변xyz"는 해변 목록에 없어요'),
  ).toBeVisible();
  await expect(
    page.getByText(
      "출시에서 빠진 해변일 수 있어요. 새 해변은 저장소 PR로 넣어요.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "조건 지우기" }).click();
  await expect(page.getByText("222건 중 1–11")).toBeVisible();

  // 필터 선택 뒤 검색한 상태에서 뒤로 가면 남은 검색 초안도 함께 지워짐
  await page.getByRole("button", { name: "지역", exact: true }).click();
  await page
    .getByRole("group", { name: "지역 고르기" })
    .getByRole("button", { name: "강원", exact: true })
    .click();
  await expect(page).toHaveURL(/\bsido=%EA%B0%95%EC%9B%90\b/);
  await page.getByLabel("해변 찾기").fill("경포");
  await expect(page).toHaveURL(/\bq=%EA%B2%BD%ED%8F%AC\b/);
  await expect(beachRow(page, "경포해수욕장")).toHaveCount(1);
  await page.goBack();
  await expect(page).not.toHaveURL(/\bq=/);
  await expect(page.getByLabel("해변 찾기")).toHaveValue("");
  await expect(page.getByText("222건 중 1–11")).toBeVisible();
  await expectNoA11yViolations(page);
});

test("파고·파주기·측정은 게시값 그대로이고, 지연은 글로도 알리며 측정소 없음·틀린 칸은 값을 지어내지 않는다(#502)", async ({
  page,
}) => {
  await mockPublished(page);
  await signIn(page, ["viewer"]);
  await openBeaches(page);
  const search = page.getByLabel("해변 찾기");

  await search.fill("강문");
  const fresh = beachRow(page, "강문해수욕장");
  await expect(fresh).toContainText("0.6m");
  await expect(fresh).not.toContainText("연결됨");
  if (isMobile(page)) {
    await expect(fresh).toContainText("파고 0.6m");
  } else {
    await expect(fresh).toContainText("8초");
    await expect(fresh).toContainText(/\d{2}:\d{2}/);
  }

  await search.fill("사천진");
  const delayed = beachRow(page, "사천진해수욕장");
  if (isMobile(page)) {
    await expect(delayed).toContainText("파고 1.2m · 지연");
  } else {
    await expect(delayed).toContainText("1.2m");
    await expect(delayed).toContainText(/\d{2}:\d{2} · 지연/);
    // 파주기 측정소 없음은 '—'로 보이고 이름으로 읽힘
    await expect(delayed.getByLabel("가까운 관측 없음")).toHaveCount(1);
  }

  await search.fill("경포");
  const blocked = beachRow(page, "경포해수욕장");
  await expect(blocked).toContainText("1.8m");
  if (!isMobile(page)) {
    // 파주기 칸 모양이 틀림 → 그 칸만 '확인 못 함'
    await expect(blocked).toContainText("확인 못 함");
  }
  await narrowForAxe(page);
  await expectNoA11yViolations(page);
});

test("상태를 못 받으면 모든 해변이 판단불가 계열 '확인 못 함'이고 무슨 일·영향·다음 행동을 알린다", async ({
  page,
}) => {
  const calls = await mockPublished(page, {
    status: 500,
    body: { error: { code: "internal", requestId: "req-7f3a2c91" } },
  });
  await signIn(page, ["viewer"]);
  await openBeaches(page);
  const alert = page.getByRole("alert").filter({ hasText: "지금 표시 상태" });
  await expect(alert).toContainText("지금 표시 상태를 불러오지 못했어요");
  await expect(alert).toContainText(
    "앱 화면에 영향이 있는지는 여기서 알 수 없어요",
  );
  await expect(alert).toContainText("req-7f3a2c91");
  await expect(tabButton(page, "판단불가")).toContainText("222");
  await page.getByLabel("해변 찾기").fill("강문");
  await expect(beachRow(page, "강문해수욕장")).toContainText("확인 못 함");
  await expect(beachRow(page, "강문해수욕장")).not.toContainText("특보 없음");
  await expect(page.getByText("특보 없음", { exact: true })).toHaveCount(0);
  await alert.getByRole("button", { name: "다시 시도" }).click();
  await expect.poll(calls).toBe(2);
  await expectNoA11yViolations(page);
});

test("유효 시각이 지난 게시 상태는 분류를 그대로 두고 지남을 따로 알린다(G1)", async ({
  page,
}) => {
  const past = new Date(Date.now() - 5 * 60_000).toISOString();
  await mockPublished(page, {
    status: 200,
    body: {
      ...PUBLISHED,
      beaches: {
        ...PUBLISHED.beaches,
        b0001: { category: "clear", reasons: [], validUntil: past },
      },
    },
  });
  await mockMemo(page);
  await signIn(page, ["viewer"]);
  await openBeaches(page);
  await page.getByLabel("해변 찾기").fill("경포");
  await expect(beachRow(page, "경포해수욕장")).not.toContainText(
    "유효 시각 지남",
  );
  await page.getByLabel("해변 찾기").fill("강문");
  const row = beachRow(page, "강문해수욕장");
  await expect(row).toContainText("특보 없음");
  await expect(row).toContainText("유효 시각 지남");
  await openDetail(page, "강문해수욕장");
  const status = page.getByRole("region", { name: "지금 표시 상태" });
  await expect(status).toContainText("특보 없음");
  await expect(status).toContainText("게시 상태의 유효 시각이 지났어요");
  // 배지는 게시 분류 그대로(안내 문장 속 앱 설명과 구분해 배지 글자만 봄)
  await expect(
    status.getByText("특보 확인 못 함", { exact: true }),
  ).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test("게시본이 점검 중이면 상태 칸은 '점검 중 · 앱에 표시 안 함'이고 마지막 게시 분류는 그대로 함께 보인다(D23-11)", async ({
  page,
}) => {
  await mockPublished(page, {
    status: 200,
    body: {
      ...PUBLISHED,
      maintenance: { active: true, until: "2026-11-11T05:00:00Z" },
    },
  });
  await mockMemo(page);
  await signIn(page, ["viewer"]);
  await openBeaches(page);
  const notice = page.getByRole("status").filter({ hasText: "점검 중이에요" });
  await expect(notice).toContainText("앱이 지금 점검 중이에요");
  await expect(notice).toContainText("점검 예정");
  await expect(notice).toContainText("저장소의 점검 설정");
  await expect(
    page.getByText(/점검 중이라 앱에는 보이지 않아요/),
  ).toBeVisible();
  await page.getByLabel("해변 찾기").fill("강문");
  const row = beachRow(page, "강문해수욕장");
  await expect(row).toContainText("점검 중");
  await expect(row).toContainText("앱에 표시 안 함");
  await expect(row).toContainText("마지막 게시 분류");
  // 마지막 게시 분류는 바꾸지 않음(G1)
  await expect(row).toContainText("특보 없음");
  await expectNoA11yViolations(page);

  await openDetail(page, "강문해수욕장");
  const status = page.getByRole("region", { name: "지금 표시 상태" });
  await expect(status).toContainText("앱이 지금 점검 중이에요");
  await expect(status).toContainText("앱에 표시 안 함");
  await expect(status).toContainText("특보 없음");
  await expect(status).not.toContainText("앱과 같은 판단 결과예요");
  await expectNoA11yViolations(page);
});

test("게시 버킷이 아직 없으면(available: false) 정상처럼 보이지 않는다", async ({
  page,
}) => {
  await mockPublished(page, {
    status: 200,
    body: { available: false, reason: "not_configured" },
  });
  await signIn(page, ["viewer"]);
  await openBeaches(page);
  await expect(
    page.getByText("지금 표시 상태를 불러오지 못했어요"),
  ).toBeVisible();
  await openDetail(page, "강문해수욕장");
  const status = page.getByRole("region", { name: "지금 표시 상태" });
  await expect(status).toContainText("확인 못 함");
  // 앱이 무엇으로 게시했는지 모르므로 분류 이름(판단불가)을 붙이지 않음
  await expect(status).toContainText("게시본을 받지 못했어요");
  await expect(status).not.toContainText("판단불가");
  await expect(status).not.toContainText("특보 없음");
});

test("상세: 칸마다 GitHub에서 수정(해당 파일), 데이터 연결 출처는 5장 이름, 출입 통제·CCTV 줄 없음", async ({
  page,
}) => {
  await mockPublished(page);
  await mockMemo(page);
  await signIn(page, ["viewer"]);
  await openBeaches(page);
  await openDetail(page, "경포해수욕장");
  const status = page.getByRole("region", { name: "지금 표시 상태" });
  await expect(status).toContainText("풍랑주의보");
  await expect(status).toContainText("강원중부앞바다");
  await expect(status).toContainText("여기서 바꿀 수 없어요");

  const links = page.getByRole("region", { name: "데이터 연결" });
  for (const source of [
    "기상청 특보",
    "기상청 해양 관측",
    "해양수산부 운영 기간",
  ]) {
    await expect(links.getByRole("rowheader", { name: source })).toBeVisible();
  }
  await expect(links.getByRole("rowheader")).toHaveCount(3);
  await expect(links.getByRole("rowheader", { name: /CCTV|통제/ })).toHaveCount(
    0,
  );
  await expect(links).toContainText(
    "출입 통제·CCTV는 수집하지 않아 줄이 없어요.",
  );

  const edit = (section: string) =>
    page
      .getByRole("link", { name: new RegExp(`^${section} GitHub에서 수정`) })
      .filter({ visible: true })
      .first();
  await expect(edit("기본 정보")).toHaveAttribute(
    "href",
    "https://github.com/404soonotfound/baradun_v2/edit/main/data/beaches/b0002.json",
  );
  await expect(edit("별칭\\(찾기\\)")).toHaveAttribute(
    "href",
    "https://github.com/404soonotfound/baradun_v2/edit/main/data/beach-meta.json",
  );
  await expect(edit("검증 결과")).toHaveAttribute(
    "href",
    "https://github.com/404soonotfound/baradun_v2/edit/main/data/beach-coverage.csv",
  );
  await expect(edit("해양수산부 운영 기간")).toHaveAttribute(
    "href",
    /beach-meta\.json$/,
  );
  await expect(page.getByRole("region", { name: "검증 결과" })).toContainText(
    "해상 특보구역 대응",
  );
  await expect(
    page.getByRole("region", { name: "변경 이력" }).getByRole("link"),
  ).toHaveCount(3);
  // 보기 권한: 메모는 읽기만(비활성 + 안내)
  await expect(
    page.getByRole("textbox", { name: "운영 메모", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("운영 메모를 저장하려면 편집 권한이 필요해요."),
  ).toBeVisible();
  await expectNoA11yViolations(page);
});

test("운영 메모: 편집 권한이 저장하고 version이 다르면 덮어쓰지 않는다", async ({
  page,
}) => {
  await mockPublished(page);
  const memo = await mockMemo(page);
  await signIn(page, ["editor"]);
  await openBeaches(page);
  await openDetail(page, "강문해수욕장");
  const field = page.getByRole("textbox", { name: "운영 메모", exact: true });
  await expect(field).toBeEnabled();
  await expect(page.getByText("아직 저장한 메모가 없어요")).toBeVisible();
  await field.fill("주차장 공사 중");
  await page.getByRole("button", { name: "메모 저장" }).click();
  await expect(
    page.getByText("메모를 저장했어요. 앱에는 나가지 않아요."),
  ).toBeVisible();
  expect(memo.puts[0]?.body).toEqual({ version: 0, memo: "주차장 공사 중" });
  expect(memo.puts[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
  await expect(field).toHaveValue("주차장 공사 중");

  // 다른 운영자가 먼저 바꿈 → 409, 쓰던 내용은 그대로
  memo.state.version = 5;
  await field.fill("내가 쓴 다른 메모");
  await page.getByRole("button", { name: "메모 저장" }).click();
  await expect(
    page.getByText("다른 운영자가 먼저 메모를 바꿨어요.", { exact: false }),
  ).toBeVisible();
  await expect(field).toHaveValue("내가 쓴 다른 메모");
  await expect(
    page.getByRole("button", { name: "내 메모 복사" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "새 내용 불러오기" }).click();
  await expect(field).toHaveValue("주차장 공사 중");
  await expectNoA11yViolations(page);
});

test("데모 계정: 상태는 보이고 운영 메모는 요청하지 않는다", async ({
  page,
}) => {
  await mockPublished(page);
  const memo = await mockMemo(page);
  await signIn(page, ["sample"]);
  await openBeaches(page);
  await openDetail(page, "강문해수욕장");
  await expect(
    page.getByRole("region", { name: "지금 표시 상태" }),
  ).toContainText("특보 없음");
  await expect(
    page.getByText("데모 계정은 운영 메모를 볼 수 없어요."),
  ).toBeVisible();
  expect(memo.gets()).toBe(0);
  expect(memo.puts).toHaveLength(0);
});

test("로딩(L3·상세 메모): 해변 목록·'이용불가' 탭은 틀과 찾기를 유지하고 15초 실패 재시도", async ({
  page,
}) => {
  await page.clock.install();
  let holdPublished = true;
  await page.route(/\/ops\/beaches\/published$/, async (route: Route) => {
    if (holdPublished) {
      await new Promise<void>(() => {});
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PUBLISHED),
    });
  });
  await mockMemo(page, { memo: "강문 메모", version: 1, updatedAt: null });
  await signIn(page, ["editor"]);
  await openBeaches(page);

  await page.clock.fastForward(200);
  await expect(page.locator("main [aria-busy='true']")).toBeVisible();
  // 이용불가 탭(게시 대기 중) 전환 시에도 안내 문구 대신 표/카드 자리표시가 보임
  await tabButton(page, "이용불가").click();
  await expect(page.locator("main [aria-busy='true']")).toBeVisible();

  await page.clock.fastForward(15_500);
  const listAlert = page
    .getByRole("alert")
    .filter({ hasText: "응답이 15초 넘게 오지 않았어요" });
  await expect(listAlert).toBeVisible();

  holdPublished = false;
  await listAlert.getByRole("button", { name: "다시 시도" }).click();
  await expect(tabButton(page, "이용불가")).toContainText("1");
  await expect(allBeachRows(page)).toHaveCount(1);
});

test("로딩(해변 상세 메모): 15초 넘으면 메모 영역에 다시 시도를 보여 준다", async ({
  page,
}) => {
  await page.clock.install();
  let holdMemo = true;
  await mockPublished(page);
  await page.route(/\/ops\/beaches\/[^/]+\/memo$/, async (route: Route) => {
    if (holdMemo) {
      await new Promise<void>(() => {});
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        beachId: "b0001",
        memo: "현장 점검 메모",
        version: 1,
        updatedAt: null,
      }),
    });
  });
  await signIn(page, ["editor"]);
  await openBeaches(page);
  await openDetail(page, "강문해수욕장");

  await page.clock.fastForward(200);
  await expect(
    page
      .getByRole("region", { name: "운영 메모" })
      .locator("[aria-busy='true']"),
  ).toBeVisible();
  await page.clock.fastForward(15_500);
  const memoAlert = page
    .getByRole("region", { name: "운영 메모" })
    .getByRole("alert")
    .filter({ hasText: "응답이 15초 넘게 오지 않았어요" });
  await expect(memoAlert).toBeVisible();

  holdMemo = false;
  await memoAlert.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByRole("textbox", { name: "운영 메모" })).toHaveValue(
    "현장 점검 메모",
  );
});
