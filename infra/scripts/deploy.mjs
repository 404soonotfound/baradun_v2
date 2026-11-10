#!/usr/bin/env node
// 인프라 배포 명령 하나 (BRD-169·GH-382):
//   npm run deploy:infra [-- --profile <AWS 프로필>] [--admin-profile <IAM 정책을 고칠 프로필>] [--watch <분>] [--issue <번호>]
// tsx로 실행함(판정 부분 deploy-plan.ts를 바로 가져옴)
// 순서: 배포용 작업 트리를 origin/main으로 → ci-ok 확인 → npm ci → 자격 증명 → 스택 밖 IAM 정책 비교
//   → 변경 세트 → 표 → yes일 때만 (boundary 반영) → 실행·대기 → 바뀐 함수 로그 점검 → (이슈 댓글)
// - boundary(BaradunV2-RoleBoundary)는 스택 밖에 둠(배포 역할이 자기 권한 상한을 못 고치게). 저장소와 다르면
//   같은 yes로 변경 세트보다 먼저 반영함(#375 때 빠뜨려 경보 읽기가 막힘). 반영은 --admin-profile(기본: --profile)로
// - 실행 정책(BaradunCdkExecution·Workload)은 다르면 경고만 함. 바꾸는 순서가 따로 있어 자동 반영하지 않음(infra/README)
// - 정책을 읽지 못하면 '같음'으로 넘기지 않고 멈춤
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
  checkLine,
  ciConclusion,
  ciStateWithRuns,
  deployComment,
  failedEventsSince,
  formatPolicyDiff,
  formatTable,
  isEmptyChangeSet,
  isStackReady,
  policyDiff,
  REGION,
  scanLogLines,
  STACK_NAME,
  summarizeChanges,
  versionToPrune,
} from "./deploy-plan.ts";

// 실행을 시작할 때의 스크립트 내용. 배포용 폴더에서 실행하면 2단계 체크아웃 뒤 디스크 파일이 새 버전으로 바뀜
// → 디스크끼리 비교하면 늘 같아서 예전 절차(메모리에 올라온 것)로 그대로 배포됨. 그래서 이 내용과 비교함
const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_FILES = ["deploy.mjs", "deploy-plan.ts"];
const startedScripts = Object.fromEntries(
  SCRIPT_FILES.map((file) => [
    file,
    readFileSync(path.join(here, file), "utf8"),
  ]),
);

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
function run(
  cmd,
  args,
  { cwd, env, capture = false, allowFail = false, input } = {},
) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
    input,
    stdio: capture
      ? [input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
      : "inherit",
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

const step = (n, text) => console.log(`\n[${n}/8] ${text}`);

// 0 이상 정수 인자. 틀리면 기본값으로 넘어가지 않고 멈춤
function intArg(name, fallback) {
  const value = arg(name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) fail(`${name} 뒤에는 0 이상 정수를 써 주세요`);
  return Number(value);
}

const profile = arg("--profile") ?? process.env.AWS_PROFILE ?? "soo-login";
const adminProfile = arg("--admin-profile") ?? profile;
// 배포 뒤 로그를 볼 시간(분). 해상 특보 수집 주기(15분)를 한 번은 지나게 기본 16분. 0이면 보지 않음
const watchMinutes = intArg("--watch", 16);
const issue = intArg("--issue", null);
if (issue === 0) fail("--issue 뒤에 이슈 번호를 써 주세요");
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
// ci-ok가 없을 때만 그 커밋의 ci 워크플로 상태를 봄(있으면 그 결과만으로 정함)
const found = ciConclusion(checks.check_runs);
const ci =
  found === "missing"
    ? ciStateWithRuns(
        found,
        JSON.parse(
          run(
            "gh",
            [
              "run",
              "list",
              "--repo",
              repo,
              "--commit",
              sha,
              "--workflow",
              "ci.yml",
              "--json",
              "status",
            ],
            { capture: true },
          ).stdout,
        ).map((r) => r.status),
      )
    : found;
if (ci !== "success") {
  fail(
    {
      missing:
        "이 커밋의 CI 기록이 없어요. main CI가 돌았는지 Actions 탭에서 확인해 주세요.",
      pending:
        "CI가 아직 도는 중이에요(보통 10분 안팎). 끝난 뒤 같은 명령을 다시 실행해 주세요.",
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
const deployScripts = path.join(deployDir, "infra", "scripts");
for (const file of SCRIPT_FILES) {
  const target = path.join(deployScripts, file);
  if (
    !existsSync(target) ||
    startedScripts[file] !== readFileSync(target, "utf8")
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

// 5. 스택 밖 IAM 정책: 배포할 커밋의 bootstrap/*.json과 AWS 기본 버전 비교
step(5, `스택 밖 IAM 정책을 저장소와 비교해요 (프로필 ${adminProfile})`);
const adminEnv = { ...awsEnv, AWS_PROFILE: adminProfile };
const iam = (args, options = {}) =>
  run("aws", [...args, "--output", "json"], {
    env: adminEnv,
    capture: true,
    ...options,
  });
// 관리 프로필이 다른 계정이면 이 계정 정책 대신 엉뚱한 계정을 읽거나 고치게 됨 → 계정이 같은지 먼저 확인
if (adminProfile !== profile) {
  const adminIdentity = iam(["sts", "get-caller-identity"], {
    allowFail: true,
  });
  if (adminIdentity.status !== 0) {
    process.stderr.write(adminIdentity.stderr ?? "");
    fail(
      `--admin-profile 자격 증명을 쓰지 못했어요. 먼저 로그인해 주세요: aws login --profile ${adminProfile}`,
    );
  }
  const adminAccount = JSON.parse(adminIdentity.stdout).Account;
  if (adminAccount !== account)
    fail(
      `--admin-profile(${adminProfile})의 계정이 배포 계정과 달라요. 같은 계정 프로필을 써 주세요.`,
    );
}
const BOOTSTRAP = path.join(deployDir, "infra", "bootstrap");
const policyArn = (policy) => `arn:aws:iam::${account}:policy/${policy}`;

// AWS 기본 버전 문서. 없으면(NoSuchEntity) null, 그 밖의 실패는 멈춤(권한·네트워크 오류를 '같음'으로 보지 않음)
function remotePolicy(policy) {
  const got = iam(["iam", "get-policy", "--policy-arn", policyArn(policy)], {
    allowFail: true,
  });
  if (got.status !== 0) {
    if (/NoSuchEntity/.test(got.stderr ?? "")) return null;
    process.stderr.write(got.stderr ?? "");
    fail(
      `${policy} 정책을 읽지 못했어요. IAM 정책을 읽을 수 있는 프로필을 --admin-profile로 지정해 주세요.`,
    );
  }
  const version = JSON.parse(got.stdout).Policy.DefaultVersionId;
  const doc = JSON.parse(
    iam([
      "iam",
      "get-policy-version",
      "--policy-arn",
      policyArn(policy),
      "--version-id",
      version,
    ]).stdout,
  ).PolicyVersion.Document;
  // CLI는 보통 풀어서 주지만, 문자열(URL 인코딩)로 오면 직접 풂
  return {
    version,
    doc: typeof doc === "string" ? JSON.parse(decodeURIComponent(doc)) : doc,
  };
}

const localPolicy = (file) =>
  JSON.parse(readFileSync(path.join(BOOTSTRAP, file), "utf8"));

const BOUNDARY = "BaradunV2-RoleBoundary";
const BOUNDARY_FILE = path.join(BOOTSTRAP, "role-boundary-policy.json");
const boundaryRemote = remotePolicy(BOUNDARY);
if (!boundaryRemote)
  fail(`${BOUNDARY} 정책이 없어요. infra/README 초기 설정을 먼저 해 주세요.`);
const boundaryDiff = policyDiff(
  localPolicy("role-boundary-policy.json"),
  boundaryRemote.doc,
);
const boundaryLine = formatPolicyDiff(
  `${BOUNDARY}(${boundaryRemote.version})`,
  boundaryDiff,
);
const executionChecks = [
  ["BaradunCdkExecution", "cfn-execution-policy.json"],
  ["BaradunCdkExecutionWorkload", "cfn-execution-workload-policy.json"],
].map(([policy, file]) => {
  const remote = remotePolicy(policy);
  if (!remote)
    return { same: false, line: `   ${policy}: AWS에 없음(최초 분할 전)` };
  const diff = policyDiff(localPolicy(file), remote.doc);
  return {
    same: diff.same,
    line: formatPolicyDiff(`${policy}(${remote.version})`, diff),
  };
});
const executionLines = executionChecks.map((c) => c.line);
console.log(boundaryLine);
for (const line of executionLines) console.log(line);

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
step(6, `변경 세트를 만들어요 (${name}, 아직 실행하지 않음)`);
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
// 바뀐 리소스가 없어도 boundary가 다르면 boundary만 반영할 수 있게 이어 감
let hasChangeSet = true;
let rows = [];
if (described.status !== 0) {
  // cdk는 바뀐 것이 없으면 변경 세트를 지우고 끝냄 → 없음(ChangeSetNotFound)만 '바뀐 것 없음'으로 봄
  // 권한·네트워크 등 다른 실패를 '바뀐 것 없음'으로 넘기지 않음
  if (!/ChangeSetNotFound/.test(described.stderr ?? "")) {
    process.stderr.write(described.stderr ?? "");
    fail("변경 세트를 읽지 못했어요. 위 오류를 확인해 주세요.");
  }
  hasChangeSet = false;
} else {
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
    hasChangeSet = false;
  } else {
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
    rows = summarizeChanges(changes);
  }
}

if (hasChangeSet) {
  console.log(`\n바뀌는 리소스 ${rows.length}개:\n${formatTable(rows)}`);
  const maybes = rows.filter((r) => r.maybe && !r.danger);
  if (maybes.length > 0) {
    console.log(
      `\n~ 교체될 수도 있음 ${maybes.length}개(위 ~·*~ 줄): 속성 값이 배포 때 정해져 미리 알 수 없다는 뜻이고 대개 교체되지 않아요. 데이터를 담는 리소스(테이블·버킷·사용자 풀 등)는 따로 !!로 표시해요.`,
    );
  }
  const permissions = rows.filter((r) => r.permission && !r.danger);
  if (permissions.length > 0) {
    console.log(
      `\n** 권한(역할·정책) 리소스가 ${permissions.length}개 바뀌어요(위 ** 줄). 권한이 넓어지는지 확인하세요.`,
    );
  }
  const dangers = rows.filter((r) => r.danger);
  if (dangers.length > 0) {
    console.log(
      `\n\x1b[31m!! 경고: 삭제·교체(데이터 리소스는 교체 가능성 포함)되는 리소스가 ${dangers.length}개 있어요(위 !! 줄). 데이터가 사라질 수 있으니 꼭 확인하세요.\x1b[0m`,
    );
  }
} else {
  console.log("\n바뀌는 스택 리소스가 없어요.");
}

console.log(`\n스택 밖 IAM 정책:\n${boundaryLine}`);
for (const line of executionLines) console.log(line);
if (!boundaryDiff.same) {
  console.log(
    `\n** boundary가 저장소와 달라요. yes를 입력하면 변경 세트보다 먼저 저장소 문서로 반영해요(프로필 ${adminProfile}).`,
  );
}
if (executionChecks.some((c) => !c.same)) {
  console.log(
    "\n실행 정책은 자동으로 반영하지 않아요. 바꾸려면 infra/README '정책 적용과 되돌리기 절차'를 따라 주세요(이번 배포는 지금 정책으로 진행해요).",
  );
}
if (!hasChangeSet && boundaryDiff.same) {
  console.log("\n배포할 내용이 없으니 끝낼게요.");
  process.exit(0);
}

// 7. 실행
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (
  await rl.question(
    "\n실행하려면 yes를 입력하세요(다른 입력은 실행하지 않음): ",
  )
).trim();
rl.close();
if (answer !== "yes") {
  console.log(
    hasChangeSet
      ? `\n실행하지 않았어요. 변경 세트 ${name}는 남아 있어요. 지우려면:\n` +
          `aws cloudformation delete-change-set --region ${REGION} --stack-name ${STACK_NAME} --change-set-name ${name}`
      : "\n실행하지 않았어요.",
  );
  process.exit(0);
}

step(
  7,
  [
    boundaryDiff.same ? "" : "boundary 반영",
    hasChangeSet ? "변경 세트 실행" : "",
  ]
    .filter(Boolean)
    .join(" → ") + "을 해요",
);
let boundaryResult = `저장소와 같음(${boundaryRemote.version})`;
if (!boundaryDiff.same) {
  console.log(`   boundary(${BOUNDARY})를 먼저 반영해요`);
  const versions = JSON.parse(
    iam(["iam", "list-policy-versions", "--policy-arn", policyArn(BOUNDARY)])
      .stdout,
  ).Versions;
  const prune = versionToPrune(versions);
  if (prune) {
    // 되돌릴 기본 버전은 남기고 가장 오래된 비기본 버전만 지움
    iam([
      "iam",
      "delete-policy-version",
      "--policy-arn",
      policyArn(BOUNDARY),
      "--version-id",
      prune,
    ]);
    console.log(`   버전이 5개라 가장 오래된 ${prune}를 지웠어요`);
  }
  const created = JSON.parse(
    iam([
      "iam",
      "create-policy-version",
      "--set-as-default",
      "--policy-arn",
      policyArn(BOUNDARY),
      "--policy-document",
      `file://${BOUNDARY_FILE}`,
    ]).stdout,
  ).PolicyVersion.VersionId;
  // 이슈 댓글에는 계정 번호를 넣지 않음 → 되돌리기 명령의 ARN은 화면에만, 댓글에는 자리표시로
  const rollback = (arn) =>
    `${boundaryRemote.version} → ${created} 반영(되돌리기: aws iam set-default-policy-version --policy-arn ${arn} --version-id ${boundaryRemote.version})`;
  boundaryResult = rollback(`arn:aws:iam::<계정>:policy/${BOUNDARY}`);
  console.log(`   ${rollback(policyArn(BOUNDARY))}`);
  // IAM 변경은 바로 퍼지지 않음 → 변경 세트 실행 전에 잠깐 기다림
  console.log("   IAM 반영을 15초 기다려요");
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}

const startedAt = new Date();
if (hasChangeSet) {
  console.log("   변경 세트를 실행하고 끝날 때까지 기다려요");
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
}
// 로그는 배포가 끝난 뒤부터 셈(스택 갱신 중 예전 버전이 남긴 오류를 새 배포 결과로 보지 않음)
const deployedAt = new Date();

// 8. 바뀐 함수 로그 점검: 배포 뒤 정해진 시간 동안 error·warn·시간 초과·권한 거부를 셈
// 실행이 없거나 로그를 못 읽으면 '확인 못 함'(정상으로 보지 않음)
const functions = rows.filter(
  (r) => r.type === "AWS::Lambda::Function" && r.action !== "Remove",
);
const logChecks = [];
if (watchMinutes > 0 && functions.length > 0) {
  step(
    8,
    `바뀐 함수 ${functions.length}개의 로그를 ${watchMinutes}분 동안 봐요(Ctrl+C로 멈추면 점검·댓글을 하지 않음)`,
  );
  for (let left = watchMinutes; left > 0; left -= 1) {
    process.stdout.write(`   남은 시간 ${left}분\r`);
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
  process.stdout.write("\n");
  for (const fn of functions) {
    const firstLine = (text) => (text ?? "").trim().split("\n")[0] ?? "";
    const resource = aws(
      [
        "cloudformation",
        "describe-stack-resource",
        "--stack-name",
        STACK_NAME,
        "--logical-resource-id",
        fn.logicalId,
      ],
      { allowFail: true },
    );
    if (resource.status !== 0) {
      logChecks.push({
        logicalId: fn.logicalId,
        error: firstLine(resource.stderr),
      });
      continue;
    }
    const functionName = JSON.parse(resource.stdout).StackResourceDetail
      .PhysicalResourceId;
    const config = aws(
      ["lambda", "get-function-configuration", "--function-name", functionName],
      { allowFail: true },
    );
    if (config.status !== 0) {
      logChecks.push({
        logicalId: fn.logicalId,
        error: firstLine(config.stderr),
      });
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
        String(deployedAt.getTime()),
      ],
      { allowFail: true },
    );
    if (logs.status !== 0) {
      logChecks.push({
        logicalId: fn.logicalId,
        error: firstLine(logs.stderr),
      });
      continue;
    }
    const lines = (JSON.parse(logs.stdout).events ?? []).map(
      (e) => e.message ?? "",
    );
    logChecks.push({ logicalId: fn.logicalId, scan: scanLogLines(lines) });
  }
  for (const check of logChecks) console.log(`   ${checkLine(check)}`);
} else {
  step(
    8,
    watchMinutes === 0
      ? "로그 점검을 하지 않아요(--watch 0)"
      : "바뀐 함수가 없어 로그 점검을 하지 않아요",
  );
}

if (issue !== null) {
  const body = deployComment({
    subject,
    changeSet: hasChangeSet ? name : "없음(boundary만 반영)",
    rows,
    boundary: boundaryResult,
    executionPolicies: executionLines,
    watchMinutes,
    checks: logChecks,
  });
  const posted = run(
    "gh",
    ["issue", "comment", String(issue), "--repo", repo, "--body-file", "-"],
    { capture: true, input: body, allowFail: true },
  );
  if (posted.status === 0)
    console.log(`\n이슈 #${issue}에 결과 댓글을 남겼어요.`);
  else {
    process.stderr.write(posted.stderr ?? "");
    console.error(
      `\n이슈 #${issue} 댓글을 남기지 못했어요. 아래 내용을 직접 붙여 주세요:\n\n${body}`,
    );
  }
}
