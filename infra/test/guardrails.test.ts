import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  API_KEY_NAMES,
  API_KEY_PARAMETER_PREFIX,
  LOG_RETENTION,
  MAX_ALARMS,
  MAX_DYNAMODB_CAPACITY_UNITS,
  MONTHLY_BUDGET_USD,
  RETRY_LIMITS,
  ROLE_BOUNDARY_POLICY_NAME,
  apiKeyParameterName,
} from "../lib/settings";
import { allIamPolicies, template, toList } from "./stack-template";

// 아키텍처 11장 '과금·보안 가드레일'을 템플릿으로 검사함.
// 지금은 검사 대상이 0개인 항목도 있음. 다음 묶음에서 리소스가 생기면 바로 거름.

describe("KMS", () => {
  it("고객 관리형 KMS 키를 만들지 않는다 (키 하나당 월 요금)", () => {
    template.resourceCountIs("AWS::KMS::Key", 0);
  });

  it("버킷은 S3 관리형 암호화(SSE-S3)를 쓴다", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    });
  });
});

describe("SSM Parameter Store (API 키)", () => {
  it("파라미터를 템플릿으로 만들지 않는다 (값이 저장소에 남지 않게)", () => {
    template.resourceCountIs("AWS::SSM::Parameter", 0);
  });

  it("API 키 이름은 /baradun/v2/api-keys/ 아래 소문자·하이픈이다", () => {
    expect(API_KEY_PARAMETER_PREFIX).toBe("/baradun/v2/api-keys/");
    for (const name of API_KEY_NAMES) {
      expect(apiKeyParameterName(name)).toMatch(
        /^\/baradun\/v2\/api-keys\/[a-z0-9]+(-[a-z0-9]+)*$/,
      );
    }
  });
});

describe("로그 보존", () => {
  it("보존 기간은 3~7일 중 하나다 (10장)", () => {
    expect([3, 5, 7]).toContain(LOG_RETENTION);
  });

  it("모든 로그 그룹이 정한 보존 기간을 쓴다", () => {
    for (const group of Object.values(
      template.findResources("AWS::Logs::LogGroup"),
    )) {
      expect(group.Properties.RetentionInDays).toBe(LOG_RETENTION);
    }
  });
});

describe("이식성 (17.2)", () => {
  it("Lambda@Edge를 쓰지 않는다 (모든 캐시 동작)", () => {
    for (const dist of Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    )) {
      const config = dist.Properties.DistributionConfig;
      const behaviors = [
        config.DefaultCacheBehavior,
        ...(config.CacheBehaviors ?? []),
      ];
      for (const b of behaviors)
        expect(b.LambdaFunctionAssociations).toBeUndefined();
    }
  });
});

describe("예산 (1장)", () => {
  it("월 $1 비용 예산이 하나 있고, 크레딧은 빼고 계산한다", () => {
    template.resourceCountIs("AWS::Budgets::Budget", 1);
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: MONTHLY_BUDGET_USD, Unit: "USD" },
        CostTypes: Match.objectLike({ IncludeCredit: false }),
      }),
    });
  });

  it("알림은 배포 때 넘긴 이메일(AlertEmail)로만 보낸다", () => {
    for (const budget of Object.values(
      template.findResources("AWS::Budgets::Budget"),
    )) {
      const notifications = budget.Properties.NotificationsWithSubscribers;
      expect(notifications.length).toBeGreaterThan(0);
      for (const n of notifications) {
        expect(n.Subscribers).toEqual([
          { SubscriptionType: "EMAIL", Address: { Ref: "AlertEmail" } },
        ]);
      }
    }
  });
});

describe("정액 요금제 web ACL (BRD-51)", () => {
  it("web ACL은 배포 때 넘긴 ARN이 있을 때만 붙는다", () => {
    const params = template.findParameters("SiteWebAclArn");
    expect(params.SiteWebAclArn.Default).toBe("");

    for (const dist of Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    )) {
      expect(dist.Properties.DistributionConfig.WebACLId).toEqual({
        "Fn::If": [
          "HasSiteWebAcl",
          { Ref: "SiteWebAclArn" },
          { Ref: "AWS::NoValue" },
        ],
      });
    }
  });
});

type Capacity = { ReadCapacityUnits: number; WriteCapacityUnits: number };

// DynamoDB는 BRD-55 테이블 3개가 대상. 나머지는 BRD-56~58(수집)·61(게시)에서 리소스가 생기면 바로 거름.
describe("재시도·경보·용량 (11장 기본값 함정)", () => {
  it("Scheduler 일정은 재시도 횟수와 최대 이벤트 나이를 줄여서 명시한다", () => {
    for (const schedule of Object.values(
      template.findResources("AWS::Scheduler::Schedule"),
    )) {
      const retry = schedule.Properties.Target.RetryPolicy;
      expect(retry).toBeDefined();
      expect(retry.MaximumRetryAttempts).toBeLessThanOrEqual(
        RETRY_LIMITS.scheduleMaxRetries,
      );
      expect(retry.MaximumEventAgeInSeconds).toBeLessThanOrEqual(
        RETRY_LIMITS.scheduleMaxEventAgeSeconds,
      );
    }
  });

  it("Lambda는 타임아웃과 비동기 재시도 설정을 명시한다", () => {
    const configs = Object.values(
      template.findResources("AWS::Lambda::EventInvokeConfig"),
    );
    for (const [id, fn] of Object.entries(
      template.findResources("AWS::Lambda::Function"),
    )) {
      expect(fn.Properties.Timeout).toBeDefined();
      const config = configs.find((c) => c.Properties.FunctionName?.Ref === id);
      expect(config, `${id}에 EventInvokeConfig가 없어요`).toBeDefined();
      expect(config?.Properties.MaximumRetryAttempts).toBeLessThanOrEqual(
        RETRY_LIMITS.asyncMaxRetries,
      );
      expect(config?.Properties.MaximumEventAgeInSeconds).toBeLessThanOrEqual(
        RETRY_LIMITS.asyncMaxEventAgeSeconds,
      );
    }
  });

  it("CloudWatch 경보는 10개 이하다 (무료 범위)", () => {
    const alarms =
      Object.keys(template.findResources("AWS::CloudWatch::Alarm")).length +
      Object.keys(template.findResources("AWS::CloudWatch::CompositeAlarm"))
        .length;
    expect(alarms).toBeLessThanOrEqual(MAX_ALARMS);
  });

  it("DynamoDB는 Provisioned이고 읽기·쓰기 용량 합계가 각각 25 이하다", () => {
    template.resourceCountIs("AWS::DynamoDB::GlobalTable", 0);
    let read = 0;
    let write = 0;
    for (const table of Object.values(
      template.findResources("AWS::DynamoDB::Table"),
    )) {
      const p = table.Properties;
      expect(p.BillingMode).not.toBe("PAY_PER_REQUEST");
      expect(p.ProvisionedThroughput).toBeDefined();
      for (const t of [
        p.ProvisionedThroughput,
        ...(p.GlobalSecondaryIndexes ?? []).map(
          (g: { ProvisionedThroughput: Capacity }) => g.ProvisionedThroughput,
        ),
      ] as Capacity[]) {
        read += t.ReadCapacityUnits;
        write += t.WriteCapacityUnits;
      }
    }
    expect(read).toBeLessThanOrEqual(MAX_DYNAMODB_CAPACITY_UNITS);
    expect(write).toBeLessThanOrEqual(MAX_DYNAMODB_CAPACITY_UNITS);
  });

  it("S3 이벤트로 Lambda를 깨우지 않는다 (publisher 순환 방지)", () => {
    for (const bucket of Object.values(
      template.findResources("AWS::S3::Bucket"),
    )) {
      expect(bucket.Properties.NotificationConfiguration).toBeUndefined();
    }
    template.resourceCountIs("Custom::S3BucketNotifications", 0);
    for (const permission of Object.values(
      template.findResources("AWS::Lambda::Permission"),
    )) {
      expect(permission.Properties.Principal).not.toBe("s3.amazonaws.com");
    }
  });
});

describe("CDK bootstrap 실행 정책 (11장)", () => {
  const policy = JSON.parse(
    readFileSync(
      resolve(__dirname, "../bootstrap/cfn-execution-policy.json"),
      "utf8",
    ),
  ) as {
    Statement: Array<{
      Effect: string;
      Sid?: string;
      Action?: string | string[];
      NotAction?: unknown;
      Resource?: string | string[];
      NotResource?: unknown;
      Condition?: Record<string, Record<string, unknown>>;
    }>;
  };

  it("Lambda 코드 자산은 실행 역할 계정의 서울 CDK 버킷 하나에서만 읽는다", () => {
    const statements = policy.Statement.filter(
      (s) => s.Sid === "ReadLambdaCodeAssets",
    );
    expect(statements).toEqual([
      {
        Sid: "ReadLambdaCodeAssets",
        Effect: "Allow",
        Action: "s3:GetObject",
        Resource:
          "arn:aws:s3:::cdk-hnb659fds-assets-${aws:PrincipalAccount}-ap-northeast-2/*",
      },
    ]);
  });

  // BRD-93: CloudFormation이 로그 그룹 GetAtt를 읽을 때 필요. 읽기 하나만, 다른 logs 동작은 섞지 않음
  it("로그 그룹 목록 읽기는 DescribeLogGroups 하나만 따로 허락한다", () => {
    const statements = policy.Statement.filter((s) =>
      toList(s.Action).includes("logs:DescribeLogGroups"),
    );
    expect(statements).toEqual([
      {
        Sid: "LogsDescribeForGetAtt",
        Effect: "Allow",
        Action: "logs:DescribeLogGroups",
        Resource: "*",
      },
    ]);
  });

  it("스택이 쓰는 모든 AWS 서비스가 정책에 들어 있다", () => {
    // AWS::S3::Bucket → s3, AWS::CloudFront::Function → cloudfront …
    const services = new Set(
      Object.values(
        template.toJSON().Resources as Record<string, { Type: string }>,
      )
        .map((r) => r.Type)
        .filter((t) => t.startsWith("AWS::") && t !== "AWS::CDK::Metadata")
        .map((t) => t.split("::")[1].toLowerCase()),
    );
    const allowed = new Set(
      policy.Statement.filter((s) => s.Effect === "Allow")
        .flatMap((s) => toList(s.Action))
        .map((a) => a.split(":")[0]),
    );

    for (const service of services) {
      expect([...allowed], `정책에 ${service}가 없어요`).toContain(service);
    }
  });

  it("모든 동작(*)·NotAction을 주지 않고, IAM은 이 스택의 역할로만 제한한다", () => {
    for (const s of policy.Statement) {
      expect(s.NotAction).toBeUndefined();
      expect(s.NotResource).toBeUndefined();
      for (const a of toList(s.Action)) expect(a).not.toBe("*");
      if (toList(s.Action).some((a) => a.startsWith("iam:"))) {
        expect(toList(s.Resource)).not.toContain("*");
      }
    }
  });

  // BRD-89: 실행 역할을 손에 넣어도 역할에 넓은 권한을 붙여 권한을 키우지 못하게 함
  const boundaryArn = `arn:aws:iam::\${aws:PrincipalAccount}:policy/${ROLE_BOUNDARY_POLICY_NAME}`;
  const iamActions = (effect: "Allow" | "Deny") =>
    policy.Statement.filter((s) => s.Effect === effect).flatMap((s) =>
      toList(s.Action).filter((a) => a.startsWith("iam:")),
    );

  it("iam 와일드카드를 주지 않고, 관리형 정책 부착은 허락하지 않는다", () => {
    for (const a of iamActions("Allow")) expect(a).not.toContain("*");
    expect(iamActions("Allow")).not.toContain("iam:AttachRolePolicy");
    expect(iamActions("Allow")).not.toContain("iam:DetachRolePolicy");
  });

  it("역할 만들기·인라인 정책 바꾸기·boundary 붙이기는 지정 boundary일 때만 허락한다", () => {
    const guarded = [
      "iam:CreateRole",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:PutRolePermissionsBoundary",
    ];
    for (const action of guarded) {
      const statements = policy.Statement.filter(
        (s) => s.Effect === "Allow" && toList(s.Action).includes(action),
      );
      expect(statements.length, action).toBeGreaterThan(0);
      for (const s of statements) {
        expect(s.Condition?.StringEquals?.["iam:PermissionsBoundary"]).toBe(
          boundaryArn,
        );
      }
    }
  });

  it("boundary 떼기와 boundary 정책 고치기는 명시적으로 거부한다", () => {
    expect(iamActions("Deny")).toEqual(
      expect.arrayContaining([
        "iam:DeleteRolePermissionsBoundary",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicy",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion",
      ]),
    );
    const policyEdit = policy.Statement.find(
      (s) => s.Sid === "NoBoundaryPolicyEdit",
    );
    expect(policyEdit?.Resource).toBe(
      `arn:aws:iam::*:policy/${ROLE_BOUNDARY_POLICY_NAME}`,
    );
  });

  it("역할 넘기기(PassRole)는 Lambda·Scheduler에만 허락한다", () => {
    const statements = policy.Statement.filter(
      (s) => s.Effect === "Allow" && toList(s.Action).includes("iam:PassRole"),
    );
    expect(statements).toHaveLength(1);
    expect(
      toList(
        statements[0].Condition?.StringEquals?.["iam:PassedToService"] as
          string | string[],
      ).sort(),
    ).toEqual(["lambda.amazonaws.com", "scheduler.amazonaws.com"]);
  });
});

describe("역할 권한 상한 (BRD-89)", () => {
  // 실환경 계정 번호(비밀값 아님). boundary 정책을 이 계정에만 만듦
  const ACCOUNT = "717304679248";
  const boundary = JSON.parse(
    readFileSync(
      resolve(__dirname, "../bootstrap/role-boundary-policy.json"),
      "utf8",
    ),
  ) as {
    Statement: Array<{
      Effect: string;
      Action: string | string[];
      Resource: string | string[];
      Condition?: Record<string, Record<string, unknown>>;
    }>;
  };
  const boundaryActions = boundary.Statement.filter(
    (s) => s.Effect === "Allow",
  ).flatMap((s) => toList(s.Action));

  it("스택의 모든 역할에 지정 boundary가 붙는다", () => {
    const roles = Object.values(template.findResources("AWS::IAM::Role"));
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      expect(JSON.stringify(role.Properties.PermissionsBoundary)).toContain(
        `:policy/${ROLE_BOUNDARY_POLICY_NAME}`,
      );
    }
  });

  it("boundary는 역할 정책이 쓰는 모든 동작을 담는다 (빠지면 실행 때 거부됨)", () => {
    for (const p of allIamPolicies()) {
      for (const s of p.statements.filter((s) => s.Effect === "Allow")) {
        for (const a of toList(s.Action)) {
          expect(boundaryActions, `${p.logicalId}: ${a}`).toContain(a);
        }
      }
    }
  });

  it("boundary는 IAM 동작·와일드카드 동작·전체 리소스를 주지 않는다", () => {
    for (const a of boundaryActions) {
      expect(a.startsWith("iam:"), a).toBe(false);
      expect(a, a).not.toContain("*");
    }
    for (const s of boundary.Statement) {
      expect(toList(s.Resource)).not.toContain("*");
    }
  });

  // 실행 역할을 탈취해 외부 계정이 맡는 BaradunV2-* 역할을 만들어도 API 키를 읽지 못하게 함
  it("API 키 읽기는 스택의 Lambda 함수가 보낸 요청으로만 허락한다", () => {
    const statements = boundary.Statement.filter((s) =>
      toList(s.Action).includes("ssm:GetParameter"),
    );
    expect(statements).toHaveLength(1);
    expect(statements[0].Condition?.ArnLike?.["lambda:SourceFunctionArn"]).toBe(
      `arn:aws:lambda:ap-northeast-2:${ACCOUNT}:function:BaradunV2-*`,
    );
  });

  // BRD-93: Resource ARN의 계정 자리에는 정책 변수를 쓸 수 없어 계정 번호를 그대로 씀
  it("boundary의 모든 리소스는 이 계정으로 제한한다", () => {
    for (const s of boundary.Statement) {
      for (const r of toList(s.Resource)) {
        expect(r, r).not.toContain("${");
        // S3 ARN에는 계정 자리가 없음. 버킷 이름으로만 제한함
        if (r.startsWith("arn:aws:s3:::")) {
          expect(r.startsWith("arn:aws:s3:::baradunv2-"), r).toBe(true);
        } else {
          expect(r.split(":")[4], r).toBe(ACCOUNT);
        }
      }
    }
  });

  it("KMS 복호화는 SSM을 거칠 때만 허락한다", () => {
    for (const s of boundary.Statement.filter((s) =>
      toList(s.Action).includes("kms:Decrypt"),
    )) {
      expect(s.Condition?.StringEquals?.["kms:ViaService"]).toBe(
        "ssm.ap-northeast-2.amazonaws.com",
      );
    }
  });
});
