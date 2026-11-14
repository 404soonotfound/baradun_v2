import type { Page, Route } from "@playwright/test";
import { VIEW as COLLECTION } from "./collection-data";
import { localSourcesView } from "../src/lib/auth/local-sources";
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

// 데이터 출처 목록·상세 (BRD-149·GH-328, 화면 설계서 6장 ADM-SRC). 운영 API는 가짜 응답
// 예시 응답은 로컬 개발 서버와 같은 것(해양 관측 최근 일부 실패, 사진 기록 없음, kma-apihub 만료일 태그 없음)

const OPS = "ops@example.test";
const VIEW = localSourcesView(Date.now());

async function mockSources(page: Page, status = 200, view: object = VIEW) {
  let calls = 0;
  await page.route(/\/ops\/sources$/, async (route: Route) => {
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

async function openSources(page: Page) {
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
    .getByRole("link", { name: "데이터 출처" })
    .click();
  await expect(
    page.getByRole("heading", { name: "데이터 출처", level: 1 }),
  ).toBeVisible();
}

const referenceRow = (page: Page, name: string) =>
  (isMobile(page)
    ? page.getByRole("region", { name: /참고 출처/ }).locator("ul > li")
    : page.getByRole("region", { name: /참고 출처/ }).getByRole("row")
  )
    .filter({ visible: true })
    .filter({ hasText: name });

test("목록(시안 V12·VM13): 판단 출처 카드·참고 출처·인증키를 글자로 나누고 키 값·원본 응답은 없다", async ({
  page,
}) => {
  await page.route(/\/ops\/collection$/, (route) =>
    route.fulfill({ json: COLLECTION }),
  );
  await mockSources(page);
  await openSources(page);
  const judgment = page.getByRole("region", { name: /판단에 쓰는 출처/ });
  const warnings = judgment
    .getByRole("article")
    .filter({ hasText: "기상특보 조회" });
  await expect(warnings).toContainText("성공");
  await expect(warnings).toContainText("15분마다 · :03 :18 :33 :48");
  await expect(warnings).toContainText("특보 확인 못 함");
  const ocean = judgment.getByRole("article").filter({ hasText: "해양 관측" });
  await expect(ocean).toContainText("일부 실패");
  await expect(ocean).toContainText("파고 측정이 90분");

  await expect(referenceRow(page, "이안류 지수")).toContainText(
    "6~9월 30분마다 · :12 :42 · 그 밖 하루 1회 04:12",
  );
  await expect(referenceRow(page, "대표 사진")).toContainText("기록 없음");
  await expect(referenceRow(page, "대표 사진")).toContainText(
    "하루 1회 · 04:20",
  );
  await expect(referenceRow(page, "해양수산부 운영 기간")).toContainText(
    "수집하지 않음",
  );

  const keys = page.getByRole("region", { name: "인증키" });
  await expect(
    keys.getByRole("row").filter({ hasText: "data-go-kr" }),
  ).toContainText("2027-03-31");
  await expect(
    keys.getByRole("row").filter({ hasText: "kma-apihub" }),
  ).toContainText("등록됨 · 만료일 없음");
  await expect(page.getByText("판단 2 · 참고 3")).toBeVisible();
  await expect(page.getByText("1/2 성공")).toBeVisible();
  await expect(page.getByText("참고 출처 최근 실행")).toBeVisible();
  await expect(page.getByText("인증키 만료 30일 안")).toBeVisible();
  await expect(page.getByText("만료일을 확인한 키 중 0건")).toBeVisible();
  await expect(judgment.getByRole("img", { name: /^최근 24시간/ })).toHaveCount(
    2,
  );
  await expect(keys.getByRole("columnheader")).toHaveCount(5);
  await warnings.getByText("시간별 상태 보기").click();
  await expect(warnings.getByRole("listitem")).toHaveCount(24);
  await expect(
    warnings.getByRole("listitem").filter({ hasText: / · 실패$/ }),
  ).toHaveCount(1);
  // 읽기 전용: 받아오기 같은 조작 없음
  await expect(page.getByRole("button", { name: /받아오기/ })).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test("상세(시안 V13): 호출·연결 정보·최근 수집을 보여 주고 목록으로 돌아간다", async ({
  page,
}) => {
  await mockSources(page);
  await openSources(page);
  await page
    .getByRole("link", { name: "기상특보 조회 상세 보기" })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/\/sources\/\?id=collect-warnings$/);
  await expect(
    page.getByRole("heading", { name: "기상특보 조회", level: 2 }),
  ).toBeVisible();
  const calls = page.getByRole("region", { name: "호출 2" });
  await expect(calls).toContainText("getPwnCd");
  await expect(calls).toContainText(
    "GET https://apis.data.go.kr/1360000/WthrWrnInfoService/getPwnCd",
  );
  await expect(calls).toContainText("받는 행 수 10,000");
  await expect(page.getByText("10초 · 다시 1회")).toBeVisible();
  await expect(page.getByText("마지막 성공 뒤 20분")).toBeVisible();
  const runs = page.getByRole("region", { name: "최근 수집" });
  await expect(
    runs.locator("ol > li").filter({ hasText: "응답 시간 초과" }),
  ).toContainText("실패");
  await expect(runs.locator("ol > li")).toHaveCount(5);
  const info = page.getByRole("region", { name: "연결 정보" });
  await expect(info).toContainText("2027-03-31");
  await expect(info).toContainText("확인 필요");
  await expectNoA11yViolations(page);
  await page.getByRole("link", { name: /데이터 출처 목록/ }).click();
  await expect(page).toHaveURL(/\/sources\/$/);
  await expect(
    page.getByRole("region", { name: /판단에 쓰는 출처/ }),
  ).toBeVisible();
});

test("기록 null·읽지 못한 기록·키 확인 못 함은 정상·등록 안 됨으로 바꾸지 않는다", async ({
  page,
}) => {
  await mockSources(page, 200, {
    ...VIEW,
    keys: [
      { ...VIEW.keys[0], status: "unknown", expiresOn: null, daysLeft: null },
    ],
    sources: VIEW.sources.map((s) =>
      s.id === "collect-warnings"
        ? { ...s, recentRuns: null }
        : s.id === "collect-ocean"
          ? { ...s, unreadableRuns: 2 }
          : s,
    ),
  });
  await openSources(page);
  const judgment = page.getByRole("region", { name: /판단에 쓰는 출처/ });
  await expect(
    judgment.getByRole("article").filter({ hasText: "기상특보 조회" }),
  ).toContainText("확인 못 함");
  await expect(
    judgment.getByRole("article").filter({ hasText: "해양 관측" }),
  ).toContainText("확인 못 함");
  await expect(page.getByText("0/2 성공")).toHaveCount(0);
  await expect(
    judgment.getByText("최근 24시간 수집 기록 확인 못 함"),
  ).toHaveCount(2);
  const keys = page.getByRole("region", { name: "인증키" });
  await expect(
    keys.getByRole("row").filter({ hasText: "data-go-kr" }),
  ).toContainText("등록 안 됐다는 뜻이 아니에요");
  // 응답에 빠진 kma-apihub도 '등록 안 됨'이 아니라 확인 못 함
  await expect(
    keys.getByRole("row").filter({ hasText: "kma-apihub" }),
  ).toContainText("확인 못 함");
  await expect(keys).not.toContainText("등록 안 됨");
  // 요약도 수 대신 '확인 못 함'(미등록 키가 있는 것처럼 '0/2'로 보이지 않게)
  await expect(page.getByText(/\/2 등록·만료 전/)).toHaveCount(0);

  await page
    .getByRole("link", { name: "해양 관측 상세 보기" })
    .filter({ visible: true })
    .click();
  await expect(page.getByText(/읽지 못한 기록이 2건/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "해양 관측", level: 2 }),
  ).toBeVisible();
});

test("성공한 실행의 빠진 관측소는 숨기지 않고, 만료된 키는 등록 수에서 뺀다", async ({
  page,
}) => {
  await mockSources(page, 200, {
    ...VIEW,
    keys: [{ ...VIEW.keys[0], daysLeft: -3 }, VIEW.keys[1]],
    sources: VIEW.sources.map((s) =>
      s.id === "collect-ocean" && s.recentRuns
        ? {
            ...s,
            recentRuns: [
              {
                ...s.recentRuns[1],
                missingStations: ["22105", "22190"],
                missingStationsTotal: 2,
              },
              ...s.recentRuns.slice(1),
            ],
          }
        : s,
    ),
  });
  await openSources(page);
  await expect(
    page
      .getByRole("region", { name: "인증키" })
      .getByRole("row", { name: /data-go-kr/ }),
  ).toContainText("만료일 지남");
  await page
    .getByRole("link", { name: "해양 관측 상세 보기" })
    .filter({ visible: true })
    .click();
  const latest = page
    .getByRole("region", { name: "최근 수집" })
    .locator("ol > li")
    .first();
  await expect(latest).toContainText("성공");
  await expect(latest).toContainText("관측소 2곳 값이 빠짐(22105 · 22190)");
});

test("샘플 계정 응답(keysHidden)은 키 상태를 '확인 못 함'이 아니라 보여 주지 않는다고 안내한다", async ({
  page,
}) => {
  await mockSources(page, 200, { ...VIEW, keys: [], keysHidden: true });
  await openSources(page);
  await expect(
    page.getByText("샘플(시연) 계정에는 운영 인증키 상태를 보여 주지 않아요."),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "인증키" })).not.toContainText(
    "확인 못 함",
  );
});

test("불러오지 못하면 앱 영향 없음과 요청 번호, 다시 시도를 보여 준다", async ({
  page,
}) => {
  const calls = await mockSources(page, 500);
  await openSources(page);
  const alert = page
    .getByRole("alert")
    .filter({ hasText: "데이터 출처를 불러오지 못했어요" });
  await expect(alert).toContainText("앱의 수집·게시는 그대로");
  await expect(alert).toContainText("req-7f3a2c91");
  const before = calls();
  await alert.getByRole("button", { name: "다시 시도" }).click();
  await expect.poll(calls).toBe(before + 1);
});

test("200이어도 본문 모양이 틀리면 빈 화면이 아니라 불러오지 못함으로 보여 준다", async ({
  page,
}) => {
  await mockSources(page, 200, { ...VIEW, sources: null });
  await openSources(page);
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "데이터 출처를 불러오지 못했어요" }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "인증키" })).toHaveCount(0);
});

test("확인한 인증키의 만료 요약은 오늘과 30일 뒤까지 센다", async ({
  page,
}) => {
  await mockSources(page, 200, {
    ...VIEW,
    keys: [
      { ...VIEW.keys[0], expiresOn: "2027-01-01", daysLeft: 0 },
      { ...VIEW.keys[1], expiresOn: "2027-01-31", daysLeft: 30 },
    ],
  });
  await openSources(page);
  const expiry = page.locator("dl > div").filter({
    has: page.getByText("인증키 만료 30일 안", { exact: true }),
  });
  await expect(expiry).toContainText("2건");
});
