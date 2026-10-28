import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { CLEAR_ID, expect, slugOf, test } from "./fixtures";

// 공유 미리보기 이미지 (BRD-105 · 2026-10-28 확정 결정 16)
// 모든 페이지의 og:image·twitter:image는 자체 공통 일러스트만. 출처 표기 의무가 있는 해변 사진(TourAPI)은 쓰지 않음
const ILLUSTRATION_PATH = "/og/share.png";

// Playwright가 테스트 파일을 CommonJS로 읽어서 import.meta 대신 __dirname을 씀
const OUT = path.join(__dirname, "../out");
// 없는 주소용 화면. 공유 대상이 아니라 미리보기 메타를 두지 않음
const NOT_FOUND = new Set([
  "404.html",
  "404/index.html",
  "_not-found/index.html",
]);

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(file);
    return entry.name.endsWith(".html") ? [file] : [];
  });
}

const metaContents = (html: string, attr: string) =>
  [...html.matchAll(new RegExp(`<meta ${attr}="([^"]+)"`, "g"))].map(
    (match) => match[1] ?? "", // 빈 값은 아래 https 검사에서 걸림
  );

// 절대 https 주소이고 경로가 공통 일러스트인지(사이트 주소는 빌드 값이라 경로만 봄)
function expectIllustration(url: string | null) {
  expect(url).not.toBeNull();
  const parsed = new URL(url as string);
  expect(parsed.protocol).toBe("https:");
  expect(parsed.pathname).toBe(ILLUSTRATION_PATH);
  expect(parsed.hostname).not.toContain("visitkorea");
}

test.describe("공유 미리보기 이미지", () => {
  for (const pathname of [
    "/",
    "/explore/",
    `/spots/${slugOf(CLEAR_ID)}/`, // 공공누리 1유형 사진이 있는 해변
    "/en/",
    `/en/spots/${slugOf(CLEAR_ID)}/`,
  ]) {
    test(`${pathname}: og·twitter 이미지가 공통 일러스트`, async ({ page }) => {
      await page.goto(pathname);
      const og = page.locator('meta[property="og:image"]');
      const twitter = page.locator('meta[name="twitter:image"]');
      await expect(og).toHaveCount(1);
      await expect(twitter).toHaveCount(1);
      expectIllustration(await og.getAttribute("content"));
      expectIllustration(await twitter.getAttribute("content"));
      await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
        "content",
        "summary_large_image",
      );
    });
  }

  test("공통 일러스트 파일이 PNG로 내보내짐", async ({ request }) => {
    const response = await request.get(ILLUSTRATION_PATH);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
  });

  // 빌드한 모든 HTML을 한 번에 봄(브라우저가 필요 없어 한 프로젝트에서만)
  test("빌드한 모든 페이지가 공통 일러스트만 씀", async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "HTML 검사는 한 번만");
    const pages = htmlFiles(OUT).filter(
      (file) =>
        !NOT_FOUND.has(path.relative(OUT, file).split(path.sep).join("/")),
    );
    expect(pages.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const file of pages) {
      const html = readFileSync(file, "utf8");
      const images = [
        ...metaContents(html, 'property="og:image" content'),
        ...metaContents(html, 'name="twitter:image" content'),
      ];
      const ok =
        images.length === 2 &&
        images.every(
          (url) =>
            url.startsWith("https://") &&
            new URL(url).pathname === ILLUSTRATION_PATH,
        );
      if (!ok) wrong.push(`${path.relative(OUT, file)}: ${images.join(", ")}`);
    }
    expect(wrong).toEqual([]);
  });
});
