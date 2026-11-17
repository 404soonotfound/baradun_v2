#!/usr/bin/env node
// 운영 주소 읽기 전용 스모크 실행 (#551, 노션 결정 기록 D30-6)
// 사용: npm run test:smoke:live -w apps/web -- --base-url <사용자 사이트 주소> [--admin-url <운영자 사이트 주소>] [--expect-commit <커밋>]
// Playwright는 모르는 옵션을 받지 않아서, 주소는 환경 변수로 바꿔 playwright.live.config.ts에 넘김
import { spawnSync } from "node:child_process";

const USAGE =
  "사용: npm run test:smoke:live -w apps/web -- --base-url <주소> [--admin-url <주소>] [--expect-commit <커밋>] [Playwright 옵션]";
const OURS = ["base-url", "admin-url", "expect-commit"];

function fail(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

// 우리 옵션(--이름 값, --이름=값)은 꺼내고, 나머지(예: --project desktop)는 Playwright에 그대로 넘김
const values = {};
const passThrough = [];
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  const name = OURS.find(
    (option) => arg === `--${option}` || arg.startsWith(`--${option}=`),
  );
  if (name === undefined) {
    passThrough.push(arg);
    continue;
  }
  if (arg.includes("=")) {
    values[name] = arg.slice(arg.indexOf("=") + 1);
  } else {
    if (index + 1 >= args.length) fail(`--${name} 값이 없어요.`);
    values[name] = args[index + 1];
    index += 1;
  }
}

// https 주소만 받음. 경로·쿼리는 버리고 출처만 씀(잘못 붙인 경로로 다른 화면을 보지 않게)
function origin(name) {
  const raw = values[name];
  if (raw === undefined) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`--${name} 값이 주소가 아니에요: ${raw}`);
  }
  if (url.protocol !== "https:")
    fail(`--${name}은 https 주소여야 해요: ${raw}`);
  return url.origin;
}

const baseUrl = origin("base-url");
if (!baseUrl) fail("--base-url이 필요해요.");
const adminUrl = origin("admin-url");
const expectCommit = (values["expect-commit"] ?? "").toLowerCase();
if (expectCommit && !/^[0-9a-f]{7,40}$/.test(expectCommit)) {
  fail(`--expect-commit은 7~40자 커밋 해시여야 해요: ${expectCommit}`);
}

console.log(
  `운영 주소 스모크: ${baseUrl}${adminUrl ? ` · 운영자 ${adminUrl}` : ""}${expectCommit ? ` · 기준 커밋 ${expectCommit}` : ""}`,
);
const result = spawnSync(
  "playwright",
  ["test", "--config", "playwright.live.config.ts", ...passThrough],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      LIVE_BASE_URL: baseUrl,
      LIVE_ADMIN_URL: adminUrl,
      LIVE_EXPECT_COMMIT: expectCommit,
    },
  },
);
if (result.error) {
  console.error(`Playwright를 실행하지 못했어요: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
