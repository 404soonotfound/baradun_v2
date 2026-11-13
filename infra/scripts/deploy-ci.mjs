#!/usr/bin/env node
// main 머지 뒤 인프라 자동 배포 (#418). GitHub Actions deploy.yml의 infra·infra-approve·infra-watch 작업에서만 부름
//   node --import tsx scripts/deploy-ci.mjs plan      변경 세트를 만들고 판정. 자동이면 바로 실행
//   node --import tsx scripts/deploy-ci.mjs execute   승인받은 변경 세트 실행(infra-approval environment)
//   node --import tsx scripts/deploy-ci.mjs watch     배포 뒤 바뀐 함수 로그 점검·지도 판 확인·결과 댓글
// 판정은 deploy-plan.ts autoDeployDecision(사용자 결정 2026-11-13 A안):
//   삭제·교체(!!)가 있으면 승인 대기, boundary가 저장소와 다르면 로컬 deploy:infra로 넘김, 그 밖은 바로 실행
// - 자격 증명: configure-aws-credentials가 넣은 CI 역할(BaradunGitHubInfraDeploy, 스택 밖) 임시 키
//   CI 역할은 CDK 부트스트랩 역할 맡기·읽기만 함. 변경 세트 실행·지우기는 CDK 배포 역할(cdk-deploy 프로필)로 함
//   boundary·실행 정책은 읽기만(고치는 권한 없음). 정책을 읽지 못하면 '같음'으로 넘기지 않고 멈춤
// - AWS 조회(정책·변경 세트·실패 이벤트·로그)는 로컬 deploy.mjs와 같은 deploy-aws.ts를 씀
// - 승인 실행(infra-approve)은 다음 자동 배포를 막지 않게 다른 동시 실행 그룹 → 스택이 진행 중이면 끝날 때까지 기다린 뒤 판정
// - 스택 파라미터는 넘기지 않음(deploy.mjs와 같음, infra/README 배포)
// - 댓글·실행 요약·오류 메시지는 계정 번호를 가림. cdk·지도 판 확인 출력(Actions 로그)은 그대로 둠
//   (계정 번호는 bootstrap/*.json에 이미 공개). 키 값은 출력하지 않음
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  autoDeployDecision,
  changedFunctionIds,
  changeSetName,
  checkLine,
  ciConclusion,
  deployComment,
  deployFailureComment,
  formatPolicyDiff,
  formatTable,
  isEmptyChangeSet,
  linkedIssues,
  policyDiff,
  redactAccount,
  REGION,
  STACK_NAME,
  summarizeChanges,
} from "./deploy-plan.ts";
import {
  checkFunctionLogs,
  failedEventsOrNull,
  isReady,
  readChangeSetPages,
  readRemotePolicy,
  stackStatus,
  waitWhileInProgress,
} from "./deploy-aws.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const infraDir = path.resolve(here, "..");
const repoRoot = path.resolve(infraDir, "..");
const BOOTSTRAP = path.join(infraDir, "bootstrap");
const BOUNDARY = "BaradunV2-RoleBoundary";
const VIA = "main 머지 뒤 자동 배포";
// 배포 뒤 로그를 볼 시간(분). 해상 특보 수집 주기(15분)를 한 번은 지나게(deploy.mjs와 같음)
const WATCH_MINUTES = 16;
const LOG_MAX_EVENTS = 20_000;
// 다른 배포와 겹쳐 진행 중 오류가 나면 기다린 뒤 다시 하는 횟수
const IN_PROGRESS_RETRIES = 1;
const IN_PROGRESS_ERROR =
  /UPDATE_IN_PROGRESS|_IN_PROGRESS state|is in .*IN_PROGRESS/;

const mode = process.argv[2];
const env = (name) => {
  const value = process.env[name];
  if (!value) fail(`환경 변수 ${name}가 없어요`);
  return value;
};

function fail(message) {
  console.error(`::error::${redactAccount(message)}`);
  process.exit(1);
}

function run(
  cmd,
  args,
  { cwd, extraEnv, capture = true, allowFail = false, input } = {},
) {
  const result = spawnSync(cmd, args, {
    cwd: cwd ?? repoRoot,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: capture
      ? [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
      : "inherit",
  });
  if (result.error) fail(`${cmd}를 실행하지 못했어요: ${result.error.message}`);
  if (result.status !== 0 && !allowFail) {
    if (capture) process.stderr.write(redactAccount(result.stderr ?? ""));
    fail(
      `${cmd} ${args.slice(0, 3).join(" ")} 실패(종료 코드 ${result.status})`,
    );
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// CI 역할(환경 변수 키)로 부르는 aws
const aws = (args, options = {}) =>
  run("aws", [...args, "--region", REGION, "--output", "json"], options);
// 공유 조회(deploy-aws.ts)에 넘기는 실행기. 실패해도 결과를 돌려줌
const awsRunner = (args) => aws(args, { allowFail: true });

// GitHub 작업 출력·요약
function output(name, value) {
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
function summary(markdown) {
  const text = redactAccount(markdown);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  console.log(text);
}

const repo = env("REPO");
const sha = env("HEAD_SHA");
const runUrl = `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""}`;
const subject = run("git", ["log", "--oneline", "-1", sha]).stdout.trim();

// 결과 댓글: 이 커밋을 머지한 PR 설명의 연결 이슈마다. 연결 이슈가 없으면 PR에. 실패해도 배포 결과는 바꾸지 않음
function postComment(body) {
  const text = redactAccount(body);
  const pulls = run("gh", ["api", `repos/${repo}/commits/${sha}/pulls`], {
    allowFail: true,
  });
  let targets = [];
  if (pulls.status === 0) {
    for (const pr of JSON.parse(pulls.stdout)) {
      const issues = linkedIssues(pr.body);
      targets.push(...(issues.length > 0 ? issues : [pr.number]));
    }
  }
  targets = [...new Set(targets)];
  if (targets.length === 0) {
    console.log(
      "::warning::이 커밋에 연결된 PR·이슈를 찾지 못해 댓글을 남기지 않았어요. 실행 요약을 확인해 주세요.",
    );
    return;
  }
  for (const n of targets) {
    const posted = run(
      "gh",
      ["issue", "comment", String(n), "--repo", repo, "--body-file", "-"],
      { input: text, allowFail: true },
    );
    if (posted.status !== 0) {
      process.stderr.write(redactAccount(posted.stderr));
      console.log(`::warning::#${n}에 댓글을 남기지 못했어요`);
    }
  }
}

// ── 공통: main·계정·스택·정책 ──

// main 맨 위 커밋. 이 커밋보다 앞서 있으면 새 커밋의 실행이 배포함(낡은 커밋을 나중에 올리지 않음)
function mainHead() {
  run("git", ["fetch", "-q", "origin", "main"]);
  return run("git", ["rev-parse", "origin/main"]).stdout.trim();
}

function identity() {
  return JSON.parse(aws(["sts", "get-caller-identity"]).stdout).Account;
}

// 다른 배포가 진행 중이면 끝날 때까지(최대 30분) 기다린 뒤, 새 변경을 받을 수 있는 상태인지 확인
// 30분이 지나도 진행 중이면 멈춤(CI 역할 키 2시간 안에 자기 배포 대기를 남김)
function requireStackReady() {
  const status = waitWhileInProgress(awsRunner, STACK_NAME);
  if (!isReady(status)) {
    fail(
      `스택이 ${status ?? "확인 못 함"} 상태라 배포하지 않아요. 콘솔에서 상태를 확인해 주세요.`,
    );
  }
}

const localPolicy = (file) =>
  JSON.parse(readFileSync(path.join(BOOTSTRAP, file), "utf8"));

// 스택 밖 정책 비교. strict면 읽지 못할 때 멈춤(판정에 씀). 아니면 '확인 못 함'으로 적고 이어 감(배포 뒤 보고)
// account가 null(계정을 확인하지 못함)이면 모두 '확인 못 함'
function comparePolicies(account, { strict }) {
  const read = (policy, file) => {
    const got =
      account === null
        ? { kind: "error", stderr: "" }
        : readRemotePolicy(
            awsRunner,
            `arn:aws:iam::${account}:policy/${policy}`,
          );
    if (got.kind !== "ok") {
      if (got.kind === "error") process.stderr.write(redactAccount(got.stderr));
      if (strict)
        fail(
          `${policy} 정책을 읽지 못했어요(${got.kind === "missing" ? "없음" : "조회 실패"}). CI 역할 권한(infra/bootstrap/github-infra-deploy-policy.json)을 확인해 주세요.`,
        );
      return { policy, error: true };
    }
    return {
      policy,
      version: got.version,
      diff: policyDiff(localPolicy(file), got.doc),
    };
  };
  const boundary = read(BOUNDARY, "role-boundary-policy.json");
  const executions = [
    read("BaradunCdkExecution", "cfn-execution-policy.json"),
    read("BaradunCdkExecutionWorkload", "cfn-execution-workload-policy.json"),
  ];
  const line = (r) =>
    r.error
      ? `   ${r.policy}: 확인 못 함(정책을 읽지 못함)`
      : formatPolicyDiff(`${r.policy}(${r.version})`, r.diff);
  return {
    // 읽지 못하면 '같음'으로 보지 않음
    boundarySame: !boundary.error && boundary.diff.same,
    boundaryLine: line(boundary),
    boundaryText: boundary.error
      ? "확인 못 함(정책을 읽지 못함)"
      : boundary.diff.same
        ? `저장소와 같음(${boundary.version})`
        : `저장소와 다름(${boundary.version})`,
    executionLines: executions.map(line),
  };
}

// 변경 세트 실행·지우기는 CDK 배포 역할로(iam:PassRole을 가진 역할). CI 역할 키를 원본으로 맡음
function deployRoleAws(account) {
  const dir = mkdtempSync(path.join(tmpdir(), "baradun-ci-"));
  const config = path.join(dir, "config");
  writeFileSync(
    config,
    [
      "[profile cdk-deploy]",
      `role_arn = arn:aws:iam::${account}:role/cdk-hnb659fds-deploy-role-${account}-${REGION}`,
      "credential_source = Environment",
      "role_session_name = baradun-infra-ci",
      `region = ${REGION}`,
      "",
    ].join("\n"),
  );
  return (args, options = {}) =>
    run(
      "aws",
      [
        ...args,
        "--profile",
        "cdk-deploy",
        "--region",
        REGION,
        "--output",
        "json",
      ],
      {
        ...options,
        extraEnv: { AWS_CONFIG_FILE: config, ...options.extraEnv },
      },
    );
}

// 변경 세트 내용. 없으면 null, 읽지 못하면 멈춤(일부 행만으로 판정하지 않음)
function readChangeSet(name) {
  const got = readChangeSetPages(awsRunner, STACK_NAME, name);
  if (got.kind === "missing") return null;
  if (got.kind === "error") {
    process.stderr.write(redactAccount(got.stderr));
    fail("변경 세트를 읽지 못했어요. 위 오류를 확인해 주세요.");
  }
  return { changeSet: got.changeSet, rows: summarizeChanges(got.changes) };
}

// 변경 세트를 만들고(실행하지 않음) 읽음. 바뀐 것이 없어 cdk가 지웠으면 null
// 다른 배포와 겹쳐 실패하면 끝나기를 기다린 뒤 한 번 더 만듦
function createChangeSet(name) {
  for (let attempt = 0; ; attempt += 1) {
    console.log(`변경 세트를 만들어요 (${name}, 아직 실행하지 않음)`);
    const made = run(
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
      { cwd: infraDir, capture: false, allowFail: true },
    );
    if (made.status === 0) return readChangeSet(name);
    // 진행 중인 다른 배포 때문인지 상태로 확인(cdk 출력은 화면으로 바로 나가 읽지 않음)
    // 진행 중이 아니면(합성 오류 등) 다시 해도 같으므로 바로 멈춤
    const before = stackStatus(awsRunner, STACK_NAME).value;
    if (attempt >= IN_PROGRESS_RETRIES || !before?.endsWith("_IN_PROGRESS"))
      fail(
        "변경 세트를 만들지 못했어요(cdk deploy --no-execute 실패). 위 로그를 확인해 주세요.",
      );
    const status = waitWhileInProgress(awsRunner, STACK_NAME);
    if (!isReady(status))
      fail(
        `스택이 ${status ?? "확인 못 함"} 상태라 변경 세트를 만들지 못했어요.`,
      );
    console.log("스택이 준비돼 변경 세트를 한 번 더 만들어요");
  }
}

function tableMarkdown(rows) {
  return ["```", formatTable(rows), "```"].join("\n");
}

// 실행·대기. 실패하면 실패 이벤트를 댓글로 남기고 멈춤
async function executeAndWait(account, name, rows, policies) {
  const deployAws = deployRoleAws(account);
  let startedAt;
  for (let attempt = 0; ; attempt += 1) {
    // 기다린 다른 배포의 실패 이벤트를 이번 실패로 적지 않게 실행할 때마다 다시 잼
    startedAt = new Date();
    const executed = deployAws(
      [
        "cloudformation",
        "execute-change-set",
        "--stack-name",
        STACK_NAME,
        "--change-set-name",
        name,
      ],
      { allowFail: true },
    );
    if (executed.status === 0) break;
    process.stderr.write(redactAccount(executed.stderr));
    // 다른 배포가 진행 중이면 기다렸다가 한 번 더(그 배포가 이 변경 세트를 낡게 했으면 다시 실패하고 멈춤)
    if (
      attempt >= IN_PROGRESS_RETRIES ||
      !IN_PROGRESS_ERROR.test(executed.stderr)
    ) {
      // 실행되지 않아 이 커밋의 변경이 반영되지 않음 → 실행 요약만이 아니라 댓글로도 알림
      postComment(
        [
          `## 인프라 배포 실패 (${VIA})`,
          "",
          `- 커밋: ${subject}`,
          `- 변경 세트: \`${name}\` (실행하지 못함, 스택은 바뀌지 않음)`,
          `- 실행 기록: ${runUrl}`,
          "",
          "다른 배포가 먼저 실행돼 변경 세트가 지워졌을 수 있어요. 실행 기록의 오류를 확인하고, 이 커밋이 main 맨 위면 실행 기록에서 다시 실행하거나 로컬 `npm run deploy:infra`로 배포해 주세요.",
        ].join("\n") + "\n",
      );
      fail(`변경 세트 ${name}를 실행하지 못했어요. 위 오류를 확인해 주세요.`);
    }
    requireStackReady();
  }
  console.log(`변경 세트 ${name}를 실행하고 끝날 때까지 기다려요`);
  const waited = aws(
    [
      "cloudformation",
      "wait",
      "stack-update-complete",
      "--stack-name",
      STACK_NAME,
    ],
    { allowFail: true },
  );
  if (waited.status !== 0) {
    process.stderr.write(redactAccount(waited.stderr));
    // 자격 증명이 만료됐으면 이벤트도 못 읽음 → '읽지 못함'으로 적고 댓글은 남김
    postComment(
      deployFailureComment({
        via: VIA,
        subject,
        changeSet: name,
        boundary: policies.boundaryText,
        failed: failedEventsOrNull(awsRunner, STACK_NAME, startedAt),
        extra: [`- 실행 기록: ${runUrl}`],
      }),
    );
    fail(
      "배포가 끝났는지 확인하지 못했어요(실패·롤백, 1시간 넘게 진행 중, 또는 자격 증명 만료). 콘솔의 스택 상태를 확인하고, 진행 중이면 다시 배포하지 마세요.",
    );
  }
  const deployedAt = new Date();
  summary(
    `### 배포 완료\n\n- 커밋: ${subject}\n- 변경 세트: \`${name}\` · 리소스 ${rows.length}개`,
  );
  output("deployed_at", String(deployedAt.getTime()));
  // 실행한 변경 세트의 행. watch가 댓글 표·바뀐 함수에 씀(실행한 변경 세트는 다시 못 읽을 수 있음)
  output("rows", JSON.stringify(rows));
  output("change_set", name);
}

// ── plan: 변경 세트 만들고 판정 ──

async function plan() {
  // 1. main이 이 커밋보다 앞서 있으면 건너뜀(새 커밋의 CI가 끝나면 그 실행이 배포함)
  const superseded = () => {
    const head = mainHead();
    if (head === sha) return false;
    summary(
      `### 인프라 배포 건너뜀\n\nmain이 이미 ${head.slice(0, 7)}로 앞서 있어요. 그 커밋의 CI가 끝나면 그 실행이 배포해요.`,
    );
    output("kind", "superseded");
    return true;
  };
  if (superseded()) return;
  const checks = JSON.parse(
    run("gh", [
      "api",
      `repos/${repo}/commits/${sha}/check-runs?check_name=ci-ok`,
    ]).stdout,
  );
  if (ciConclusion(checks.check_runs) !== "success")
    fail("이 커밋의 ci-ok가 성공이 아니라 배포하지 않아요.");

  // 2. 계정·스택·정책
  const account = identity();
  requireStackReady();
  // 다른 배포를 기다리는 사이 main이 앞섰으면 낡은 커밋을 배포하지 않음
  if (superseded()) return;
  const policies = comparePolicies(account, { strict: true });

  // 3. 변경 세트(실행하지 않음). cdk는 환경 변수 키로 부트스트랩 역할을 맡음
  //    boundary가 다르면 CI가 배포할 수 없으니(local) 만들지 않음
  const name = changeSetName(sha, new Date());
  const read = policies.boundarySame ? createChangeSet(name) : null;
  let hasChangeSet = read !== null;
  let rows = [];
  if (read) {
    if (isEmptyChangeSet(read.changeSet)) {
      deployRoleAws(account)([
        "cloudformation",
        "delete-change-set",
        "--stack-name",
        STACK_NAME,
        "--change-set-name",
        name,
      ]);
      hasChangeSet = false;
    } else if (read.changeSet.Status !== "CREATE_COMPLETE") {
      fail(
        `변경 세트를 만들지 못했어요: ${read.changeSet.Status} ${read.changeSet.StatusReason ?? ""}`,
      );
    } else {
      rows = read.rows;
    }
  }

  // 4. 판정
  const decision = autoDeployDecision({
    hasChangeSet,
    rows,
    boundarySame: policies.boundarySame,
  });
  const title = {
    none: "바뀌는 스택 리소스가 없어요",
    auto: "삭제·교체가 없어 바로 실행해요",
    hold: "삭제·교체가 있어 승인을 기다려요",
    local: "boundary가 저장소와 달라 로컬 배포가 필요해요",
  }[decision.kind];
  summary(
    [
      `### 인프라 변경 세트: ${title}`,
      "",
      `- 커밋: ${subject}`,
      hasChangeSet
        ? `- 변경 세트: \`${name}\` · 리소스 ${rows.length}개`
        : policies.boundarySame
          ? "- 변경 세트: 없음"
          : "- 변경 세트: 만들지 않음(boundary가 달라 CI가 배포하지 않음)",
      `- boundary: ${policies.boundaryLine.trim()}`,
      ...policies.executionLines.map((l) => `- 실행 정책: ${l.trim()}`),
      ...decision.reasons.map((r) => `- 이유: ${r}`),
      "",
      hasChangeSet ? tableMarkdown(rows) : "",
    ].join("\n"),
  );
  output("kind", decision.kind);
  output("change_set", hasChangeSet ? name : "");

  if (decision.kind === "hold") {
    postComment(
      [
        `## 인프라 배포 승인 대기 (${VIA})`,
        "",
        `- 커밋: ${subject}`,
        `- 변경 세트: \`${name}\` · 리소스 ${rows.length}개`,
        ...decision.reasons.map((r) => `- !! ${r}`),
        "",
        `데이터가 사라질 수 있는 변경이라 바로 실행하지 않았어요. 표를 확인하고 실행 기록의 **infra-approve** 작업에서 승인하면 이 변경 세트를 실행해요: ${runUrl}`,
      ].join("\n") + "\n",
    );
    return;
  }
  if (decision.kind === "local") {
    postComment(
      [
        `## 인프라 자동 배포 멈춤 (${VIA})`,
        "",
        `- 커밋: ${subject}`,
        `- boundary: ${policies.boundaryLine.trim()}`,
        "",
        `boundary(권한 상한)는 CI가 고치지 않아요. 로컬에서 \`npm run deploy:infra -- --issue <번호>\`로 배포해 주세요(boundary 반영 → 변경 세트 실행). 실행 기록: ${runUrl}`,
      ].join("\n") + "\n",
    );
    fail(
      "boundary가 저장소와 달라 자동 배포를 멈췄어요. 로컬 npm run deploy:infra가 필요해요.",
    );
  }
  if (decision.kind === "auto")
    await executeAndWait(account, name, rows, policies);
}

// ── execute: 승인받은 변경 세트 실행 ──

async function execute() {
  const name = env("CHANGE_SET");
  // 이 실행의 커밋으로 만든 변경 세트만(다른 커밋의 변경 세트를 승인으로 실행하지 않음)
  if (!name.startsWith(`deploy-${sha.slice(0, 7)}-`))
    fail(`변경 세트 ${name}는 이 커밋(${sha.slice(0, 7)})의 것이 아니에요.`);
  // 기다리는 동안 main이 앞서면 실행하지 않음(옛 변경 세트를 실행하면 새 커밋의 변경 세트가 지워져 새 변경이 남음)
  const head = mainHead();
  if (head !== sha)
    fail(
      `승인을 기다리는 동안 main이 ${head.slice(0, 7)}로 앞섰어요. 이 변경 세트는 실행하지 않으니 그 커밋의 실행 결과를 확인해 주세요.`,
    );
  const account = identity();
  requireStackReady();
  // 기다리는 동안 boundary가 바뀌었으면 실행하지 않음
  const policies = comparePolicies(account, { strict: true });
  if (!policies.boundarySame)
    fail(
      "승인을 기다리는 동안 boundary가 저장소와 달라졌어요. 로컬 npm run deploy:infra로 배포해 주세요.",
    );
  const read = readChangeSet(name);
  if (!read)
    fail(`변경 세트 ${name}가 없어요(지워졌거나 새 배포가 먼저 실행됨).`);
  const { changeSet, rows } = read;
  // 다른 배포가 먼저 실행되면 OBSOLETE가 됨 → 실행하지 않음(새 변경 세트가 따로 판정됨)
  if (
    changeSet.Status !== "CREATE_COMPLETE" ||
    changeSet.ExecutionStatus !== "AVAILABLE"
  ) {
    fail(
      `변경 세트를 실행할 수 없는 상태예요: ${changeSet.Status}/${changeSet.ExecutionStatus}. 새 배포가 먼저 실행됐다면 그 결과를 확인해 주세요.`,
    );
  }
  summary(
    `### 승인받은 변경 세트 실행\n\n- 커밋: ${subject}\n- 변경 세트: \`${name}\`\n\n${tableMarkdown(rows)}`,
  );
  await executeAndWait(account, name, rows, policies);
}

// ── watch: 배포 뒤 로그 점검·지도 판 확인·결과 댓글 ──
// 배포는 이미 끝났으므로 읽지 못한 것은 '확인 못 함'으로 적고 결과 댓글은 꼭 남김

async function watch() {
  const name = env("CHANGE_SET");
  const deployedAt = Number(env("DEPLOYED_AT"));
  const rows = JSON.parse(env("ROWS"));
  const functions = changedFunctionIds(rows);
  // 계정을 확인하지 못해도 멈추지 않음(정책은 '확인 못 함', 로그 점검·댓글은 이어 감)
  const who = aws(["sts", "get-caller-identity"], { allowFail: true });
  const account = who.status === 0 ? JSON.parse(who.stdout).Account : null;
  if (account === null) process.stderr.write(redactAccount(who.stderr));
  const policies = comparePolicies(account, { strict: false });
  let checks = [];
  if (functions.length > 0) {
    const waitMs = deployedAt + WATCH_MINUTES * 60_000 - Date.now();
    if (waitMs > 0) {
      console.log(
        `바뀐 함수 ${functions.length}개의 로그를 ${Math.ceil(waitMs / 60_000)}분 더 기다렸다가 봐요`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    checks = checkFunctionLogs(
      awsRunner,
      STACK_NAME,
      functions,
      deployedAt,
      LOG_MAX_EVENTS,
    );
    for (const check of checks) console.log(redactAccount(checkLine(check)));
  }

  // 지도 판 확인(D19-1 · #392): 공개 주소만 읽음. 실패해도 멈추지 않고 결과를 남김(정상으로 보지 않음)
  const siteUrl = process.env.SITE_URL ?? "";
  let mapCheck;
  if (!siteUrl) {
    mapCheck = "확인 못 함(저장소 변수 SITE_URL이 비어 있음)";
  } else {
    const verified = run(
      process.execPath,
      [
        path.join(repoRoot, "tools", "map-tiles", "verify.mjs"),
        "--site",
        siteUrl,
      ],
      { capture: false, allowFail: true },
    );
    mapCheck =
      verified.status === 0
        ? "통과"
        : `실패(종료 코드 ${verified.status}) → tools/map-tiles/README '지도 판 확인'`;
  }

  const comment =
    deployComment({
      via: VIA,
      subject,
      changeSet: name,
      rows,
      boundary: policies.boundaryText,
      executionPolicies: policies.executionLines,
      // 바뀐 함수가 없으면 checks가 비어 '하지 않음(바뀐 함수 없음)'으로 적힘
      watchMinutes: WATCH_MINUTES,
      checks,
    }) + `- 지도 판 확인: ${mapCheck}\n- 실행 기록: ${runUrl}\n`;
  summary(comment);
  postComment(comment);
}

if (mode === "plan") await plan();
else if (mode === "execute") await execute();
else if (mode === "watch") await watch();
else fail("plan·execute·watch 중 하나를 써 주세요");
