#!/usr/bin/env node
// 운영 사이트 수동 배포 (BRD-133). 로컬에서 AWS에 올리지 않고 GitHub Actions deploy 워크플로를 main으로 실행함
// - AWS 키는 쓰지 않음. 배포는 Actions가 OIDC 임시 키로 함
// - 워크플로가 main 최신 커밋의 ci-ok 성공을 확인하고, 아니면 멈춤
// - gh CLI 로그인이 필요함(gh auth login)
import { spawnSync } from "node:child_process";

// gh workflow run이 돌려주는 '이번에 만든 실행' 주소에서 실행 ID를 꺼냄.
// 목록에서 시각으로 고르면 직전·동시 실행을 잘못 따라갈 수 있어서 주소로만 정함
// 주소가 표준 출력·오류 어느 쪽에 나와도 찾도록 둘 다 봄
const request = spawnSync(
  "gh",
  ["workflow", "run", "deploy.yml", "--ref", "main"],
  { encoding: "utf8" },
);
if (request.status !== 0) {
  process.stderr.write(request.stderr);
  process.exit(request.status ?? 1);
}
const output = `${request.stdout}\n${request.stderr}`;
const runId = output.match(/\/actions\/runs\/(\d+)/)?.[1];

if (runId === undefined) {
  console.error(
    "운영 배포는 요청했지만 실행 주소를 받지 못했어요. Actions 탭의 deploy 워크플로에서 확인해 주세요.",
  );
  process.exit(1);
}

console.log(`운영 배포를 요청했어요: 실행 ${runId}`);
const watch = spawnSync("gh", ["run", "watch", runId, "--exit-status"], {
  stdio: "inherit",
});
process.exit(watch.status ?? 1);
