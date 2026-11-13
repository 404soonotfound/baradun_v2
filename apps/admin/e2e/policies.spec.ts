import type { Page } from "@playwright/test";
import snapshot from "../src/content/ops-policy.json";
import { policyTime } from "../src/lib/policies";
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

// 운영 정책 (#335, 화면 설계서 6장 ADM-POL, 결정 기록 D20-8~11·D16-E5). 읽기 전용
// 내용은 빌드에 넣은 저장소 파일(src/content/ops-policy.json). 운영 API를 부르지 않음

const OPS = "ops@example.test";

async function signIn(page: Page) {
  const policyCalls: string[] = [];
  page.on("request", (request) => {
    if (/\/ops\/polic/.test(request.url())) policyCalls.push(request.url());
  });
  await mockCognito(
    page,
    srpScript({ email: OPS, after: "tokens", groups: ["viewer"] }),
  );
  await mockOps(page, ME_OK);
  await signInWithPassword(page, "/login/", OPS);
  await expect(page.getByRole("heading", { name: "운영 홈" })).toBeVisible();
  return policyCalls;
}

async function openPolicies(page: Page) {
  await openMenu(page);
  await page
    .getByRole("navigation", { name: "운영 메뉴" })
    .filter({ visible: true })
    .getByRole("link", { name: "운영 정책" })
    .click();
  await expect(
    page.getByRole("heading", { name: "운영 정책", level: 1 }),
  ).toBeVisible();
}

const list = (page: Page) => page.getByRole("navigation", { name: "목차" });
const detailTitle = (page: Page) =>
  page.getByRole("heading", { level: 2 }).filter({ visible: true });

test("revision·가져온 시각·원문 링크를 보여 주고 '최신'이라고 쓰지 않는다", async ({
  page,
}) => {
  const policyCalls = await signIn(page);
  await openPolicies(page);
  await expect(
    page.getByText(
      `노션 마지막 수정 ${policyTime(snapshot.revision)} · 마지막 동기화 ${policyTime(snapshot.fetchedAt)}`,
    ),
  ).toBeVisible();
  const notion = page.getByRole("link", { name: "노션에서 열기 (새 탭)" });
  await expect(notion).toHaveAttribute("href", snapshot.source.url);
  await expect(notion).toHaveAttribute("target", "_blank");
  await expect(
    page.getByText("노션과 자동으로 동기화되지 않아요"),
  ).toBeVisible();
  await expect(page.getByText("최신")).toHaveCount(0);
  // 9개 항목 모두 원본의 상태 표시와 함께
  const items = list(page).getByRole("link");
  await expect(items).toHaveCount(9);
  await expect(items.first()).toContainText("1. 판단 원칙·표현 원칙");
  await expect(items.first()).toContainText("확정");
  await expect(items.nth(8)).toContainText("9. 문의 응대");
  // 운영 API를 부르지 않음
  expect(policyCalls).toEqual([]);
  await expectNoA11yViolations(page);
});

test("한 번에 하나씩 읽는다: PC는 왼쪽 목록 + 내용, 모바일은 목록 → 상세 → 목록", async ({
  page,
}) => {
  await signIn(page);
  await openPolicies(page);
  if (isMobile(page)) {
    // 모바일 첫 화면은 목록만
    await expect(detailTitle(page)).toHaveCount(0);
  } else {
    await expect(detailTitle(page)).toHaveText("1. 판단 원칙·표현 원칙");
  }
  await list(page)
    .getByRole("link", { name: /6\. 장애 대응/ })
    .click();
  await expect(page).toHaveURL(/\/policies\/\?id=6$/);
  await expect(detailTitle(page)).toHaveText("6. 장애 대응");
  const detail = page.getByRole("article").filter({ visible: true });
  await expect(detail.getByRole("listitem")).toHaveCount(6);
  // 원본의 '미확정:' 굵은 글씨를 그대로 보여 줌
  await expect(detail.locator("strong", { hasText: "미확정:" })).toBeVisible();
  await expect(detail).toContainText("근거: 12장 결정 1");
  if (isMobile(page)) {
    await expect(list(page)).toBeHidden();
    await expectNoA11yViolations(page);
    await page.getByRole("link", { name: "정책 목록으로" }).click();
    await expect(page).toHaveURL(/\/policies\/$/);
    await expect(list(page)).toBeVisible();
    await expect(detailTitle(page)).toHaveCount(0);
  } else {
    await expect(
      list(page).getByRole("link", { name: /6\. 장애 대응/ }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByRole("link", { name: "정책 목록으로" }),
    ).toBeHidden();
    await expectNoA11yViolations(page);
  }
});

test("없는 항목 주소는 '찾는 정책이 없어요'와 목록을 보여 준다", async ({
  page,
}) => {
  await signIn(page);
  await openPolicies(page);
  // 화면 안 이동(새로 불러오면 메모리의 로그인이 사라짐)
  await page.evaluate(() => {
    window.history.pushState(null, "", "/policies/?id=12");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByText("찾는 정책이 없어요")).toBeVisible();
  await expect(list(page)).toBeVisible();
  await expect(detailTitle(page)).toHaveCount(0);
});
