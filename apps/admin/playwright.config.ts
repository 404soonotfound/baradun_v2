import { defineConfig } from "@playwright/test";

// 운영자 사이트 E2E (BRD-148). 빌드 결과(out/)를 정적 서버로 띄우고 Cognito·/ops/*는 테스트가 가짜 응답으로 채움(e2e/fixtures.ts)
// 먼저 테스트용 풀 값으로 빌드: e2e/fixtures.ts TEST_POOL_ENV(README·CI와 같음)
const PORT = Number(process.env.E2E_PORT ?? 3111);
// Firefox·WebKit 엔진 프로젝트는 E2E_ENGINES=1일 때만 켬(npm run test:e2e:engines).
// 그냥 playwright test를 불러도 설치하지 않은 엔진까지 돌지 않게 함
const ENGINES = process.env.E2E_ENGINES === "1";
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // 엔진 시험은 무거워서 CI에서도 코어 절반만(부하 때 시간 문제로 흔들리지 않게)
  workers: process.env.CI && !ENGINES ? "100%" : "50%",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
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
      use: { browserName: "chromium", viewport: { width: 1280, height: 800 } },
    },
    // 지원 브라우저 기준안(D16-E2): Firefox·WebKit 엔진도 데스크톱 크기로 같은 시험을 돌림(BRD-147)
    // 실제 Safari 확인과는 따로(WebKit 엔진 E2E일 뿐). npm run test:e2e:engines, CI admin-e2e-engines
    ...(ENGINES
      ? [
          {
            name: "desktop-firefox",
            use: {
              browserName: "firefox" as const,
              viewport: { width: 1280, height: 800 },
            },
          },
          {
            name: "desktop-webkit",
            use: {
              browserName: "webkit" as const,
              viewport: { width: 1280, height: 800 },
            },
          },
        ]
      : []),
  ],
  webServer: {
    command: "node e2e/static-server.mjs",
    url: `${baseURL}/login/`,
    reuseExistingServer: !process.env.CI,
    env: { E2E_PORT: String(PORT) },
  },
});
