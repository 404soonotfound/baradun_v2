// 인프라 배포 명령(deploy.mjs)의 판정 부분 (BRD-169). AWS·git을 부르지 않는 순수 함수만 둠(테스트 대상)

export const STACK_NAME = "BaradunV2";
export const REGION = "ap-northeast-2";

// 변경 세트 이름: deploy-{커밋 7자}-{UTC 시각}. CloudFormation 규칙(영문으로 시작, 영문·숫자·-, 128자 이하)
export function changeSetName(sha: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replace(/[-:]/g, "")
    .replace("T", "-");
  return `deploy-${sha.slice(0, 7)}-${stamp}`;
}

export interface CheckRun {
  readonly name?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly completed_at?: string | null;
  readonly app?: { readonly slug?: string } | null;
}

export type CiState = "success" | "pending" | "failure" | "missing";

// 그 커밋의 ci-ok 결과. GitHub Actions가 남긴 것 중 가장 늦게 끝난 실행을 봄(deploy.yml 수동 실행과 같은 기준)
// 아직 도는 실행(완료 전)이 있으면 그 결과를 기다림
export function ciConclusion(
  checkRuns: readonly CheckRun[] | undefined,
): CiState {
  const runs = (checkRuns ?? []).filter(
    (r) => r.name === "ci-ok" && r.app?.slug === "github-actions",
  );
  if (runs.length === 0) return "missing";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  const last = [...runs].sort((a, b) =>
    String(a.completed_at ?? "").localeCompare(String(b.completed_at ?? "")),
  )[runs.length - 1]!;
  return last.conclusion === "success" ? "success" : "failure";
}

// ci-ok 확인은 다른 검사가 모두 끝나야 생김 → 결과가 없어도 그 커밋의 ci 워크플로가 도는 중이면 '도는 중'으로 봄
export function ciStateWithRuns(
  state: CiState,
  workflowRunStatuses: readonly string[],
): CiState {
  if (state !== "missing") return state;
  return workflowRunStatuses.some((s) => s !== "completed") ? "pending" : state;
}

// 새 변경을 받을 수 있는 스택 상태(진행 중·실패 상태에서는 배포하지 않음)
// UPDATE_ROLLBACK_COMPLETE는 앞 배포가 되돌려진 뒤 안정된 상태라 다시 배포할 수 있음
const READY = new Set([
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
  "IMPORT_COMPLETE",
]);

export function isStackReady(status: string): boolean {
  return READY.has(status);
}

export interface ChangeSetSummary {
  readonly Status?: string;
  readonly StatusReason?: string;
}

// 바뀐 것이 없어 만들지 못한 변경 세트인지(cdk가 지우지 않고 남긴 경우)
export function isEmptyChangeSet(changeSet: ChangeSetSummary): boolean {
  return (
    changeSet.Status === "FAILED" &&
    /didn't contain changes|No updates are to be performed/i.test(
      changeSet.StatusReason ?? "",
    )
  );
}

export interface Change {
  readonly ResourceChange?: {
    readonly Action?: string;
    readonly LogicalResourceId?: string;
    readonly ResourceType?: string;
    readonly Replacement?: string;
  };
}

export interface ChangeRow {
  readonly action: string;
  readonly logicalId: string;
  readonly type: string;
  readonly replacement: string;
  // 삭제·교체: 데이터가 사라질 수 있음. 데이터를 담는 리소스는 교체 가능성(Conditional)도 여기에 넣음
  readonly danger: boolean;
  // 교체될 수도 있음(Conditional): 속성 값이 배포 때 정해져 CloudFormation이 미리 모름. 대개 교체되지 않음
  readonly maybe: boolean;
  // 권한을 정하는 리소스(역할·정책·리소스 정책). 넓어졌는지 사람이 따로 봐야 함
  readonly permission: boolean;
}

// cdk의 IAM 변경 표(--require-approval)를 쓰지 않으므로 권한 리소스를 따로 표시함
const PERMISSION_TYPES = new Set([
  "AWS::Lambda::Permission",
  "AWS::S3::BucketPolicy",
  "AWS::SNS::TopicPolicy",
  "AWS::SQS::QueuePolicy",
  "AWS::KMS::Key",
]);

// 교체되면 담긴 데이터가 사라지는 리소스. 이 종류는 교체 가능성만 있어도 위험으로 봄
const STATEFUL_TYPES = new Set([
  "AWS::DynamoDB::Table",
  "AWS::S3::Bucket",
  "AWS::Cognito::UserPool",
  "AWS::Logs::LogGroup",
  "AWS::SQS::Queue",
  "AWS::KMS::Key",
]);

// 배포마다 바뀌는 cdk 정보 리소스. 표에는 두지만 경고하지 않음
const CDK_METADATA = "AWS::CDK::Metadata";

function isPermissionType(type: string): boolean {
  return type.startsWith("AWS::IAM::") || PERMISSION_TYPES.has(type);
}

export function summarizeChanges(
  changes: readonly Change[] | undefined,
): ChangeRow[] {
  return (changes ?? []).map(({ ResourceChange: r = {} }) => {
    const replacement = r.Replacement ?? "-";
    const type = r.ResourceType ?? "?";
    return {
      action: r.Action ?? "?",
      logicalId: r.LogicalResourceId ?? "?",
      type,
      replacement,
      danger:
        r.Action === "Remove" ||
        replacement === "True" ||
        (replacement === "Conditional" && STATEFUL_TYPES.has(type)),
      maybe:
        replacement === "Conditional" &&
        !STATEFUL_TYPES.has(type) &&
        type !== CDK_METADATA,
      permission: isPermissionType(type),
    };
  });
}

const COLUMNS = ["action", "logicalId", "type", "replacement"] as const;
const HEADER = {
  action: "동작",
  logicalId: "논리 ID",
  type: "종류",
  replacement: "교체",
  danger: false,
  maybe: false,
  permission: false,
};

// 맨 앞 표시(색이 안 보이는 터미널에서도 구분되게): !! 삭제·교체, ** 권한, ~ 교체될 수도 있음, *~ 둘 다
function mark(
  r: Omit<ChangeRow, "action" | "logicalId" | "type" | "replacement">,
): string {
  if (r.danger) return "!!";
  if (r.permission) return r.maybe ? "*~" : "**";
  return r.maybe ? "~ " : "  ";
}

export function formatTable(rows: readonly ChangeRow[]): string {
  const all = [HEADER, ...rows];
  const width = (k: (typeof COLUMNS)[number]) =>
    Math.max(...all.map((r) => r[k].length));
  return all
    .map((r) =>
      `${mark(r)} ${COLUMNS.map((k) => r[k].padEnd(width(k))).join("  ")}`.trimEnd(),
    )
    .join("\n");
}

export interface StackEvent {
  readonly Timestamp?: string;
  readonly LogicalResourceId?: string;
  readonly ResourceStatus?: string;
  readonly ResourceStatusReason?: string;
}

// 이번 실행(since 이후)에 생긴 실패 이벤트만. 예전 배포의 실패를 원인으로 보여 주지 않음
export function failedEventsSince(
  events: readonly StackEvent[] | undefined,
  since: Date,
): StackEvent[] {
  return (events ?? []).filter(
    (e) =>
      /FAILED/.test(e.ResourceStatus ?? "") &&
      Date.parse(e.Timestamp ?? "") >= since.getTime(),
  );
}
