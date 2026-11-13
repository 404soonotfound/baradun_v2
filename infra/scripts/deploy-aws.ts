// 인프라 배포 명령(deploy.mjs 로컬 · deploy-ci.mjs CI)이 함께 쓰는 AWS 조회 (#418)
// aws 명령 실행기를 인자로 받음 → 두 스크립트가 같은 판정을 쓰고, 테스트는 가짜 실행기를 넘김
// 실패는 '없음'·'같음'·'정상'으로 바꾸지 않고 종류를 나눠 돌려줌(멈출지는 부르는 쪽이 정함)
import {
  failedEventsSince,
  formatPolicyDiff,
  isStackReady,
  missingExecutionActions,
  policyDiff,
  scanLogLines,
  type Change,
  type ChangeSetSummary,
  type FunctionCheck,
  type PolicyDiff,
  type PolicyDocument,
  type StackEvent,
} from "./deploy-plan";

export interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// aws 하위 명령 인자만 받음(--region·--output·--profile은 실행기가 붙임). 실패해도 결과를 돌려줌
export type AwsRunner = (args: readonly string[]) => RunResult;

const firstLine = (text: string | undefined) =>
  (text ?? "").trim().split("\n")[0] ?? "";

// ── 스택 밖 IAM 정책 ──

export type RemotePolicy =
  | {
      readonly kind: "ok";
      readonly version: string;
      readonly doc: Record<string, unknown>;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly stderr: string };

// AWS 기본 버전 문서. 없으면(NoSuchEntity) missing, 그 밖의 실패는 error(권한·네트워크 오류를 '없음'으로 보지 않음)
export function readRemotePolicy(aws: AwsRunner, arn: string): RemotePolicy {
  const got = aws(["iam", "get-policy", "--policy-arn", arn]);
  if (got.status !== 0) {
    return /NoSuchEntity/.test(got.stderr)
      ? { kind: "missing" }
      : { kind: "error", stderr: got.stderr };
  }
  const version = JSON.parse(got.stdout).Policy.DefaultVersionId as string;
  const doc = aws([
    "iam",
    "get-policy-version",
    "--policy-arn",
    arn,
    "--version-id",
    version,
  ]);
  if (doc.status !== 0) return { kind: "error", stderr: doc.stderr };
  const raw = JSON.parse(doc.stdout).PolicyVersion.Document;
  // CLI는 보통 풀어서 주지만, 문자열(URL 인코딩)로 오면 직접 풂
  return {
    kind: "ok",
    version,
    doc: typeof raw === "string" ? JSON.parse(decodeURIComponent(raw)) : raw,
  };
}

// 스택 밖 정책(boundary·실행 정책)과 저장소 파일(infra/bootstrap). 로컬·CI가 같은 목록으로 비교함
export const BOUNDARY_POLICY = {
  name: "BaradunV2-RoleBoundary",
  file: "role-boundary-policy.json",
} as const;
export const EXECUTION_POLICIES = [
  { name: "BaradunCdkExecution", file: "cfn-execution-policy.json" },
  {
    name: "BaradunCdkExecutionWorkload",
    file: "cfn-execution-workload-policy.json",
  },
] as const;

export interface PolicyComparison {
  readonly name: string;
  readonly file: string;
  readonly remote: RemotePolicy;
  readonly diff: PolicyDiff | null; // 읽지 못했거나 없으면 null
  readonly line: string; // 화면·댓글 한 줄
}

export interface OutOfStackPolicies {
  readonly boundary: PolicyComparison;
  readonly executions: readonly PolicyComparison[];
  // 실행 정책이 허용하지 않는 저장소 문서의 동작. 실행 정책을 하나라도 못 읽으면 null(판단 못 함)
  readonly executionGaps: readonly string[] | null;
}

// 스택 밖 정책을 AWS 기본 버전과 저장소 파일로 비교. 멈출지('없음'·'조회 실패')는 부르는 쪽이 정함
export function compareOutOfStackPolicies(
  aws: AwsRunner,
  account: string,
  readLocal: (file: string) => PolicyDocument,
): OutOfStackPolicies {
  const compare = (
    policy: { readonly name: string; readonly file: string },
    missingText: string,
  ): PolicyComparison & { readonly local: PolicyDocument } => {
    const local = readLocal(policy.file);
    const remote = readRemotePolicy(
      aws,
      `arn:aws:iam::${account}:policy/${policy.name}`,
    );
    if (remote.kind !== "ok") {
      return {
        ...policy,
        local,
        remote,
        diff: null,
        line:
          remote.kind === "missing"
            ? `   ${policy.name}: ${missingText}`
            : `   ${policy.name}: 확인 못 함(정책을 읽지 못함)`,
      };
    }
    const diff = policyDiff(local, remote.doc as PolicyDocument);
    return {
      ...policy,
      local,
      remote,
      diff,
      line: formatPolicyDiff(`${policy.name}(${remote.version})`, diff),
    };
  };
  const boundary = compare(BOUNDARY_POLICY, "AWS에 없음");
  const executions = EXECUTION_POLICIES.map((p) =>
    compare(p, "AWS에 없음(최초 분할 전)"),
  );
  const remoteDocs = executions.flatMap((e) =>
    e.remote.kind === "ok" ? [e.remote.doc as PolicyDocument] : [],
  );
  return {
    boundary,
    executions,
    executionGaps: executions.every((e) => e.remote.kind === "ok")
      ? missingExecutionActions(
          executions.map((e) => e.local),
          remoteDocs,
        )
      : null,
  };
}

// ── 변경 세트 ──

export type ChangeSetRead =
  | {
      readonly kind: "ok";
      readonly changeSet: ChangeSetSummary & {
        readonly ExecutionStatus?: string;
      };
      readonly changes: readonly Change[];
    }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly stderr: string };

// 변경 세트 전체(다음 쪽까지). 없으면(ChangeSetNotFound, cdk가 바뀐 것이 없어 지운 경우) missing
export function readChangeSetPages(
  aws: AwsRunner,
  stack: string,
  name: string,
): ChangeSetRead {
  const base = [
    "cloudformation",
    "describe-change-set",
    "--stack-name",
    stack,
    "--change-set-name",
    name,
  ];
  const first = aws(base);
  if (first.status !== 0) {
    return /ChangeSetNotFound/.test(first.stderr)
      ? { kind: "missing" }
      : { kind: "error", stderr: first.stderr };
  }
  const changeSet = JSON.parse(first.stdout);
  const changes: Change[] = [...(changeSet.Changes ?? [])];
  let token: string | undefined = changeSet.NextToken;
  while (token) {
    const next = aws([...base, "--next-token", token]);
    // 중간 쪽을 못 읽으면 일부 행만으로 판정하지 않음
    if (next.status !== 0) return { kind: "error", stderr: next.stderr };
    const page = JSON.parse(next.stdout);
    changes.push(...(page.Changes ?? []));
    token = page.NextToken;
  }
  return { kind: "ok", changeSet, changes };
}

// ── 스택 상태 ──

export function stackStatus(
  aws: AwsRunner,
  stack: string,
): RunResult & {
  readonly value?: string;
} {
  const got = aws(["cloudformation", "describe-stacks", "--stack-name", stack]);
  if (got.status !== 0) return got;
  return { ...got, value: JSON.parse(got.stdout).Stacks[0].StackStatus };
}

// 다른 배포(승인 실행 등)를 기다리는 상한. CI 역할 키(2시간)·작업 제한 안에서 자기 배포 대기(최대 60분)를 남김
export const IN_PROGRESS_MAX_WAIT_MS = 30 * 60_000;
export const IN_PROGRESS_POLL_MS = 30_000;

// 동기 대기(spawnSync로 도는 스크립트라 이벤트 루프 없이 멈춤)
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 다른 배포가 진행 중(*_IN_PROGRESS, 가져오기·롤백 포함)이면 끝날 때까지 상태를 30초마다 다시 읽음(CI 전용)
// 진행 중이 아니면 바로 돌려줌. 읽지 못하면 null. 상한을 넘겨도 진행 중이면 그 상태를 돌려줌(부르는 쪽이 멈춤)
// waiter(stack-update-complete)는 업데이트 외 상태에서 끝나지 않고 60분을 다 써서 쓰지 않음
export function waitWhileInProgress(
  aws: AwsRunner,
  stack: string,
  options: {
    readonly maxWaitMs?: number;
    readonly pollMs?: number;
    readonly sleep?: (ms: number) => void;
  } = {},
): string | null {
  const maxWaitMs = options.maxWaitMs ?? IN_PROGRESS_MAX_WAIT_MS;
  const pollMs = options.pollMs ?? IN_PROGRESS_POLL_MS;
  const sleep = options.sleep ?? sleepSync;
  let waited = 0;
  for (;;) {
    const now = stackStatus(aws, stack);
    if (now.value === undefined) return null;
    if (!now.value.endsWith("_IN_PROGRESS") || waited >= maxWaitMs)
      return now.value;
    sleep(pollMs);
    waited += pollMs;
  }
}

export const isReady = (status: string | null): boolean =>
  status !== null && isStackReady(status);

// ── 실패 이벤트 ──

// 이번 실행 뒤의 실패 이벤트. 읽지 못하면(자격 증명 만료 등) null('실패 없음'과 나눔)
export function failedEventsOrNull(
  aws: AwsRunner,
  stack: string,
  since: Date,
): StackEvent[] | null {
  const got = aws([
    "cloudformation",
    "describe-stack-events",
    "--stack-name",
    stack,
    "--max-items",
    "30",
  ]);
  if (got.status !== 0) return null;
  return failedEventsSince(JSON.parse(got.stdout).StackEvents, since);
}

// ── 배포 뒤 로그 점검 ──

// 함수마다 배포 뒤 로그를 읽어 실행·error·warn을 셈. 읽지 못하면 그 함수는 error(정상으로 보지 않음)
export function checkFunctionLogs(
  aws: AwsRunner,
  stack: string,
  logicalIds: readonly string[],
  sinceMs: number,
  maxEvents: number,
): FunctionCheck[] {
  return logicalIds.map((logicalId) => {
    const resource = aws([
      "cloudformation",
      "describe-stack-resource",
      "--stack-name",
      stack,
      "--logical-resource-id",
      logicalId,
    ]);
    if (resource.status !== 0)
      return { logicalId, error: firstLine(resource.stderr) };
    const functionName = JSON.parse(resource.stdout).StackResourceDetail
      .PhysicalResourceId as string;
    const config = aws([
      "lambda",
      "get-function-configuration",
      "--function-name",
      functionName,
    ]);
    if (config.status !== 0)
      return { logicalId, error: firstLine(config.stderr) };
    const logGroup =
      (JSON.parse(config.stdout).LoggingConfig?.LogGroup as
        string | undefined) ?? `/aws/lambda/${functionName}`;
    const logs = aws([
      "logs",
      "filter-log-events",
      "--log-group-name",
      logGroup,
      "--start-time",
      String(sinceMs),
      // 오류를 반복해 로그가 아주 많아도 멈추지 않게 앞부분만 셈
      "--max-items",
      String(maxEvents),
    ]);
    if (logs.status !== 0) return { logicalId, error: firstLine(logs.stderr) };
    const parsed = JSON.parse(logs.stdout);
    return {
      logicalId,
      scan: scanLogLines(
        (parsed.events ?? []).map((e: { message?: string }) => e.message ?? ""),
      ),
      truncated: Boolean(parsed.NextToken),
    };
  });
}
