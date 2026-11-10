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

// ── 스택 밖 IAM 정책(boundary·실행 정책) 비교 (GH-382) ──
// 저장소 bootstrap/*.json이 원본. AWS 기본 버전과 문장(Sid) 단위로 비교함

export interface PolicyStatement {
  readonly Sid?: string;
  readonly [key: string]: unknown;
}

export interface PolicyDocument {
  readonly Version?: string;
  readonly Statement?: PolicyStatement | readonly PolicyStatement[];
}

export interface PolicyDiff {
  readonly same: boolean;
  readonly added: string[]; // 저장소에만 있는 문장
  readonly removed: string[]; // AWS에만 있는 문장
  readonly changed: string[]; // 둘 다 있는데 내용이 다른 문장
}

// 키 순서와 상관없이 같은 문서면 같은 문자열(배열 순서는 그대로 봄)
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function statements(doc: PolicyDocument): Map<string, string> {
  const list = doc.Statement
    ? Array.isArray(doc.Statement)
      ? doc.Statement
      : [doc.Statement as PolicyStatement]
    : [];
  return new Map(
    list.map((s, i) => [s.Sid ?? `#${i + 1}`, canonicalJson(s)] as const),
  );
}

export function policyDiff(
  local: PolicyDocument,
  remote: PolicyDocument,
): PolicyDiff {
  const a = statements(local);
  const b = statements(remote);
  return {
    same: canonicalJson(local) === canonicalJson(remote),
    added: [...a.keys()].filter((k) => !b.has(k)),
    removed: [...b.keys()].filter((k) => !a.has(k)),
    changed: [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k)),
  };
}

export function formatPolicyDiff(name: string, diff: PolicyDiff): string {
  if (diff.same) return `   ${name}: 저장소와 같음`;
  const parts = [
    diff.added.length > 0 ? `추가 ${diff.added.join(", ")}` : "",
    diff.removed.length > 0 ? `삭제 ${diff.removed.join(", ")}` : "",
    diff.changed.length > 0 ? `바뀜 ${diff.changed.join(", ")}` : "",
  ].filter(Boolean);
  // 문장은 같은데 문서 머리(Version 등)만 다른 경우도 '다름'으로 보여 줌
  return `   ${name}: 저장소와 다름 · ${parts.length > 0 ? parts.join(" · ") : "문서 머리(Version 등)"}`;
}

export interface PolicyVersion {
  readonly VersionId: string;
  readonly IsDefaultVersion: boolean;
  readonly CreateDate: string;
}

// IAM 관리형 정책은 버전을 5개까지만 둠. 꽉 찼으면 기본 버전이 아닌 가장 오래된 것만 지움(되돌릴 기본 버전은 남김)
export function versionToPrune(
  versions: readonly PolicyVersion[],
): string | null {
  if (versions.length < 5) return null;
  const old = versions
    .filter((v) => !v.IsDefaultVersion)
    .sort((x, y) => Date.parse(x.CreateDate) - Date.parse(y.CreateDate));
  return old[0]?.VersionId ?? null;
}

// ── 배포 뒤 로그 점검 (GH-382) ──
// 서비스 로그는 한 줄 JSON {level, event, ...}(Lambda Text 형식이면 앞에 시각·요청 ID가 붙음)

export interface LogFinding {
  readonly level: "error" | "warn";
  readonly event: string;
  readonly count: number;
}

export interface LogScan {
  readonly invocations: number; // START RequestId 줄 수(실행 횟수)
  readonly findings: LogFinding[];
}

const RAW_MARKERS: readonly [RegExp, string][] = [
  [/Task timed out/, "lambda_timeout"],
  [/AccessDenied|not authorized to perform/, "access_denied"],
  [/"errorType"|Runtime\.\w+Error/, "lambda_uncaught_error"],
];

// 줄 안의 첫 { 부터 JSON으로 읽음. 못 읽으면 null(원문 표시로 봄)
function parseLogJson(
  line: string,
): { level?: unknown; event?: unknown } | null {
  const start = line.indexOf("{");
  if (start < 0) return null;
  try {
    const value: unknown = JSON.parse(line.slice(start));
    return value && typeof value === "object"
      ? (value as { level?: unknown; event?: unknown })
      : null;
  } catch {
    return null;
  }
}

export function scanLogLines(lines: readonly string[]): LogScan {
  const counts = new Map<string, LogFinding>();
  const add = (level: "error" | "warn", event: string) => {
    const key = `${level}|${event}`;
    const prev = counts.get(key);
    counts.set(key, { level, event, count: (prev?.count ?? 0) + 1 });
  };
  let invocations = 0;
  for (const line of lines) {
    if (/^START RequestId/.test(line)) {
      invocations += 1;
      continue;
    }
    const parsed = parseLogJson(line);
    if (parsed && typeof parsed.level === "string") {
      if (parsed.level === "error" || parsed.level === "warn") {
        add(parsed.level, String(parsed.event ?? "event_unknown"));
      }
      continue;
    }
    const marker = RAW_MARKERS.find(([re]) => re.test(line));
    if (marker) add("error", marker[1]);
  }
  const findings = [...counts.values()].sort(
    (a, b) =>
      (a.level === b.level ? 0 : a.level === "error" ? -1 : 1) ||
      b.count - a.count,
  );
  return { invocations, findings };
}

export interface FunctionCheck {
  readonly logicalId: string;
  // 로그를 읽지 못한 이유. 있으면 '확인 못 함'
  readonly error?: string;
  readonly scan?: LogScan;
}

// 한 줄 요약. 실행이 없거나 읽지 못하면 '확인 못 함'(정상으로 보지 않음)
export function checkLine(check: FunctionCheck): string {
  if (check.error || !check.scan) {
    return `${check.logicalId}: 확인 못 함(로그를 읽지 못함${check.error ? `: ${check.error}` : ""})`;
  }
  const { invocations, findings } = check.scan;
  const list = findings
    .map((f) => `${f.level} ${f.event} ${f.count}회`)
    .join(", ");
  // START 줄이 없어도(초기화 실패 등) 잡힌 오류는 숨기지 않음
  if (invocations === 0) {
    return `${check.logicalId}: 확인 못 함(보는 동안 실행 없음)${list ? ` · ${list}` : ""}`;
  }
  if (findings.length === 0) {
    return `${check.logicalId}: 실행 ${invocations}회 · error·warn 없음`;
  }
  return `${check.logicalId}: 실행 ${invocations}회 · ${list}`;
}

export interface DeployReport {
  readonly subject: string; // 배포한 커밋 한 줄
  readonly changeSet: string;
  readonly rows: readonly ChangeRow[];
  readonly boundary: string; // '저장소와 같음' 또는 반영한 버전
  readonly executionPolicies: readonly string[]; // formatPolicyDiff 줄
  readonly watchMinutes: number;
  readonly checks: readonly FunctionCheck[];
}

// 이슈 댓글(마크다운). 비밀값·계정 번호를 넣지 않음
export function deployComment(report: DeployReport): string {
  const permission = report.rows.filter((r) => r.permission).length;
  const danger = report.rows.filter((r) => r.danger).length;
  const lines = [
    "## 인프라 배포 결과 (`npm run deploy:infra`)",
    "",
    `- 커밋: ${report.subject}`,
    `- 변경 세트: \`${report.changeSet}\` · 리소스 ${report.rows.length}개(권한 ${permission} · 삭제·교체 ${danger})`,
    `- boundary: ${report.boundary}`,
    ...report.executionPolicies.map((l) => `- 실행 정책: ${l.trim()}`),
    "",
    report.watchMinutes === 0
      ? "### 배포 뒤 로그 점검: 하지 않음(--watch 0)"
      : report.checks.length === 0
        ? "### 배포 뒤 로그 점검: 하지 않음(바뀐 함수 없음)"
        : `### 배포 뒤 ${report.watchMinutes}분 로그 점검(바뀐 함수)`,
    ...report.checks.map((c) => `- ${checkLine(c)}`),
  ];
  return `${lines.join("\n")}\n`;
}

// ── 인증키 만료일 태그 (GH-382) ──

// 달력에 있는 YYYY-MM-DD인지(2027-02-30 같은 날은 거부)
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

// 운영 API가 읽는 만료일 태그 이름(services/src/admin/sources.ts KEY_EXPIRES_TAG와 같아야 함)
export const KEY_EXPIRES_TAG = "expires";
