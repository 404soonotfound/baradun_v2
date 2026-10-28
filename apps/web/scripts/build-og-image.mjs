// 공유 미리보기 공통 일러스트 PNG 만들기 (BRD-105). 원본은 assets/og/share.svg(자체 제작, 제작 기록은 원본 주석)
// 이미 개발 의존성인 Playwright Chromium으로 SVG를 1200×630 그대로 그려 public/og/share.png에 저장함
// 원본을 고쳤을 때만 손으로 돌리고 PNG를 함께 커밋함(빌드 때 돌리지 않음)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

const WIDTH = 1200;
const HEIGHT = 630;

const svg = readFileSync(
  new URL("../assets/og/share.svg", import.meta.url),
  "utf8",
);
const out = fileURLToPath(new URL("../public/og/share.png", import.meta.url));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<!doctype html><html><body style="margin:0">${svg}</body></html>`,
  );
  await page.screenshot({
    path: out,
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
  });
  console.log(`public/og/share.png 만듦 (${WIDTH}×${HEIGHT})`);
} finally {
  await browser.close();
}
