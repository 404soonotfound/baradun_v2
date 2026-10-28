import { defineConfig } from "@playwright/test";

// E2E 스위트 (BRD-39). 빌드 결과(out/)를 정적 서버로 띄우고 /data/**는 테스트가 가짜 응답으로 채움(e2e/fixtures.ts)
// 먼저 NEXT_PUBLIC_SITE_URL=https://example.test npm run build -w apps/web(빌드는 사이트 주소 필수, BRD-102). 실기기 대신 크기·터치 에뮬레이션(모바일 390×844 · PC 1280)으로 확인함
const PORT = Number(process.env.E2E_PORT ?? 3109);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    // 서비스 워커가 요청을 가로채면 page.route 가짜 응답이 안 먹어서 막음(오프라인 홈은 BRD-42 단위 테스트)
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "mobile",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "desktop",
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: {
    command: "node e2e/static-server.mjs",
    url: `${baseURL}/`,
    reuseExistingServer: !process.env.CI,
    env: { E2E_PORT: String(PORT) },
  },
});
