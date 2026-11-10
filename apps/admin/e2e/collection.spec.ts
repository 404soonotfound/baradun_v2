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
import {
  VIEW,
  VIEW_DEGRADED,
  VIEW_LATE,
  VIEW_LEGACY,
  VIEW_MANY,
} from "./collection-data";

// 데이터 수집 현황 (BRD-149·GH-376, 화면 설계서 6장 ADM-COLLECT). 운영 API는 가짜 응답

const OPS = "ops@example.test";
async function mockCollection(page: Page, status = 200, view: object = VIEW) {
  let calls = 0;
  await page.route(/\/ops\/collection$/, async (route: Route) => {
    calls += 1;
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(
        status === 200
          ? view
          : { error: { code: "internal", requestId: "req-7f3a2c91" } },
      ),
    });
  });
  return () => calls;
}

async function openCollection(page: Page) {
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
    .getByRole("link", { name: "데이터 수집 현황" })
    .click();
  await expect(
    page.getByRole("heading", { name: "데이터 수집 현황", level: 1 }),
  ).toBeVisible();
}

// 표(태블릿·PC) 또는 카드(모바일) 중 보이는 출처 줄
const sourceRow = (page: Page, name: string) =>
  (isMobile(page)
    ? page.getByRole("region", { name: "출처별 수집" }).locator("ul > li")
    : page.locator("tbody tr")
  )
    .filter({ visible: true })
    .filter({ hasText: name });

test("출처별 상태(시안 V9·VM2): 정상·일부 실패·기록 없음을 글자로 나누고 운영 기간은 수집하지 않는다고 보여 준다", async ({
  page,
}) => {
  await mockCollection(page);
  await openCollection(page);
  await expect(sourceRow(page, "기상청 해상 특보")).toContainText("정상");
  await expect(sourceRow(page, "기상청 해상 특보")).toContainText("99.8%");
  await expect(sourceRow(page, "기상청 해양 관측")).toContainText("일부 실패");
  await expect(sourceRow(page, "국립해양조사원 이안류")).toContainText(
    "기록 없음",
  );
  // 날씨 예보(BRD-181)도 기록이 없으면 '기록 없음'(정상으로 보지 않음)
  await expect(sourceRow(page, "기상청 날씨 예보")).toContainText("기록 없음");
  await expect(sourceRow(page, "해양수산부 운영 기간")).toContainText(
    "수집하지 않음",
  );
  // 요약: 정상은 마지막 실행이 모두 성공한 출처만(해상 특보·사진)
  await expect(page.getByText("2/5", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: /^최근 24시간 96회 중 95회 성공 · 실패 1시간/,
    }),
  ).toHaveCount(1);
  // 해양 관측: 지연 1시간을 막대 요약에서도 읽음(색만으로 나누지 않음)
  await expect(
    page.getByRole("img", {
      name: /^최근 24시간 48회 중 47회 성공 · 실패 1시간 · 지연 1시간/,
    }),
  ).toHaveCount(1);
  await expect(page.getByRole("list", { name: "막대 범례" })).toContainText(
    "정상지연실패기록 없음",
  );
  await expectNoA11yViolations(page);
});

test("장애 기록: 최신 먼저, 이어지는 장애·해결, 출처 code와 모르는 사유를 숨기지 않는다", async ({
  page,
}) => {
  await mockCollection(page);
  await openCollection(page);
  const incidents = page
    .getByRole("region", { name: /장애 기록/ })
    .getByRole("listitem");
  await expect(incidents).toHaveCount(3);
  await expect(incidents.first()).toContainText(
    "기상청 해양 관측 · 기타 사유(새로운 사유)",
  );
  await expect(incidents.first()).toContainText("이어지는 중");
  await expect(incidents.nth(1)).toContainText(
    "기상청 해양 관측 · 관측소 1곳 값이 빠짐",
  );
  await expect(incidents.nth(2)).toContainText("출처 오류 코드 22");
  await expect(incidents.nth(2)).toContainText("LIMITED NUMBER");
  await expect(incidents.nth(2)).toContainText("해결");
});

test("불러오지 못하면 앱 영향 없음과 요청 번호, 다시 시도를 보여 준다", async ({
  page,
}) => {
  const calls = await mockCollection(page, 500);
  await openCollection(page);
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "수집 현황을 불러오지 못했어요" });
  await expect(alert).toContainText("수집 현황을 불러오지 못했어요");
  await expect(alert).toContainText("앱의 수집·게시는 그대로");
  await expect(alert).toContainText("req-7f3a2c91");
  const before = calls();
  await alert.getByRole("button", { name: "다시 시도" }).click();
  await expect.poll(calls).toBe(before + 1);
});

test("요약 4칸과 알림: 관측 지연 해변·검증 통과 게시본, 울리는 경보 먼저, 모르는 경보도 이름 그대로", async ({
  page,
}) => {
  await mockCollection(page);
  await openCollection(page);
  const kpi = (name: string) =>
    page
      .locator("dl > div")
      .filter({ has: page.getByText(name, { exact: true }) });
  await expect(kpi("관측 지연 해변")).toContainText("3곳");
  await expect(kpi("관측 지연 해변")).toContainText("게시본 214곳 중");
  await expect(kpi("마지막 게시")).toContainText("검증 통과 · 해변 214곳");

  const alerts = page
    .getByRole("region", { name: "알림" })
    .getByRole("listitem");
  await expect(alerts.first()).toContainText("기상청 해양 관측 응답 없음");
  await expect(alerts.first()).toContainText("울림");
  await expect(alerts.first()).toContainText("60분 기준");
  await expect(alerts.filter({ hasText: "SomethingNew" })).toContainText(
    "기준 시간 모름",
  );
  await expect(
    page.getByRole("link", { name: /CloudWatch에서 보기/ }),
  ).toHaveAttribute(
    "href",
    /ap-northeast-2\.console\.aws\.amazon\.com\/cloudwatch/,
  );
  await expectNoA11yViolations(page);
});

test("장애 상세 시트: 원인·해변 영향·경과·경보를 보여 주고 ↑↓로 옮기며 Esc로 닫으면 포커스가 돌아온다", async ({
  page,
}) => {
  await mockCollection(page);
  await openCollection(page);
  const opener = page
    .getByRole("region", { name: /장애 기록/ })
    .getByRole("button", { name: /관측소 1곳 값이 빠짐/ });
  await opener.click();
  const sheet = page.getByRole("dialog", { name: /관측소 1곳 값이 빠짐/ });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("2/3");
  await expect(sheet).toContainText("새로 관측 지연으로 게시된 해변 2곳");
  await expect(sheet).toContainText("강문해수욕장");
  await expect(sheet).toContainText("경포해수욕장");
  await expect(sheet).toContainText("강릉 부이 (22105)");
  await expect(sheet).toContainText("쓰는 해변 3곳 · 파고로 2곳");
  await expect(sheet).toContainText("관측소 22105 값 돌아옴");
  // 빠진 관측소 장애는 경보가 붙지 않음 → '확인 못 함'이 아니라 울리지 않는다고 안내
  await expect(sheet).toContainText("경보가 울리지 않아요");
  await expect(sheet).not.toContainText("경보 기록을 확인하지 못했어요");
  await expectNoA11yViolations(page);

  // 위: 이어지는 해양 관측 실패. 어느 관측소인지 모르면 영향 '확인 못 함'
  await page.keyboard.press("ArrowUp");
  const first = page.getByRole("dialog", { name: /기타 사유\(새로운 사유\)/ });
  await expect(first).toContainText("1/3");
  await expect(first).toContainText("해변 영향을 확인하지 못했어요");
  await expect(first).toContainText("실행 기록 kma_buoy · 새로운 사유");

  // 아래 두 번: 해상 특보 장애. 출처 응답 code·메시지와 경보·Lambda 링크
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const last = page.getByRole("dialog", { name: /출처 오류 코드 22/ });
  await expect(last).toContainText("3/3");
  await expect(last).toContainText("22 · LIMITED NUMBER");
  await expect(last).toContainText("경보 울림 · 기상청 해상 특보 실행 오류");
  await expect(last.getByRole("link", { name: /^Lambda/ })).toHaveAttribute(
    "href",
    /lambda\/home\?region=ap-northeast-2#\/functions\/BaradunV2-Warnings/,
  );
  // 해상 특보는 관측소를 쓰지 않아 해변 영향 칸이 없음
  await expect(last).not.toContainText("해변 영향");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("게시 요약·경보를 읽지 못하면 '확인 못 함'으로 두고 영향 없음·경보 없음으로 바꾸지 않는다", async ({
  page,
}) => {
  await mockCollection(page, 200, VIEW_DEGRADED);
  await openCollection(page);
  const kpi = page
    .locator("dl > div")
    .filter({ has: page.getByText("관측 지연 해변", { exact: true }) });
  await expect(kpi).toContainText("확인 못 함");
  await expect(
    page
      .locator("dl > div")
      .filter({ has: page.getByText("마지막 게시", { exact: true }) }),
  ).toContainText("요약 없음");
  await expect(page.getByRole("region", { name: "알림" })).toContainText(
    "경보 상태를 불러오지 못했어요",
  );
  await page
    .getByRole("region", { name: /장애 기록/ })
    .getByRole("button", { name: /관측소 1곳 값이 빠짐/ })
    .click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("게시 요약을 읽지 못했어요");
  // 실패 장애(위)로 옮겨 경보 '확인 못 함'을 봄
  await page.keyboard.press("ArrowUp");
  await expect(sheet).toContainText("1/3");
  await expect(sheet).toContainText("경보 기록을 확인하지 못했어요");
  await expect(sheet).not.toContainText("울린 경보가 없어요");
  await expectNoA11yViolations(page);
});

test("마지막 실행이 성공이어도 지연 기준을 넘긴 출처는 '지연'으로 보여 준다", async ({
  page,
}) => {
  await mockCollection(page, 200, VIEW_LATE);
  await openCollection(page);
  await expect(sourceRow(page, "기상청 해상 특보")).toContainText("지연");
  await expect(sourceRow(page, "기상청 해상 특보")).toContainText(
    "20분 넘으면 지연",
  );
  await expect(page.getByText("1/5", { exact: true })).toBeVisible();
});

test("처음 불러오는 동안 자리 표시와 안내를 보여 준다", async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/ops\/collection$/, async (route: Route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(VIEW),
    });
  });
  await openCollection(page);
  await expect(page.getByText("수집 기록을 불러오고 있어요.")).toBeVisible();
  release();
  await expect(page.getByText("2/5", { exact: true })).toBeVisible();
});

test("출처 거르기(시안 V9): 판단에 씀·참고·문제 있음으로 줄을 거르고 수를 함께 보여 준다", async ({
  page,
}) => {
  await mockCollection(page);
  await openCollection(page);
  const filters = page.getByRole("group", { name: "출처 거르기" });
  await expect(filters.getByRole("button", { name: /^전체/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await filters.getByRole("button", { name: /^문제 있음/ }).click();
  // 해양 관측(일부 실패)·이안류(기록 없음). 날씨는 응답에 없어 기록 없음
  await expect(sourceRow(page, "기상청 해양 관측")).toHaveCount(1);
  await expect(sourceRow(page, "국립해양조사원 이안류")).toHaveCount(1);
  await expect(sourceRow(page, "기상청 해상 특보")).toHaveCount(0);
  await expect(sourceRow(page, "해양수산부 운영 기간")).toHaveCount(0);
  await filters.getByRole("button", { name: /^판단에 씀/ }).click();
  await expect(sourceRow(page, "기상청 해상 특보")).toHaveCount(1);
  await expect(sourceRow(page, "한국관광공사 사진")).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test("장애 목록: 해변 영향 요약을 줄에 보여 주고 5건씩 쪽을 나눈다", async ({
  page,
}) => {
  await mockCollection(page, 200, VIEW_MANY);
  await openCollection(page);
  const region = page.getByRole("region", { name: /장애 기록/ });
  const items = region.getByRole("listitem");
  await expect(items).toHaveCount(5);
  await expect(items.first()).toContainText("해변 영향 확인 못 함");
  await expect(items.nth(1)).toContainText("새 관측 지연 해변 2곳");
  const pager = region.getByRole("navigation", { name: "장애 기록 쪽 이동" });
  await expect(pager).toContainText("7건 중 1–5 · 5건씩");
  await pager.getByRole("button", { name: "다음" }).click();
  await expect(items).toHaveCount(2);
  await expect(pager).toContainText("7건 중 6–7");
  await expect(pager.getByRole("button", { name: "다음" })).toBeDisabled();
});

test("운영 API가 예전 응답을 보내도 화면이 깨지지 않고 확인 못 함·예전 응답 안내를 보여 준다", async ({
  page,
}) => {
  await mockCollection(page, 200, VIEW_LEGACY);
  await openCollection(page);
  await expect(
    page.getByText("운영 API가 아직 예전 응답을 보내고 있어요."),
  ).toBeVisible();
  await expect(
    page
      .locator("dl > div")
      .filter({ has: page.getByText("관측 지연 해변", { exact: true }) }),
  ).toContainText("확인 못 함");
  await expect(page.getByRole("region", { name: "알림" })).toContainText(
    "경보 상태를 불러오지 못했어요",
  );
  // 마지막 실행이 성공이어도 지연을 판정하지 못했으니 정상으로 세지 않음
  await expect(sourceRow(page, "기상청 해상 특보")).toContainText(
    "지연 확인 못 함",
  );
  await expect(sourceRow(page, "기상청 해상 특보")).not.toContainText("정상");
  await expect(page.getByText("0/5", { exact: true })).toBeVisible();
  // 지연 기준을 모르니 '지연 표시 안 함'·'N분 넘으면 지연'을 쓰지 않음
  await expect(sourceRow(page, "기상청 해상 특보")).not.toContainText(
    "지연 표시 안 함",
  );
  await expect(sourceRow(page, "기상청 해상 특보")).not.toContainText(
    "넘으면 지연",
  );
  await expectNoA11yViolations(page);
});

test("200이어도 본문 모양이 틀리면 빈 화면이 아니라 불러오지 못함으로 보여 준다", async ({
  page,
}) => {
  await page.route(/\/ops\/collection$/, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    }),
  );
  await openCollection(page);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "수집 현황을 불러오지 못했어요" }),
  ).toBeVisible();
  await expect(page.getByText("기록 없음")).toHaveCount(0);
});

test("장애 목록이 빠진(null) 응답은 '장애 없음'이 아니라 불러오지 못함으로 보여 준다 (Codex P1)", async ({
  page,
}) => {
  const broken = {
    ...VIEW,
    jobs: VIEW.jobs.map((job, i) =>
      i === 0 ? { ...job, incidents: null } : job,
    ),
  };
  await mockCollection(page, 200, broken);
  await openCollection(page);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "수집 현황을 불러오지 못했어요" }),
  ).toBeVisible();
  await expect(page.getByText("최근 7일 장애가 없어요.")).toHaveCount(0);
});

test("해변 영향 '없음'은 이 장애의 관측소 범위에서 새로 지연된 해변이 없다는 뜻으로만 보여 준다 (Codex P2)", async ({
  page,
}) => {
  const none = {
    ...VIEW,
    jobs: VIEW.jobs.map((job) => ({
      ...job,
      incidents: job.incidents.map((incident) =>
        incident.kind === "stations"
          ? {
              ...incident,
              impact: {
                status: "none",
                wholeSource: false,
                delayedBeachIds: [],
                stations: [
                  {
                    id: "22105",
                    name: "강릉 부이",
                    beaches: 3,
                    waveBeaches: 2,
                  },
                ],
              },
            }
          : incident,
      ),
    })),
  };
  await mockCollection(page, 200, none);
  await openCollection(page);
  const region = page.getByRole("region", { name: /장애 기록/ });
  await expect(region.getByRole("listitem").nth(1)).toContainText(
    "새 관측 지연 해변 없음",
  );
  await region.getByRole("button", { name: /관측소 1곳 값이 빠짐/ }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "장애 전부터 지연이던 해변과 범위 밖 해변은 세지 않아요",
  );
});
