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

// 해변 관리 목록·상세 (BRD-150·GH-329, 화면 설계서 6장 ADM-BCH). 운영 API는 가짜 응답
// - 해변 정보는 빌드 때 저장소 파일에서 읽은 값(실제 data/). 지금 표시 상태·운영 메모만 운영 API
// - 상태를 못 받으면 모든 해변이 '확인 못 함'(판단불가 계열). '특보 없음'으로 보이지 않아야 함

const OPS = "ops@example.test";

const PUBLISHED = {
  available: true,
  snapshotVersion: "20261111T030000Z",
  generatedAt: "2026-11-11T03:00:12Z",
  beaches: {
    b0001: { category: "clear", reasons: [] },
    b0002: {
      category: "unavailable",
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
      reasons: [
        {
          code: "observation_delayed",
          scope: "연곡 파고부이",
          source: "기상청",
          at: "2026-11-11T01:00:00Z",
        },
      ],
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
  await mockCognito(page, srpScript({ email: OPS, after: "tokens", groups }));
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
}

async function openBeaches(page: Page) {
  await openMenu(page);
  await page
    .getByRole("navigation", { name: "운영 메뉴" })
    .filter({ visible: true })
    .getByRole("link", { name: "해변 관리" })
    .click();
  await expect(
    page.getByRole("heading", { name: "해변 관리", level: 1 }),
  ).toBeVisible();
}

// 화면 너비에 맞는 해변 한 줄(PC 표 줄, 모바일 카드)
const beachRow = (page: Page, name: string) =>
  (isMobile(page) ? page.locator("main ul > li") : page.locator("tbody tr"))
    .filter({ visible: true })
    .filter({ hasText: name });

async function openDetail(page: Page, name: string) {
  // 모바일 카드 링크 이름에는 지역·ID도 들어감. 첫 링크가 상세 링크(커밋 기록 링크는 뒤)
  await beachRow(page, name).getByRole("link", { name }).first().click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

test("목록: 저장소의 206곳을 읽기 전용으로 보여 주고 지금 표시 상태는 사유 먼저", async ({
  page,
}) => {
  await mockPublished(page);
  await signIn(page, ["viewer"]);
  await openBeaches(page);
  await expect(page.getByText("206곳 중 206곳")).toBeVisible();
  await expect(
    page.getByText(
      "해변 정보는 저장소가 원본이에요. 고치면 PR 머지 뒤 사이트가 다시 배포되면서 반영돼요.",
    ),
  ).toBeVisible();
  // 편집 칸·노출 토글·일괄 변경 없음
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("switch")).toHaveCount(0);

  const blocked = beachRow(page, "경포해수욕장");
  await expect(blocked).toContainText("풍랑주의보");
  await expect(blocked).toContainText("이용불가");
  await expect(beachRow(page, "강문해수욕장")).toContainText("특보 없음");
  // 게시본에 없는 해변은 '확인 못 함'(특보 없음으로 채우지 않음)
  const missing = beachRow(page, "정동진해수욕장");
  await expect(missing).toContainText("확인 못 함");
  await expect(missing).not.toContainText("특보 없음");
  // 데이터 연결은 특보·관측·운영 기간만(출입 통제 없음)
  await expect(beachRow(page, "강문해수욕장")).toContainText(
    "2026 개장 7.10~8.23",
  );
  await expect(page.getByText("출입 통제")).toHaveCount(0);
  // 마지막 수정은 저장소 커밋 기록 링크
  await expect(
    beachRow(page, "강문해수욕장").getByRole("link", {
      name: "강문해수욕장 커밋 기록(GitHub, 새 탭)",
    }),
  ).toHaveAttribute(
    "href",
    "https://github.com/404soonotfound/baradun_v2/commits/main/data/beaches/b0001.json",
  );
  await expectNoA11yViolations(page);
});

test("목록: 이름·별칭으로 찾고 지역으로 거르며, 없으면 빈 목록 안내", async ({
  page,
}) => {
  await mockPublished(page);
  await signIn(page, ["viewer"]);
  await openBeaches(page);
  await page.getByLabel("해변 찾기").fill("송도");
  await expect(beachRow(page, "송도해수욕장")).toHaveCount(1);
  await page.getByLabel("지역").selectOption("강원");
  await expect(page.getByText("찾는 해변이 없어요")).toBeVisible();
  await page.getByLabel("해변 찾기").fill("");
  await expect(page.getByText("206곳 중 89곳")).toBeVisible();
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
  await expect(beachRow(page, "강문해수욕장")).toContainText("확인 못 함");
  await expect(beachRow(page, "강문해수욕장")).not.toContainText("특보 없음");
  await expect(page.getByText("특보 없음", { exact: true })).toHaveCount(0);
  await alert.getByRole("button", { name: "다시 시도" }).click();
  await expect.poll(calls).toBe(2);
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
