#!/usr/bin/env node
// 운영 사이트 수동 배포 (BRD-133). 로컬에서 AWS에 올리지 않고 GitHub Actions deploy 워크플로를 main으로 실행함
// - AWS 키는 쓰지 않음. 배포는 Actions가 OIDC 임시 키로 함
// - 워크플로가 main 최신 커밋의 ci-ok 성공을 확인하고, 아니면 멈춤
// - gh CLI 로그인이 필요함(gh auth login)
import { execFileSync, spawnSync } from "node:child_process";

const WORKFLOW = "deploy.yml";

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

// 이번에 실행한 run만 고르려고 실행 직전 시각을 기준으로 둠
const startedAt = Date.now();
gh(["workflow", "run", WORKFLOW, "--ref", "main"]);
console.log("운영 배포를 요청했어요. 실행이 잡힐 때까지 기다려요…");

let runId = null;
for (let i = 0; i < 30 && runId === null; i++) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const runs = JSON.parse(
    gh([
      "run",
      "list",
      "--workflow",
      WORKFLOW,
      "--event",
      "workflow_dispatch",
      "--limit",
      "5",
      "--json",
      "databaseId,createdAt",
    ]),
  );
  // 시계 차이를 감안해 10초 앞까지 봄
  const run = runs.find((r) => Date.parse(r.createdAt) >= startedAt - 10_000);
  if (run) runId = String(run.databaseId);
}

if (runId === null) {
  console.error(
    "실행을 찾지 못했어요. Actions 탭의 deploy 워크플로에서 확인해 주세요.",
  );
  process.exit(1);
}

const watch = spawnSync("gh", ["run", "watch", runId, "--exit-status"], {
  stdio: "inherit",
});
process.exit(watch.status ?? 1);
