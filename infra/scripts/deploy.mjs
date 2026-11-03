#!/usr/bin/env node
// 인프라 배포 명령 하나 (BRD-169): npm run deploy:infra [-- --profile <AWS 프로필>]
// tsx로 실행함(판정 부분 deploy-plan.ts를 바로 가져옴)
// 순서: 배포용 작업 트리를 origin/main으로 → ci-ok 확인 → npm ci → 자격 증명 → 변경 세트 → 표 → yes일 때만 실행·대기
// - 사람이 실행함. yes를 입력하지 않으면 변경 세트만 남기고 끝냄
// - AlertEmail 등 스택 파라미터는 넘기지 않음(넘기면 예산 리소스가 교체되며 실패, infra/README 배포)
// - 자격 증명은 이 프로세스의 하위 명령 환경 변수로만 넘김. 파일·화면에 남기지 않음
// - 배포용 작업 트리 기본 위치: 저장소 옆 {저장소}-deploy. BARADUN_DEPLOY_DIR로 바꿀 수 있음
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import {
  changeSetName,
  ciConclusion,
  failedEventsSince,
  formatTable,
  isEmptyChangeSet,
  isStackReady,
  REGION,
  STACK_NAME,
  summarizeChanges,
} from "./deploy-plan.ts";

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  // 값 없이 쓰면 기본 프로필로 조용히 넘어가지 않게 멈춤
  if (!value || value.startsWith("--")) fail(`${name} 뒤에 값을 써 주세요`);
  return value;
}

function fail(message) {
  console.error(`\n[멈춤] ${message}`);
  process.exit(1);
}

// 명령 실행. capture면 출력을 돌려주고, 아니면 화면에 그대로 보여 줌
function run(cmd, args, { cwd, env, capture = false, allowFail = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  // 명령이 없으면(설치 안 됨) status가 null이고 error에 이유가 있음
  if (result.error) fail(`${cmd}를 실행하지 못했어요: ${result.error.message}`);
  if (result.status !== 0 && !allowFail) {
    if (capture) process.stderr.write(result.stderr ?? "");
    fail(
      `${cmd} ${args.slice(0, 3).join(" ")} 실패(종료 코드 ${result.status})`,
    );
  }
  return result;
}

// cdk에 넘기는 임시 키의 최소 남은 시간. 변경 세트 만들기(몇 분)만 쓰고, 실행·대기는 프로필로 함
// aws login 프로필은 15분짜리 키를 받아 aws CLI가 스스로 갱신하므로 긴 시간을 요구하면 늘 멈춤
const MIN_CREDENTIAL_MINUTES = 5;

const step = (n, text) => console.log(`\n[${n}/6] ${text}`);

const profile = arg("--profile") ?? process.env.AWS_PROFILE ?? "soo-login";
const commonDir = path.resolve(
  run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    capture: true,
  }).stdout.trim(),
);
const repoRoot = path.dirname(commonDir);
const deployDir = process.env.BARADUN_DEPLOY_DIR ?? `${repoRoot}-deploy`;

// 1. origin/main 최신 커밋과 그 커밋의 ci-ok
// 배포용 폴더를 옮기기 전에 확인함(CI가 실패한 커밋에 폴더를 남기지 않음)
step(1, "main 최신 커밋의 CI(ci-ok)가 통과했는지 확인해요");
run("git", ["-C", repoRoot, "fetch", "-q", "origin", "main"]);
const sha = run("git", ["-C", repoRoot, "rev-parse", "origin/main"], {
  capture: true,
}).stdout.trim();
const repo = run(
  "gh",
  ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
  {
    cwd: repoRoot,
    capture: true,
  },
).stdout.trim();
const checks = JSON.parse(
  run(
    "gh",
    ["api", `repos/${repo}/commits/${sha}/check-runs?check_name=ci-ok`],
    {
      capture: true,
    },
  ).stdout,
);
const ci = ciConclusion(checks.check_runs);
if (ci !== "success") {
  fail(
    {
      missing:
        "ci-ok 결과가 없어요. main CI가 돌았는지 Actions 탭에서 확인해 주세요.",
      pending: "ci-ok가 아직 도는 중이에요. 끝난 뒤 다시 실행해 주세요.",
      failure: "ci-ok가 실패했어요. 고친 뒤 다시 실행해 주세요.",
    }[ci],
  );
}
console.log(`   ${sha.slice(0, 7)} ci-ok 성공`);

// 2. 배포용 작업 트리를 그 커밋으로
step(2, `배포용 작업 트리를 맞춰요 (${deployDir})`);

if (!existsSync(deployDir)) {
  run("git", [
    "-C",
    repoRoot,
    "worktree",
    "add",
    "-q",
    "--detach",
    deployDir,
    sha,
  ]);
} else {
  const dirty = run("git", ["-C", deployDir, "status", "--porcelain"], {
    capture: true,
  }).stdout.trim();
  if (dirty)
    fail(
      `배포용 작업 트리에 고친 파일이 있어요. 확인 후 지워 주세요:\n${dirty}`,
    );
  run("git", ["-C", deployDir, "checkout", "-q", "--detach", sha]);
}
// 실행 중인 이 스크립트가 배포할 커밋의 것과 다르면 멈춤(오래된 체크아웃의 예전 절차로 배포하지 않게)
// 배포용 폴더에서 실행했다면 방금 새 커밋으로 바뀐 것이라 한 번 더 실행하면 됨
const here = path.dirname(fileURLToPath(import.meta.url));
const deployScripts = path.join(deployDir, "infra", "scripts");
for (const file of ["deploy.mjs", "deploy-plan.ts"]) {
  const target = path.join(deployScripts, file);
  if (
    !existsSync(target) ||
    readFileSync(path.join(here, file), "utf8") !== readFileSync(target, "utf8")
  ) {
    fail(
      path.resolve(here) === path.resolve(deployScripts)
        ? "배포 명령이 main의 새 버전으로 바뀌었어요. 같은 명령을 한 번 더 실행해 주세요: npm run deploy:infra"
        : `실행한 배포 명령(${here})이 main과 달라요. 배포용 폴더에서 실행해 주세요:\n` +
            `cd ${deployDir} && npm run deploy:infra`,
    );
  }
}
const subject = run("git", ["-C", deployDir, "log", "--oneline", "-1"], {
  capture: true,
}).stdout.trim();
console.log(`   ${subject}`);

// 3. 의존성
step(3, "의존성을 설치해요 (npm ci)");
run("npm", ["ci", "--no-audit", "--no-fund", "--loglevel=error"], {
  cwd: deployDir,
});

// 4. 자격 증명: aws 명령은 프로필을 그대로 씀(aws CLI가 aws login 키를 스스로 갱신 → 1시간 대기도 끊기지 않음)
// 셸에 남은 예전 키(AWS_ACCESS_KEY_ID 등)는 프로필보다 앞서므로 지움
step(4, `AWS 자격 증명을 확인해요 (프로필 ${profile})`);
const STATIC_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_DEFAULT_PROFILE",
];
const awsEnv = { ...process.env };
for (const key of STATIC_KEYS) delete awsEnv[key];
Object.assign(awsEnv, {
  AWS_PROFILE: profile,
  AWS_REGION: REGION,
  AWS_DEFAULT_REGION: REGION,
});
const aws = (args, options = {}) =>
  run("aws", [...args, "--region", REGION, "--output", "json"], {
    env: awsEnv,
    capture: true,
    ...options,
  });
const identity = aws(["sts", "get-caller-identity"], { allowFail: true });
if (identity.status !== 0) {
  // 실제 이유(프로필 이름 오타·네트워크 등)를 함께 보여 줌. 키 값은 이 출력에 없음
  process.stderr.write(identity.stderr ?? "");
  fail(
    `자격 증명을 쓰지 못했어요. 먼저 로그인해 주세요: aws login --profile ${profile}`,
  );
}
const account = JSON.parse(identity.stdout).Account;
const stack = JSON.parse(
  aws(["cloudformation", "describe-stacks", "--stack-name", STACK_NAME]).stdout,
).Stacks[0];
console.log(`   계정 ${account} · 스택 ${STACK_NAME} ${stack.StackStatus}`);
if (!isStackReady(stack.StackStatus)) {
  fail(
    `스택이 ${stack.StackStatus} 상태라 배포하지 않아요. 콘솔에서 상태를 확인해 주세요.`,
  );
}

// 5. 변경 세트. cdk는 aws login 프로필을 직접 못 읽는 경우가 있어 지금 키를 내보내 cdk에만 넘김
const exported = aws(
  [
    "configure",
    "export-credentials",
    "--profile",
    profile,
    "--format",
    "process",
  ],
  { allowFail: true },
);
if (exported.status !== 0) {
  fail(
    `자격 증명을 가져오지 못했어요. 먼저 로그인해 주세요: aws login --profile ${profile}`,
  );
}
const creds = JSON.parse(exported.stdout);
const remainingMin = creds.Expiration
  ? (Date.parse(creds.Expiration) - Date.now()) / 60_000
  : Infinity;
if (remainingMin < MIN_CREDENTIAL_MINUTES) {
  fail(
    `자격 증명이 ${Math.max(0, Math.floor(remainingMin))}분 뒤 만료돼요. 다시 로그인한 뒤 실행해 주세요: aws login --profile ${profile}`,
  );
}
const cdkEnv = { ...awsEnv };
delete cdkEnv.AWS_PROFILE;
Object.assign(cdkEnv, {
  AWS_ACCESS_KEY_ID: creds.AccessKeyId,
  AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
  ...(creds.SessionToken ? { AWS_SESSION_TOKEN: creds.SessionToken } : {}),
});
const name = changeSetName(sha, new Date());
step(5, `변경 세트를 만들어요 (${name}, 아직 실행하지 않음)`);
run(
  "npx",
  [
    "--no-install",
    "cdk",
    "deploy",
    STACK_NAME,
    "--no-execute",
    "--change-set-name",
    name,
    "--require-approval",
    "never",
  ],
  { cwd: path.join(deployDir, "infra"), env: cdkEnv },
);

const described = aws(
  [
    "cloudformation",
    "describe-change-set",
    "--stack-name",
    STACK_NAME,
    "--change-set-name",
    name,
  ],
  { allowFail: true },
);
if (described.status !== 0) {
  // cdk는 바뀐 것이 없으면 변경 세트를 지우고 끝냄 → 없음(ChangeSetNotFound)만 '바뀐 것 없음'으로 봄
  // 권한·네트워크 등 다른 실패를 '바뀐 것 없음'으로 넘기지 않음
  if (!/ChangeSetNotFound/.test(described.stderr ?? "")) {
    process.stderr.write(described.stderr ?? "");
    fail("변경 세트를 읽지 못했어요. 위 오류를 확인해 주세요.");
  }
  console.log("\n바뀐 것이 없어요. 배포할 내용이 없으니 끝낼게요.");
  process.exit(0);
}
let changeSet = JSON.parse(described.stdout);
if (isEmptyChangeSet(changeSet)) {
  aws([
    "cloudformation",
    "delete-change-set",
    "--stack-name",
    STACK_NAME,
    "--change-set-name",
    name,
  ]);
  console.log("\n바뀐 것이 없어요. 빈 변경 세트를 지우고 끝낼게요.");
  process.exit(0);
}
if (changeSet.Status !== "CREATE_COMPLETE") {
  fail(
    `변경 세트를 만들지 못했어요: ${changeSet.Status} ${changeSet.StatusReason ?? ""}`,
  );
}
const changes = [...(changeSet.Changes ?? [])];
while (changeSet.NextToken) {
  changeSet = JSON.parse(
    aws([
      "cloudformation",
      "describe-change-set",
      "--stack-name",
      STACK_NAME,
      "--change-set-name",
      name,
      "--next-token",
      changeSet.NextToken,
    ]).stdout,
  );
  changes.push(...(changeSet.Changes ?? []));
}
const rows = summarizeChanges(changes);
console.log(`\n바뀌는 리소스 ${rows.length}개:\n${formatTable(rows)}`);
const permissions = rows.filter((r) => r.permission && !r.danger);
if (permissions.length > 0) {
  console.log(
    `\n** 권한(역할·정책) 리소스가 ${permissions.length}개 바뀌어요(위 ** 줄). 권한이 넓어지는지 확인하세요.`,
  );
}
const dangers = rows.filter((r) => r.danger);
if (dangers.length > 0) {
  console.log(
    `\n\x1b[31m!! 경고: 삭제·교체되는 리소스가 ${dangers.length}개 있어요(위 !! 줄). 데이터가 사라질 수 있으니 꼭 확인하세요.\x1b[0m`,
  );
}

// 6. 실행
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (
  await rl.question(
    "\n실행하려면 yes를 입력하세요(다른 입력은 실행하지 않음): ",
  )
).trim();
rl.close();
if (answer !== "yes") {
  console.log(
    `\n실행하지 않았어요. 변경 세트 ${name}는 남아 있어요. 지우려면:\n` +
      `aws cloudformation delete-change-set --region ${REGION} --stack-name ${STACK_NAME} --change-set-name ${name}`,
  );
  process.exit(0);
}
step(6, "변경 세트를 실행하고 끝날 때까지 기다려요");
const startedAt = new Date();
aws([
  "cloudformation",
  "execute-change-set",
  "--stack-name",
  STACK_NAME,
  "--change-set-name",
  name,
]);
const waited = run(
  "aws",
  [
    "cloudformation",
    "wait",
    "stack-update-complete",
    "--stack-name",
    STACK_NAME,
    "--region",
    REGION,
  ],
  { env: awsEnv, allowFail: true },
);
if (waited.status !== 0) {
  const events = JSON.parse(
    aws([
      "cloudformation",
      "describe-stack-events",
      "--stack-name",
      STACK_NAME,
      "--max-items",
      "30",
    ]).stdout,
  ).StackEvents;
  const failed = failedEventsSince(events, startedAt);
  if (failed.length === 0)
    console.error(
      "   이번 실행의 실패 이벤트는 아직 없어요(진행 중일 수 있음).",
    );
  for (const e of failed.slice(0, 5)) {
    console.error(
      `   ${e.LogicalResourceId}: ${e.ResourceStatus} ${e.ResourceStatusReason ?? ""}`,
    );
  }
  fail(
    "배포가 끝났는지 확인하지 못했어요(실패·롤백, 1시간 넘게 진행 중, 또는 자격 증명 만료). 위 이유와 콘솔의 스택 상태를 확인하고, 진행 중이면 다시 배포하지 마세요.",
  );
}
console.log(`\n배포 완료: ${subject}`);
