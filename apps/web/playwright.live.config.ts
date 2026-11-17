import { defineConfig } from "@playwright/test";

// 운영 주소 읽기 전용 스모크 (#551, 노션 결정 기록 D30-6). 실행: npm run test:smoke:live -w apps/web -- --base-url <주소>
// 가짜 데이터 스위트(playwright.config.ts)와 달리 정적 서버를 띄우지 않고 /data/**를 가로채지 않음
// 실데이터라 값이 아니라 지켜야 할 조건만 봄. 로그인·쓰기·되돌리기는 하지 않음(결과만 보고)
// 주소는 scripts/smoke-live.mjs가 LIVE_BASE_URL·LIVE_ADMIN_URL·LIVE_EXPECT_COMMIT 환경 변수로 넘김
const baseURL = process.env.LIVE_BASE_URL;
if (!baseURL) {
  throw new Error(
    "LIVE_BASE_URL이 없어요. npm run test:smoke:live -w apps/web -- --base-url <주소>로 실행해 주세요.",
  );
}

export default defineConfig({
  testDir: "./e2e-live",
  fullyParallel: true,
  workers: 4,
  // 운영 상태를 그대로 보고하려고 다시 시도하지 않음
  retries: 0,
  reporter: "list",
  timeout: 45_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    // 서비스 워커 저장본이 아니라 지금 운영 파일을 보려고 막음
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
});
