import { describe, expect, it } from "vitest";
import {
  changeSetName,
  ciConclusion,
  failedEventsSince,
  formatTable,
  isEmptyChangeSet,
  isStackReady,
  summarizeChanges,
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
  ];

  it("삭제와 교체(가능성 포함)만 위험으로 표시한다", () => {
    expect(
      summarizeChanges(changes).map((r) => [r.logicalId, r.danger]),
    ).toEqual([
      ["OpsApiFunction484C2E8D", false],
      ["StorageOpsTable", true],
      ["OldGroup", true],
      ["NewRole", false],
    ]);
  });

  it("위험한 줄 앞에 !!를 붙이고 칸을 맞춘다", () => {
    const lines = formatTable(summarizeChanges(changes)).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^ {3}동작/);
    expect(lines.filter((l) => l.startsWith("!!"))).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith("**"))).toHaveLength(1);
    expect(lines[3]).toMatch(
      /^!! Remove +OldGroup +AWS::Cognito::UserPoolGroup +-$/,
    );
  });
});

describe("권한 변경", () => {
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
