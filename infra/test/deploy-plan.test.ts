import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  changeSetName,
  checkLine,
  ciConclusion,
  ciStateWithRuns,
  deployComment,
  failedEventsSince,
  formatPolicyDiff,
  formatTable,
  isCalendarDate,
  isEmptyChangeSet,
  isStackReady,
  policyDiff,
  scanLogLines,
  summarizeChanges,
  versionToPrune,
  type CheckRun,
} from "../scripts/deploy-plan";

// 인프라 배포 명령의 판정 (BRD-169)

describe("변경 세트 이름", () => {
  it("커밋 7자와 UTC 시각으로 CloudFormation 규칙에 맞게 만든다", () => {
    const name = changeSetName(
      "e3ac36ea0009e2e2bd4c3694892cfcb596a08703",
      new Date("2026-11-03T08:45:07.123Z"),
    );
    expect(name).toBe("deploy-e3ac36e-20261103-084507");
    expect(name).toMatch(/^[a-zA-Z][-a-zA-Z0-9]{0,127}$/);
  });
});

describe("ci-ok 확인", () => {
  const run = (overrides: Partial<CheckRun>): CheckRun => ({
    name: "ci-ok",
    status: "completed",
    conclusion: "success",
    completed_at: "2026-11-03T08:00:00Z",
    app: { slug: "github-actions" },
    ...overrides,
  });

  it("GitHub Actions의 ci-ok 중 가장 늦게 끝난 결과를 본다", () => {
    expect(
      ciConclusion([
        run({ conclusion: "failure", completed_at: "2026-11-03T07:00:00Z" }),
        run({}),
      ]),
    ).toBe("success");
    expect(
      ciConclusion([
        run({}),
        run({ conclusion: "failure", completed_at: "2026-11-03T09:00:00Z" }),
      ]),
    ).toBe("failure");
  });

  it("아직 도는 실행이 있으면 기다린다", () => {
    expect(
      ciConclusion([
        run({}),
        run({ status: "in_progress", completed_at: null }),
      ]),
    ).toBe("pending");
  });

  it("결과가 없거나 다른 앱이 같은 이름을 쓰면 통과로 보지 않는다", () => {
    expect(ciConclusion([])).toBe("missing");
    expect(ciConclusion(undefined)).toBe("missing");
    expect(ciConclusion([run({ app: { slug: "someone-else" } })])).toBe(
      "missing",
    );
    expect(ciConclusion([run({ conclusion: "cancelled" })])).toBe("failure");
    expect(ciConclusion([run({ conclusion: "skipped" })])).toBe("failure");
  });
});

describe("ci-ok가 아직 없을 때", () => {
  it("그 커밋의 CI가 도는 중이면 '도는 중'으로 본다", () => {
    expect(ciStateWithRuns("missing", ["in_progress"])).toBe("pending");
    expect(ciStateWithRuns("missing", ["queued"])).toBe("pending");
  });

  it("CI 기록이 없거나 다 끝났는데 ci-ok가 없으면 '없음'", () => {
    expect(ciStateWithRuns("missing", [])).toBe("missing");
    expect(ciStateWithRuns("missing", ["completed"])).toBe("missing");
  });

  it("ci-ok 결과가 있으면 그대로 쓴다", () => {
    expect(ciStateWithRuns("failure", ["in_progress"])).toBe("failure");
    expect(ciStateWithRuns("success", [])).toBe("success");
  });
});

describe("스택 상태", () => {
  it.each([
    ["UPDATE_COMPLETE", true],
    ["UPDATE_ROLLBACK_COMPLETE", true],
    ["UPDATE_IN_PROGRESS", false],
    ["UPDATE_ROLLBACK_FAILED", false],
    ["ROLLBACK_COMPLETE", false],
  ])("%s → 배포 %s", (status, ready) => {
    expect(isStackReady(status)).toBe(ready);
  });
});

describe("빈 변경 세트", () => {
  it("바뀐 것이 없다는 실패만 빈 변경 세트로 본다", () => {
    expect(
      isEmptyChangeSet({
        Status: "FAILED",
        StatusReason:
          "The submitted information didn't contain changes. Submit different information to create a change set.",
      }),
    ).toBe(true);
    expect(
      isEmptyChangeSet({ Status: "FAILED", StatusReason: "Access denied" }),
    ).toBe(false);
    expect(isEmptyChangeSet({ Status: "CREATE_COMPLETE" })).toBe(false);
  });
});

describe("변경 표", () => {
  const changes = [
    {
      ResourceChange: {
        Action: "Modify",
        LogicalResourceId: "OpsApiFunction484C2E8D",
        ResourceType: "AWS::Lambda::Function",
        Replacement: "False",
      },
    },
    {
      ResourceChange: {
        Action: "Modify",
        LogicalResourceId: "StorageOpsTable",
        ResourceType: "AWS::DynamoDB::Table",
        Replacement: "Conditional",
      },
    },
    {
      ResourceChange: {
        Action: "Remove",
        LogicalResourceId: "OldGroup",
        ResourceType: "AWS::Cognito::UserPoolGroup",
      },
    },
    {
      ResourceChange: {
        Action: "Add",
        LogicalResourceId: "NewRole",
        ResourceType: "AWS::IAM::Role",
      },
    },
    // 2026-11-03 BRD-155 배포에서 실제로 나온 '교체될 수도 있음' 두 줄(교체되지 않았음)
    {
      ResourceChange: {
        Action: "Modify",
        LogicalResourceId: "OpsApiFunctionFunctionUrl79ADB6FB",
        ResourceType: "AWS::Lambda::Url",
        Replacement: "Conditional",
      },
    },
    {
      ResourceChange: {
        Action: "Modify",
        LogicalResourceId: "CDKMetadata",
        ResourceType: "AWS::CDK::Metadata",
        Replacement: "Conditional",
      },
    },
  ];

  it("삭제·교체와 데이터 리소스의 교체 가능성만 위험, 나머지 교체 가능성은 약하게, cdk 정보는 표시 안 함", () => {
    expect(
      summarizeChanges(changes).map((r) => [r.logicalId, r.danger, r.maybe]),
    ).toEqual([
      ["OpsApiFunction484C2E8D", false, false],
      ["StorageOpsTable", true, false],
      ["OldGroup", true, false],
      ["NewRole", false, false],
      ["OpsApiFunctionFunctionUrl79ADB6FB", false, true],
      ["CDKMetadata", false, false],
    ]);
  });

  it("교체(True)는 종류와 상관없이 위험이다", () => {
    expect(
      summarizeChanges([
        {
          ResourceChange: {
            Action: "Modify",
            ResourceType: "AWS::Lambda::Url",
            Replacement: "True",
          },
        },
      ])[0]!.danger,
    ).toBe(true);
  });

  it("줄 앞에 !!·**·~ 표시를 붙이고 칸을 맞춘다", () => {
    const lines = formatTable(summarizeChanges(changes)).split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[0]).toMatch(/^ {3}동작/);
    expect(lines.filter((l) => l.startsWith("!!"))).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("**"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("~ "))).toHaveLength(1);
    expect(lines[6]).toMatch(/^ {3}Modify +CDKMetadata/);
    expect(lines[3]).toMatch(
      /^!! Remove +OldGroup +AWS::Cognito::UserPoolGroup +-$/,
    );
  });
});

describe("권한 변경", () => {
  it("교체될 수도 있는 권한 리소스는 *~로 둘 다 보여 준다", () => {
    const rows = summarizeChanges([
      {
        ResourceChange: {
          Action: "Modify",
          LogicalResourceId: "SomeRole",
          ResourceType: "AWS::IAM::Role",
          Replacement: "Conditional",
        },
      },
    ]);
    expect(rows[0]).toMatchObject({
      permission: true,
      maybe: true,
      danger: false,
    });
    expect(formatTable(rows).split("\n")[1]).toMatch(/^\*~ Modify +SomeRole/);
  });

  it("IAM·리소스 정책 리소스를 권한 변경으로 표시한다", () => {
    expect(
      summarizeChanges(
        [
          "AWS::IAM::Policy",
          "AWS::IAM::Role",
          "AWS::S3::BucketPolicy",
          "AWS::Lambda::Function",
        ].map((ResourceType) => ({
          ResourceChange: {
            Action: "Modify",
            ResourceType,
            Replacement: "False",
          },
        })),
      ).map((r) => r.permission),
    ).toEqual([true, true, true, false]);
  });
});

describe("실패 이벤트", () => {
  it("이번 실행 뒤에 생긴 실패만 보여 준다", () => {
    const since = new Date("2026-11-03T09:00:00Z");
    expect(
      failedEventsSince(
        [
          {
            Timestamp: "2026-11-03T09:01:00Z",
            LogicalResourceId: "A",
            ResourceStatus: "UPDATE_FAILED",
          },
          {
            Timestamp: "2026-11-03T09:02:00Z",
            LogicalResourceId: "B",
            ResourceStatus: "UPDATE_COMPLETE",
          },
          {
            Timestamp: "2026-10-27T03:00:00Z",
            LogicalResourceId: "C",
            ResourceStatus: "CREATE_FAILED",
          },
        ],
        since,
      ).map((e) => e.LogicalResourceId),
    ).toEqual(["A"]);
  });
});

describe("스택 밖 IAM 정책 비교 (GH-382)", () => {
  const doc = (statements: Record<string, unknown>[]) => ({
    Version: "2012-10-17",
    Statement: statements,
  });
  const a = {
    Sid: "A",
    Effect: "Allow",
    Action: "s3:GetObject",
    Resource: "*",
  };
  const b = { Sid: "B", Effect: "Deny", Action: "iam:*", Resource: "*" };

  it("키 순서만 다르면 같음", () => {
    const shuffled = {
      Resource: "*",
      Action: "s3:GetObject",
      Effect: "Allow",
      Sid: "A",
    };
    const diff = policyDiff(doc([a, b]), doc([shuffled, b]));
    expect(diff).toEqual({ same: true, added: [], removed: [], changed: [] });
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      '{"a":[2,{"c":4,"d":3}],"b":1}',
    );
  });

  it("추가·삭제·바뀐 문장을 Sid로 나눔(Sid가 없으면 순번)", () => {
    const changed = { ...a, Resource: "arn:aws:s3:::x/*" };
    const diff = policyDiff(
      doc([changed, { Effect: "Allow", Action: "logs:*", Resource: "*" }]),
      doc([a, b]),
    );
    expect(diff.same).toBe(false);
    expect(diff.added).toEqual(["#2"]);
    expect(diff.removed).toEqual(["B"]);
    expect(diff.changed).toEqual(["A"]);
    expect(formatPolicyDiff("P(v3)", diff)).toBe(
      "   P(v3): 저장소와 다름 · 추가 #2 · 삭제 B · 바뀜 A",
    );
  });

  it("문장은 같고 머리만 달라도 다름으로 보여 줌", () => {
    const diff = policyDiff(
      { Version: "2012-10-17", Statement: [a] },
      { Statement: [a] },
    );
    expect(diff.same).toBe(false);
    expect(formatPolicyDiff("P", diff)).toContain("문서 머리");
  });

  it("버전이 5개면 기본이 아닌 가장 오래된 버전만 지움", () => {
    const v = (id: string, day: number, def = false) => ({
      VersionId: id,
      IsDefaultVersion: def,
      CreateDate: `2026-11-0${day}T00:00:00Z`,
    });
    expect(versionToPrune([v("v1", 1), v("v2", 2, true)])).toBeNull();
    expect(
      versionToPrune([
        v("v1", 1, true),
        v("v2", 2),
        v("v3", 3),
        v("v4", 4),
        v("v5", 5),
      ]),
    ).toBe("v2");
  });
});

describe("배포 뒤 로그 점검 (GH-382)", () => {
  const lines = [
    "START RequestId: 1 Version: $LATEST",
    '2026-11-10T07:50:00Z\t1\tINFO\t{"level":"info","event":"run_done"}',
    '2026-11-10T07:50:01Z\t1\tINFO\t{"level":"warn","event":"ops_sources_key_read_timeout"}',
    '{"level":"error","event":"ops_sources_key_read_failed","name":"data-go-kr"}',
    '{"level":"error","event":"ops_sources_key_read_failed"}',
    "END RequestId: 1",
    "START RequestId: 2 Version: $LATEST",
    "2026-11-10T07:51:00Z 2 Task timed out after 30.03 seconds",
    "AccessDeniedException: User is not authorized to perform: ssm:ListTagsForResource",
  ];

  it("실행 수와 error 먼저·많은 순으로 이벤트를 셈", () => {
    const scan = scanLogLines(lines);
    expect(scan.invocations).toBe(2);
    expect(scan.findings).toEqual([
      { level: "error", event: "ops_sources_key_read_failed", count: 2 },
      { level: "error", event: "lambda_timeout", count: 1 },
      { level: "error", event: "access_denied", count: 1 },
      { level: "warn", event: "ops_sources_key_read_timeout", count: 1 },
    ]);
  });

  it("실행이 없거나 로그를 못 읽으면 '확인 못 함'(정상으로 보지 않음)", () => {
    expect(checkLine({ logicalId: "F", scan: scanLogLines([]) })).toBe(
      "F: 확인 못 함(보는 동안 실행 없음)",
    );
    expect(
      checkLine({ logicalId: "F", error: "ResourceNotFoundException" }),
    ).toBe("F: 확인 못 함(로그를 읽지 못함: ResourceNotFoundException)");
    expect(
      checkLine({ logicalId: "F", scan: scanLogLines(["START RequestId: 1"]) }),
    ).toBe("F: 실행 1회 · error·warn 없음");
    // START 줄 없이 오류만 있어도(초기화 실패 등) 오류를 숨기지 않음
    expect(
      checkLine({
        logicalId: "F",
        scan: scanLogLines(["2026-11-10T07:51:00Z 2 Task timed out"]),
      }),
    ).toBe("F: 확인 못 함(보는 동안 실행 없음) · error lambda_timeout 1회");
  });

  it("바뀐 함수가 없으면 --watch 0이 아니라 '바뀐 함수 없음'으로 적음", () => {
    const base = {
      subject: "abc1234 x",
      changeSet: "없음(boundary만 반영)",
      rows: [],
      boundary: "v5 → v6 반영",
      executionPolicies: [],
      checks: [],
    };
    expect(deployComment({ ...base, watchMinutes: 16 })).toContain(
      "### 배포 뒤 로그 점검: 하지 않음(바뀐 함수 없음)",
    );
    expect(deployComment({ ...base, watchMinutes: 0 })).toContain(
      "### 배포 뒤 로그 점검: 하지 않음(--watch 0)",
    );
  });

  it("이슈 댓글에 커밋·변경 수·boundary·점검 결과를 넣고 계정 번호는 넣지 않음", () => {
    const rows = summarizeChanges([
      {
        ResourceChange: {
          Action: "Modify",
          LogicalResourceId: "OpsApiRole",
          ResourceType: "AWS::IAM::Policy",
          Replacement: "False",
        },
      },
      {
        ResourceChange: {
          Action: "Modify",
          LogicalResourceId: "OpsApiFunction",
          ResourceType: "AWS::Lambda::Function",
          Replacement: "False",
        },
      },
    ]);
    const body = deployComment({
      subject: "abc1234 GH-382 feat(infra): 배포 점검",
      changeSet: "deploy-abc1234-20261110-080000",
      rows,
      boundary: "저장소와 같음(v5)",
      executionPolicies: [
        "   BaradunCdkExecution(v7): 저장소와 다름 · 바뀜 SiteBucket",
      ],
      watchMinutes: 16,
      checks: [{ logicalId: "OpsApiFunction", scan: scanLogLines(lines) }],
    });
    expect(body).toContain("리소스 2개(권한 1 · 삭제·교체 0)");
    expect(body).toContain("- boundary: 저장소와 같음(v5)");
    expect(body).toContain(
      "- 실행 정책: BaradunCdkExecution(v7): 저장소와 다름",
    );
    expect(body).toContain("### 배포 뒤 16분 로그 점검(바뀐 함수)");
    expect(body).toContain(
      "- OpsApiFunction: 실행 2회 · error ops_sources_key_read_failed 2회",
    );
    expect(body).not.toMatch(/\d{12}/);
  });
});

describe("인증키 만료일 (GH-382)", () => {
  it("달력에 있는 YYYY-MM-DD만", () => {
    expect(isCalendarDate("2027-03-31")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2027-02-29")).toBe(false);
    expect(isCalendarDate("2027-3-31")).toBe(false);
    expect(isCalendarDate("20270331")).toBe(false);
  });
});
