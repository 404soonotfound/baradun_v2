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
    .getByRole("link", { name: "수집 현황" })
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
  await expect(sourceRow(page, "기상청 날씨 예보")).toContainText("일부 실패");
  await expect(sourceRow(page, "기상청 날씨 예보")).toContainText(
    "180분 넘으면 지연",
  );
  await expect(sourceRow(page, "기상청 해양 관측")).toContainText(
    "35분 넘으면 지연",
  );
  await expect(sourceRow(page, "한국관광공사 사진")).toContainText(
    "지연 표시 안 함",
  );
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
    "기상청 해양 관측 · 알 수 없는 오류",
  );
  await expect(incidents.first()).toContainText("이어지는 중");
  await expect(incidents.nth(1)).toContainText(
    "기상청 해양 관측 · 관측소 1곳 값이 빠짐",
  );
  await expect(incidents.nth(2)).toContainText("호출 한도 초과");
  await expect(incidents.nth(2)).not.toContainText("LIMITED NUMBER");
  await expect(incidents.first()).not.toContainText("새로운 사유");
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

  const alerts = page.getByRole("region", { name: "알림" });
  await expect(alerts.locator("summary")).toHaveCount(4);
  await expect(alerts.locator("details[open] > summary")).toHaveCount(1);
  await expect(alerts.locator("details[open] > summary")).toContainText(
    "출처 응답 없음",
  );
  const ringing = alerts.getByRole("listitem").first();
  await expect(ringing).toContainText("기상청 해양 관측 응답 없음");
  await expect(ringing).toContainText("울림");
  await expect(ringing).toContainText("60분 기준");
  const other = alerts.locator("summary").filter({ hasText: "그 밖의 경보" });
  await expect(other).toContainText("1개 상태 확인 못 함");
  await expect(alerts.getByText("SomethingNew")).toBeHidden();
  await other.click();
  await expect(
    alerts.getByRole("listitem").filter({ hasText: "SomethingNew" }),
  ).toContainText("기준 시간 모름");
  await expect(
    page.getByRole("link", { name: /^CloudWatch/ }).first(),
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
  const first = page.getByRole("dialog", { name: /알 수 없는 오류/ });
  await expect(first).toContainText("1/3");
  await expect(first).toContainText("해변 영향을 확인하지 못했어요");
  await expect(first).toContainText("실행 기록 kma_buoy · 새로운 사유");

  // 아래 두 번: 해상 특보 장애. 출처 응답 code·메시지와 경보·Lambda 링크
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const last = page.getByRole("dialog", { name: /호출 한도 초과/ });
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
  // 정상 출처 수도 '0/5'가 아니라 '확인 못 함'
  await expect(page.getByText("0/5", { exact: true })).toHaveCount(0);
  await expect(
    page
      .locator("dl > div")
      .filter({ has: page.getByText("정상 출처", { exact: true }) }),
  ).toContainText("지연을 판정하지 못한 출처");
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

// 시트를 장애 번호로 들던 결함(Claude 리뷰 #378) 재현: 다시 불러오기·닫히는 중 다시 열기·불러오기 실패
async function mockSequence(page: Page, bodies: (object | number)[]) {
  let i = 0;
  await page.route(/\/ops\/collection$/, async (route: Route) => {
    const body = bodies[Math.min(i, bodies.length - 1)]!;
    i += 1;
    await route.fulfill(
      typeof body === "number"
        ? {
            status: body,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "internal" } }),
          }
        : {
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(body),
          },
    );
  });
}

const withoutStations = {
  ...VIEW,
  jobs: VIEW.jobs.map((job) => ({
    ...job,
    incidents: job.incidents.filter((incident) => incident.kind !== "stations"),
  })),
};

// 시트를 연 채 다시 불러오기(모달 밖 버튼은 눌리지 않아 페이지 스크립트로 누름. 다른 탭 재로그인과 같은 다시 불러오기)
async function reloadBehindSheet(page: Page) {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "다시 불러오기",
    );
    button?.click();
  });
}

test("연 장애가 다시 불러온 목록에 없으면 시트를 닫고, 다른 장애는 다시 열린다", async ({
  page,
}) => {
  await mockSequence(page, [VIEW, withoutStations]);
  await openCollection(page);
  const region = page.getByRole("region", { name: /장애 기록/ });
  await region.getByRole("button", { name: /관측소 1곳 값이 빠짐/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await reloadBehindSheet(page);
  await expect(region.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await region.getByRole("button", { name: /호출 한도 초과/ }).click();
  await expect(
    page.getByRole("dialog", { name: /호출 한도 초과/ }),
  ).toBeVisible();
});

test("시트가 닫히는 동안 다른 장애를 눌러도 그 장애 시트가 열린다", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await mockSequence(page, [VIEW]);
  await openCollection(page);
  const region = page.getByRole("region", { name: /장애 기록/ });
  await region.getByRole("button", { name: /관측소 1곳 값이 빠짐/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  // 닫힘 동작(0.2초)이 끝나기 전에 바로 다른 장애를 누름
  await region.getByRole("button", { name: /호출 한도 초과/ }).click();
  const sheet = page.getByRole("dialog", { name: /호출 한도 초과/ });
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(400);
  await expect(sheet).toBeVisible();
});

test("불러오기가 실패하면 열려 있던 시트를 닫고, 다시 성공해도 저절로 열리지 않는다", async ({
  page,
}) => {
  await mockSequence(page, [VIEW, 500, VIEW]);
  await openCollection(page);
  const region = page.getByRole("region", { name: /장애 기록/ });
  const opener = region.getByRole("button", { name: /관측소 1곳 값이 빠짐/ });
  await opener.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await reloadBehindSheet(page);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "수집 현황을 불러오지 못했어요" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(region.getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("파고 출처 전체가 영향 범위면 '관측소 범위'가 아니라 출처 전체 문구로 보여 준다", async ({
  page,
}) => {
  const whole = {
    ...VIEW,
    jobs: VIEW.jobs.map((job) => ({
      ...job,
      incidents: job.incidents.map((incident) =>
        incident.kind === "stations"
          ? {
              ...incident,
              impact: {
                status: "affected",
                wholeSource: true,
                delayedBeachIds: ["b0001"],
                stations: [],
              },
            }
          : incident,
      ),
    })),
  };
  await mockCollection(page, 200, whole);
  await openCollection(page);
  await page
    .getByRole("region", { name: /장애 기록/ })
    .getByRole("button", { name: /관측소 1곳 값이 빠짐/ })
    .click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("영향 범위(파고 출처 전체)에서");
  await expect(sheet).not.toContainText("관측소 범위에서");
});

test("다시 불러와 시트가 닫히면 포커스가 연 버튼으로 돌아간다", async ({
  page,
}) => {
  await mockSequence(page, [VIEW, withoutStations]);
  await openCollection(page);
  const region = page.getByRole("region", { name: /장애 기록/ });
  const opener = region.getByRole("button", { name: /관측소 1곳 값이 빠짐/ });
  await opener.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await reloadBehindSheet(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // 연 장애가 목록에서 빠져 버튼도 사라짐 → 포커스는 장애 기록 제목으로(문서 맨 앞으로 떨어지지 않음)
  await expect(
    page.getByRole("heading", { name: /장애 기록/, level: 2 }),
  ).toBeFocused();
});

test("출처 시트(시안 V10): 해양 관측은 관측소 목록을 빠짐 먼저 6곳씩 보여 주고, Esc로 닫으면 포커스가 화살표로 돌아온다", async ({
  page,
}) => {
  await mockCollection(page);
  await openCollection(page);
  const opener = page
    .getByRole("button", { name: "기상청 해양 관측 자세히 보기" })
    .filter({ visible: true });
  await opener.click();
  const sheet = page.getByRole("dialog", { name: "기상청 해양 관측" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("출처 · 판단에 씀");
  await expect(
    sheet.locator("dl > div").filter({ hasText: "관측소" }),
  ).toContainText("8곳");
  const rows = sheet.locator("tbody tr");
  await expect(rows).toHaveCount(6);
  // 빠진 관측소가 먼저, 쓰는 해변 이름(공개 해변 데이터)과 처음 빠진 시각
  await expect(rows.first()).toContainText("속초 파고부이");
  await expect(rows.first()).toContainText("빠짐");
  await expect(rows.first()).toContainText("외 1곳");
  // 대조하지 못한 관측소는 정상이 아니라 확인 못 함
  await expect(rows.nth(1)).toContainText("확인 못 함");
  // 마지막 측정 시각은 보여 주지 않는다고 알림(D19-5)
  await expect(sheet).toContainText(
    "마지막 측정 시각은 운영 화면에서 보지 않아요",
  );
  const pager = sheet.getByRole("navigation", { name: "관측소 쪽 이동" });
  await expect(pager).toContainText("8곳 중 1–6");
  await pager.getByRole("button", { name: "다음" }).click();
  await expect(pager).toContainText("8곳 중 7–8");
  await sheet.getByRole("button", { name: /^문제 2/ }).click();
  await expect(rows).toHaveCount(2);
  await expectNoA11yViolations(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("출처 시트의 장애 줄을 누르면 장애 상세 시트로 바뀌고, 닫으면 출처 줄 화살표로 돌아온다", async ({
  page,
}) => {
  await mockCollection(page);
  await openCollection(page);
  const opener = page
    .getByRole("button", { name: "기상청 해상 특보 자세히 보기" })
    .filter({ visible: true });
  await opener.click();
  const sheet = page.getByRole("dialog", { name: "기상청 해상 특보" });
  // 해양 관측이 아니면 관측소 대신 장애 수
  await expect(sheet).not.toContainText("관측소 쪽 이동");
  await sheet.getByRole("button", { name: /호출 한도 초과/ }).click();
  await expect(
    page.getByRole("dialog", { name: /호출 한도 초과/ }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("관측소 표를 읽지 못하면 출처 시트는 빈 목록이 아니라 '불러오지 못함'으로 보여 준다", async ({
  page,
}) => {
  await mockCollection(page, 200, VIEW_DEGRADED);
  await openCollection(page);
  await page
    .getByRole("button", { name: "기상청 해양 관측 자세히 보기" })
    .filter({ visible: true })
    .click();
  const sheet = page.getByRole("dialog", { name: "기상청 해양 관측" });
  await expect(sheet).toContainText("관측소 목록을 불러오지 못했어요");
  await expect(
    sheet.locator("dl > div").filter({ hasText: "관측소" }),
  ).toContainText("확인 못 함");
  await expect(sheet.locator("tbody tr")).toHaveCount(0);
});

test("말풍선은 마우스를 올리거나 키보드로 고를 때만: 24시간 막대는 칸 시각, 선 그래프는 그 시간 성공률", async ({
  page,
}) => {
  test.skip(isMobile(page), "마우스 올리기는 PC에서만 확인");
  await mockCollection(page);
  await openCollection(page);
  const tip = page.locator("span.shadow-floating[aria-hidden=true]");
  await expect(tip).toHaveCount(0);

  const bars = sourceRow(page, "기상청 해상 특보").getByRole("img");
  await bars.scrollIntoViewIfNeeded();
  const box = (await bars.boundingBox())!;
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await expect(tip).toHaveCount(1);
  await expect(tip).toHaveText(
    /^\d{2}:00–\d{2}:00 · (정상|지연|실패|기록 없음) · /,
  );
  await page.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);

  const chart = page.getByRole("group", { name: "시간별 성공률 선 그래프" });
  await chart.scrollIntoViewIfNeeded();
  const cb = (await chart.boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  await expect(tip).toHaveCount(1);
  await expect(tip).toContainText("시 · ");
  await page.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);

  // 키보드: 그래프에 포커스하고 ←→로 옮기면 말풍선과 같은 글을 알림
  await chart.focus();
  await page.keyboard.press("End");
  await expect(tip).toHaveCount(1);
  await expect(page.locator("p[aria-live=polite]").first()).toContainText(
    "시 · ",
  );
  await expectNoA11yViolations(page);
});
