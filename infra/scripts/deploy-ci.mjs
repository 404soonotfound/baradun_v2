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
// - 스택 파라미터는 넘기지 않음(deploy.mjs와 같음, infra/README 배포)
// - 로그·댓글·요약은 공개 저장소에 남으므로 계정 번호를 가림. 키 값은 출력하지 않음
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  autoDeployDecision,
  changeSetName,
  checkLine,
  ciConclusion,
  deployComment,
  failedEventsSince,
  formatPolicyDiff,
  formatTable,
  isEmptyChangeSet,
  isStackReady,
  linkedIssues,
  policyDiff,
  redactAccount,
  REGION,
  scanLogLines,
  STACK_NAME,
  summarizeChanges,
} from "./deploy-plan.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const infraDir = path.resolve(here, "..");
const repoRoot = path.resolve(infraDir, "..");
const BOOTSTRAP = path.join(infraDir, "bootstrap");
const BOUNDARY = "BaradunV2-RoleBoundary";
const VIA = "main 머지 뒤 자동 배포";
// 배포 뒤 로그를 볼 시간(분). 해상 특보 수집 주기(15분)를 한 번은 지나게(deploy.mjs와 같음)
const WATCH_MINUTES = 16;
const LOG_MAX_EVENTS = 20_000;

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
  return result;
}

// CI 역할(환경 변수 키)로 부르는 aws
const aws = (args, options = {}) =>
  run("aws", [...args, "--region", REGION, "--output", "json"], options);

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
      {
        input: text,
        allowFail: true,
      },
    );
    if (posted.status !== 0) {
      process.stderr.write(redactAccount(posted.stderr ?? ""));
      console.log(`::warning::#${n}에 댓글을 남기지 못했어요`);
    }
  }
}

// ── 공통: 계정·스택·정책 ──

function identity() {
  return JSON.parse(aws(["sts", "get-caller-identity"]).stdout).Account;
}

function requireStackReady() {
  const stack = JSON.parse(
    aws(["cloudformation", "describe-stacks", "--stack-name", STACK_NAME])
      .stdout,
  ).Stacks[0];
  if (!isStackReady(stack.StackStatus)) {
    fail(
      `스택이 ${stack.StackStatus} 상태라 배포하지 않아요. 콘솔에서 상태를 확인해 주세요.`,
    );
  }
  return stack.StackStatus;
}

// AWS 기본 버전 문서. 없거나 읽지 못하면 멈춤(권한·네트워크 오류를 '같음'으로 보지 않음)
function remotePolicy(account, policy) {
  const arn = `arn:aws:iam::${account}:policy/${policy}`;
  const got = aws(["iam", "get-policy", "--policy-arn", arn], {
    allowFail: true,
  });
  if (got.status !== 0) {
    process.stderr.write(redactAccount(got.stderr ?? ""));
    return null;
  }
  const version = JSON.parse(got.stdout).Policy.DefaultVersionId;
  const doc = JSON.parse(
    aws([
      "iam",
      "get-policy-version",
      "--policy-arn",
      arn,
      "--version-id",
      version,
    ]).stdout,
  ).PolicyVersion.Document;
  return {
    version,
    doc: typeof doc === "string" ? JSON.parse(decodeURIComponent(doc)) : doc,
  };
}

const localPolicy = (file) =>
  JSON.parse(readFileSync(path.join(BOOTSTRAP, file), "utf8"));

function comparePolicies(account) {
  const boundary = remotePolicy(account, BOUNDARY);
  if (!boundary)
    fail(
      `${BOUNDARY} 정책을 읽지 못했어요. CI 역할 권한(infra/bootstrap/github-infra-deploy-policy.json)을 확인해 주세요.`,
    );
  const boundaryDiff = policyDiff(
    localPolicy("role-boundary-policy.json"),
    boundary.doc,
  );
  const executionLines = [
    ["BaradunCdkExecution", "cfn-execution-policy.json"],
    ["BaradunCdkExecutionWorkload", "cfn-execution-workload-policy.json"],
  ].map(([policy, file]) => {
    const remote = remotePolicy(account, policy);
    if (!remote) fail(`${policy} 정책을 읽지 못했어요.`);
    return formatPolicyDiff(
      `${policy}(${remote.version})`,
      policyDiff(localPolicy(file), remote.doc),
    );
  });
  return {
    boundarySame: boundaryDiff.same,
    boundaryLine: formatPolicyDiff(
      `${BOUNDARY}(${boundary.version})`,
      boundaryDiff,
    ),
    boundaryText: boundaryDiff.same
      ? `저장소와 같음(${boundary.version})`
      : `저장소와 다름(${boundary.version})`,
    executionLines,
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

// 변경 세트 내용(바뀐 리소스 행). 없으면 null
function readChangeSet(name) {
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
    if (/ChangeSetNotFound/.test(described.stderr ?? "")) return null;
    process.stderr.write(redactAccount(described.stderr ?? ""));
    fail("변경 세트를 읽지 못했어요. 위 오류를 확인해 주세요.");
  }
  let changeSet = JSON.parse(described.stdout);
  const first = changeSet;
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
  return { changeSet: first, rows: summarizeChanges(changes) };
}

const changedFunctions = (rows) =>
  rows
    .filter((r) => r.type === "AWS::Lambda::Function" && r.action !== "Remove")
    .map((r) => r.logicalId);

function tableMarkdown(rows) {
  return ["```", formatTable(rows), "```"].join("\n");
}

// 실행·대기. 실패하면 실패 이벤트를 댓글로 남기고 멈춤
async function executeAndWait(account, name, rows, policies) {
  const deployAws = deployRoleAws(account);
  const startedAt = new Date();
  deployAws([
    "cloudformation",
    "execute-change-set",
    "--stack-name",
    STACK_NAME,
    "--change-set-name",
    name,
  ]);
  console.log(`변경 세트 ${name}를 실행하고 끝날 때까지 기다려요`);
  const waited = aws(
    [
      "cloudformation",
      "wait",
      "stack-update-complete",
      "--stack-name",
      STACK_NAME,
    ],
    {
      allowFail: true,
    },
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
    const failed = failedEventsSince(events, startedAt).slice(0, 5);
    postComment(
      [
        `## 인프라 배포 실패 (${VIA})`,
        "",
        `- 커밋: ${subject}`,
        `- 변경 세트: \`${name}\``,
        `- boundary: ${policies.boundaryText}`,
        ...failed.map(
          (e) =>
            `- ${e.LogicalResourceId}: ${e.ResourceStatus} ${e.ResourceStatusReason ?? ""}`,
        ),
        `- 실행 기록: ${runUrl}`,
        "",
        "스택 상태를 콘솔에서 확인해 주세요. 진행 중이면 다시 배포하지 않아요.",
      ].join("\n") + "\n",
    );
    fail(
      "배포가 끝났는지 확인하지 못했어요(실패·롤백 또는 1시간 넘게 진행 중). 콘솔의 스택 상태를 확인해 주세요.",
    );
  }
  const deployedAt = new Date();
  summary(
    `### 배포 완료\n\n- 커밋: ${subject}\n- 변경 세트: \`${name}\` · 리소스 ${rows.length}개`,
  );
  output("deployed_at", String(deployedAt.getTime()));
  output("functions", JSON.stringify(changedFunctions(rows)));
  output("change_set", name);
}

// ── plan: 변경 세트 만들고 판정 ──

async function plan() {
  // 1. main이 이 커밋보다 앞서 있으면 건너뜀(새 커밋의 CI가 끝나면 그 실행이 배포함)
  run("git", ["fetch", "-q", "origin", "main"]);
  const head = run("git", ["rev-parse", "origin/main"]).stdout.trim();
  if (head !== sha) {
    summary(
      `### 인프라 배포 건너뜀\n\nmain이 이미 ${head.slice(0, 7)}로 앞서 있어요. 그 커밋의 CI가 끝나면 그 실행이 배포해요.`,
    );
    output("kind", "superseded");
    return;
  }
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
  const policies = comparePolicies(account);

  // 3. 변경 세트(실행하지 않음). cdk는 환경 변수 키로 부트스트랩 역할을 맡음
  const name = changeSetName(sha, new Date());
  console.log(`변경 세트를 만들어요 (${name}, 아직 실행하지 않음)`);
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
    { cwd: infraDir, capture: false },
  );
  const read = readChangeSet(name);
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
  const head4 = {
    none: "바뀌는 스택 리소스가 없어요",
    auto: "삭제·교체가 없어 바로 실행해요",
    hold: "삭제·교체가 있어 승인을 기다려요",
    local: "boundary가 저장소와 달라 로컬 배포가 필요해요",
  }[decision.kind];
  summary(
    [
      `### 인프라 변경 세트: ${head4}`,
      "",
      `- 커밋: ${subject}`,
      hasChangeSet
        ? `- 변경 세트: \`${name}\` · 리소스 ${rows.length}개`
        : "- 변경 세트: 없음",
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
    if (hasChangeSet) {
      deployRoleAws(account)([
        "cloudformation",
        "delete-change-set",
        "--stack-name",
        STACK_NAME,
        "--change-set-name",
        name,
      ]);
    }
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
  const account = identity();
  requireStackReady();
  // 기다리는 동안 boundary가 바뀌었으면 실행하지 않음
  const policies = comparePolicies(account);
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

async function watch() {
  const name = env("CHANGE_SET");
  const deployedAt = Number(env("DEPLOYED_AT"));
  const functions = JSON.parse(process.env.FUNCTIONS || "[]");
  const account = identity();
  const policies = comparePolicies(account);
  const read = readChangeSet(name);
  const rows = read ? read.rows : [];
  const checks = [];
  if (functions.length > 0) {
    const waitMs = deployedAt + WATCH_MINUTES * 60_000 - Date.now();
    if (waitMs > 0) {
      console.log(
        `바뀐 함수 ${functions.length}개의 로그를 ${Math.ceil(waitMs / 60_000)}분 더 기다렸다가 봐요`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const firstLine = (text) => (text ?? "").trim().split("\n")[0] ?? "";
    for (const logicalId of functions) {
      const resource = aws(
        [
          "cloudformation",
          "describe-stack-resource",
          "--stack-name",
          STACK_NAME,
          "--logical-resource-id",
          logicalId,
        ],
        { allowFail: true },
      );
      if (resource.status !== 0) {
        checks.push({ logicalId, error: firstLine(resource.stderr) });
        continue;
      }
      const functionName = JSON.parse(resource.stdout).StackResourceDetail
        .PhysicalResourceId;
      const config = aws(
        [
          "lambda",
          "get-function-configuration",
          "--function-name",
          functionName,
        ],
        { allowFail: true },
      );
      if (config.status !== 0) {
        checks.push({ logicalId, error: firstLine(config.stderr) });
        continue;
      }
      const logGroup =
        JSON.parse(config.stdout).LoggingConfig?.LogGroup ??
        `/aws/lambda/${functionName}`;
      const logs = aws(
        [
          "logs",
          "filter-log-events",
          "--log-group-name",
          logGroup,
          "--start-time",
          String(deployedAt),
          "--max-items",
          String(LOG_MAX_EVENTS),
        ],
        { allowFail: true },
      );
      if (logs.status !== 0) {
        checks.push({ logicalId, error: firstLine(logs.stderr) });
        continue;
      }
      const parsed = JSON.parse(logs.stdout);
      checks.push({
        logicalId,
        scan: scanLogLines((parsed.events ?? []).map((e) => e.message ?? "")),
        truncated: Boolean(parsed.NextToken),
      });
    }
    for (const check of checks) console.log(checkLine(check));
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
      {
        capture: false,
        allowFail: true,
      },
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
