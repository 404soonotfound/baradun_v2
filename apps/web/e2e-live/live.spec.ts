import { WARNING_CONFIRMATION_TTL_MS } from "@baradun/contracts/judgment-policy";
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { NOTICE_VERSION } from "../src/lib/notice-version";
import { CLOCK_TOLERANCE_MS } from "../src/lib/snapshot/clock";
import {
  clearBadges,
  clearPlacesWithoutBasis,
  CONFIRMED,
  notSummaryLabel,
} from "../e2e/support/clear-basis";

// 운영 주소 읽기 전용 스모크 (#551, 노션 결정 기록 D30-6)
// QA 라운드·출시일 전환 직후·출시 뒤 배포마다 '운영 주소가 제대로 떴는지'를 1~2분 안에 봄
// 실데이터라 특정 해변의 상태 값은 보지 않고, 지켜야 할 조건(근거 표시·신선도·헤더·CSP)만 봄
// 로그인·쓰기·새 경보 없음. 실패해도 자동으로 되돌리지 않음(결과만 보고)

const EXPECT_COMMIT = process.env.LIVE_EXPECT_COMMIT ?? "";
const ADMIN_URL = process.env.LIVE_ADMIN_URL ?? "";
const KMA_STATUS_KO = "출처: 기상청 (특보·해양 관측 자료를 가공)";

const PAGES = [
  "/",
  "/explore/",
  "/favorites/",
  "/guide/",
  "/search/",
  "/settings/",
  "/settings/inquiry/",
  "/about/data/",
  "/terms/",
];

type Manifest = {
  snapshotVersion?: unknown;
  policyVersion?: unknown;
  generatedAt?: unknown;
  maintenance?: { active?: unknown };
  files?: { beaches?: unknown; status?: unknown };
};
type LiveBeach = { id: string; slug: string; hidden: boolean };
type LiveData = {
  manifest: Manifest;
  beaches: LiveBeach[];
  // 노출 해변 중 publisher가 '특보 없음'으로 게시한 곳
  clearSlugs: string[];
  anySlug: string;
};

// 운영 게시본을 한 번 읽음. 읽지 못하면 어느 파일인지 알려 주고 멈춤
async function readJson(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  expect(response.status(), `${path} 응답 코드`).toBe(200);
  return (await response.json()) as unknown;
}

// 작업자(worker)마다 한 번만 받아 여러 시험이 같은 게시본을 봄(5분마다 바뀌는 판이 시험마다 달라지지 않게)
let liveData: Promise<LiveData> | undefined;
function readLiveData(request: APIRequestContext): Promise<LiveData> {
  liveData ??= fetchLiveData(request);
  return liveData;
}

async function fetchLiveData(request: APIRequestContext): Promise<LiveData> {
  const manifest = (await readJson(request, "/data/manifest.json")) as Manifest;
  const beachesPath = manifest.files?.beaches;
  const statusPath = manifest.files?.status;
  expect(typeof beachesPath, "manifest.files.beaches").toBe("string");
  expect(typeof statusPath, "manifest.files.status").toBe("string");
  const beaches = (
    (await readJson(request, beachesPath as string)) as {
      beaches: LiveBeach[];
    }
  ).beaches;
  const status = (
    (await readJson(request, statusPath as string)) as {
      beaches: Record<string, { category?: unknown }>;
    }
  ).beaches;
  const visible = beaches.filter((beach) => !beach.hidden);
  const first = visible[0];
  if (first === undefined) throw new Error("beaches.json에 노출 해변이 없음");
  const clearSlugs = visible
    .filter((beach) => status[beach.id]?.category === "clear")
    .map((beach) => beach.slug);
  return { manifest, beaches, clearSlugs, anySlug: first.slug };
}

// 첫 실행 안내를 지난 기기(저장 지역 없음 → 화면 기본값). 탐색은 목록 보기로 시작
async function seedDevice(context: BrowserContext) {
  await context.addInitScript(
    ({ noticeVersion }) => {
      if (sessionStorage.getItem("live:seeded")) return;
      sessionStorage.setItem("live:seeded", "1");
      localStorage.setItem(
        "baradun:onboarding",
        JSON.stringify({
          noticeVersion,
          acknowledgedAt: "2026-10-27T00:00:00Z",
          locationStepDone: true,
        }),
      );
      localStorage.setItem("baradun:explore-view", "list");
    },
    { noticeVersion: NOTICE_VERSION },
  );
}

// 콘솔 CSP 위반 모음. 브라우저 이벤트(securitypolicyviolation)와 콘솔 오류 둘 다 봄
async function watchCsp(page: Page) {
  const violations: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(
        `Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().toLowerCase().includes("content security policy")
    ) {
      violations.push(`${page.url()} → ${message.text().slice(0, 200)}`);
    }
  });
  return violations;
}

// 화면을 열고 판단 상태를 받아 그릴 때까지 기다림
// status.json 응답을 받은 뒤, 확인 시각 근거('기상청 HH:MM 확인')나 판단 배지의 '확인 못 함'이 보이면 그린 것
// PC 홈 전국 지도 카드의 묶음 이름('확인 못 함 n곳')은 받기 전에도 있어서 빼고 봄(data-summary-category)
async function gotoWithStatus(page: Page, path: string) {
  const status = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/status.json") &&
      response.ok(),
  );
  await page.goto(path);
  await status;
  await expect(
    page
      .getByText(CONFIRMED)
      .or(page.getByText("확인 못 함", { exact: true }))
      .filter({ visible: true })
      .and(notSummaryLabel(page))
      .first(),
    `${path}에서 판단 상태가 그려지지 않음`,
  ).toBeVisible();
}

test.describe.configure({ mode: "parallel" });

test.describe("운영 게시본·응답 (모바일 프로젝트에서 한 번)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile",
      "주소 응답 검사는 화면 크기와 상관없어 한 번만 함",
    );
  });

  test("주요 경로(한·영)는 200, 없는 경로는 404", async ({ request }) => {
    const { anySlug } = await readLiveData(request);
    const paths = [...PAGES, `/spots/${anySlug}/`];
    const failures: string[] = [];
    for (const path of [...paths, ...paths.map((item) => `/en${item}`)]) {
      const response = await request.get(path, { maxRedirects: 0 });
      if (response.status() !== 200) {
        failures.push(`${path} → ${response.status()}`);
      }
    }
    expect(failures, "200이 아닌 경로").toEqual([]);
    const missing = await request.get("/qa-smoke-missing-page/", {
      maxRedirects: 0,
    });
    expect(missing.status(), "없는 경로 /qa-smoke-missing-page/").toBe(404);
  });

  test("게시본이 새것이고 점검 중이 아님", async ({ request }) => {
    const { manifest } = await readLiveData(request);
    const generatedMs = Date.parse(String(manifest.generatedAt));
    expect(
      Number.isNaN(generatedMs),
      `manifest.generatedAt을 읽지 못함: ${String(manifest.generatedAt)}`,
    ).toBe(false);
    const ageMs = Date.now() - generatedMs;
    // 45분이 지나면 화면이 모든 '특보 없음'을 '확인 못 함'으로 내림(WARNING_CONFIRMATION_TTL_MS)
    expect(
      ageMs,
      `게시 시각 ${String(manifest.generatedAt)}이 ${Math.round(ageMs / 60000)}분 전(45분 넘으면 publisher 확인 필요)`,
    ).toBeLessThanOrEqual(WARNING_CONFIRMATION_TTL_MS);
    expect(
      ageMs,
      `게시 시각 ${String(manifest.generatedAt)}이 미래`,
    ).toBeGreaterThanOrEqual(-CLOCK_TOLERANCE_MS);
    expect(
      manifest.maintenance?.active,
      "manifest.maintenance.active(점검 중이면 true)",
    ).toBe(false);
    test.info().annotations.push({
      type: "snapshot",
      description: `${String(manifest.snapshotVersion)} · ${String(manifest.policyVersion)}`,
    });
  });

  test("배포 커밋(deploy-version.txt)", async ({ request }) => {
    const response = await request.get("/deploy-version.txt");
    expect(response.status(), "/deploy-version.txt 응답 코드").toBe(200);
    const deployed = (await response.text()).trim();
    test.info().annotations.push({ type: "deploy", description: deployed });
    expect(deployed, "/deploy-version.txt 내용(40자 커밋)").toMatch(
      /^[0-9a-f]{40}$/,
    );
    if (EXPECT_COMMIT) {
      expect(
        deployed.startsWith(EXPECT_COMMIT),
        `/deploy-version.txt ${deployed}가 기준 커밋 ${EXPECT_COMMIT}와 다름`,
      ).toBe(true);
    }
  });

  test("보안 응답 헤더 6종", async ({ request }) => {
    const headers = (await request.get("/")).headers();
    expect(headers["strict-transport-security"], "/ HSTS").toBe(
      "max-age=31536000",
    );
    expect(headers["x-content-type-options"], "/ nosniff").toBe("nosniff");
    expect(headers["x-frame-options"], "/ X-Frame-Options").toBe("DENY");
    expect(headers["referrer-policy"], "/ Referrer-Policy").toBe(
      "strict-origin-when-cross-origin",
    );
    expect(headers["permissions-policy"], "/ Permissions-Policy").toBe(
      "camera=(), microphone=(), geolocation=(self)",
    );
    const csp = headers["content-security-policy"] ?? "";
    expect(csp, "/ CSP default-src").toContain("default-src 'self'");
    expect(csp, "/ CSP frame-ancestors").toContain("frame-ancestors 'none'");
  });

  test("운영자 사이트 로그인 화면은 200·noindex (로그인하지 않음)", async ({
    request,
  }) => {
    test.skip(!ADMIN_URL, "--admin-url을 주지 않아 건너뜀");
    const url = new URL("/login/", ADMIN_URL).toString();
    const response = await request.get(url, { maxRedirects: 0 });
    expect(response.status(), `${url} 응답 코드`).toBe(200);
    expect(response.headers()["x-robots-tag"], `${url} X-Robots-Tag`).toContain(
      "noindex",
    );
    const html = await response.text();
    expect(html, `${url} robots meta noindex`).toMatch(
      /<meta name="robots" content="[^"]*noindex/,
    );
  });
});

test.describe("화면 (모바일·PC)", () => {
  test.beforeEach(async ({ context }) => {
    await seedDevice(context);
  });

  test("홈: 판단 상태가 그려지고 '특보 없음'마다 범위·기상청·확인 시각과 현장 우선 문구", async ({
    page,
  }) => {
    await gotoWithStatus(page, "/");
    await expect(page.getByText(KMA_STATUS_KO).first()).toBeVisible();
    const result = await clearPlacesWithoutBasis(page);
    test.info().annotations.push({
      type: "clear",
      description: `/ '특보 없음' ${result.count}곳 확인`,
    });
    expect(result.missing, "/ 근거·현장 우선 문구가 빠진 '특보 없음'").toEqual(
      [],
    );
  });

  test("탐색 목록: 게시본에 '특보 없음'이 있으면 화면에도 있고 근거가 붙음", async ({
    page,
    request,
  }) => {
    const { clearSlugs } = await readLiveData(request);
    await gotoWithStatus(page, "/explore/");
    if (clearSlugs.length > 0) {
      await expect(
        clearBadges(page).first(),
        `게시본은 '특보 없음' ${clearSlugs.length}곳인데 /explore/에 보이지 않음`,
      ).toBeVisible();
    }
    const result = await clearPlacesWithoutBasis(page);
    test.info().annotations.push({
      type: "clear",
      description: `/explore/ '특보 없음' ${result.count}곳 확인(게시본 ${clearSlugs.length}곳)`,
    });
    expect(
      result.missing,
      "/explore/ 근거·현장 우선 문구가 빠진 '특보 없음'",
    ).toEqual([]);
  });

  test("상세: '특보 없음' 해변의 근거와 현장 우선 문구", async ({
    page,
    request,
  }) => {
    const { clearSlugs } = await readLiveData(request);
    test.skip(
      clearSlugs.length === 0,
      "지금 게시본에 '특보 없음' 해변이 없어 건너뜀",
    );
    const path = `/spots/${clearSlugs[0]}/`;
    await page.goto(path);
    await expect(
      clearBadges(page).first(),
      `${path}에 '특보 없음'이 보이지 않음`,
    ).toBeVisible();
    await expect(page.getByText(CONFIRMED).first()).toBeVisible();
    const result = await clearPlacesWithoutBasis(page);
    expect(result.missing, `${path} 근거·현장 우선 문구`).toEqual([]);
  });

  test("콘솔 CSP 위반 0건 (홈·탐색·상세·문의, 한·영)", async ({
    page,
    request,
  }) => {
    const { anySlug } = await readLiveData(request);
    const violations = await watchCsp(page);
    for (const path of [
      "/",
      "/explore/",
      `/spots/${anySlug}/`,
      "/settings/inquiry/",
      "/en/",
      `/en/spots/${anySlug}/`,
    ]) {
      await page.goto(path);
      await expect(page.locator("main"), `${path} 화면`).toBeVisible();
      // 지도 타일·사진·글꼴 요청까지 끝나야 위반이 나옴. 5분 주기 조회가 있어 오래 기다리지 않음
      await page
        .waitForLoadState("networkidle", { timeout: 10_000 })
        .catch(() => undefined);
    }
    expect(violations, "CSP 위반(주소 → 내용)").toEqual([]);
  });
});
