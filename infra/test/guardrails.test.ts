import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { BaradunStack } from "../lib/baradun-stack";
import {
  MAX_MANAGED_POLICY_CHARS,
  arnMatches,
  excludedPropertyErrors,
  managedPolicyChars,
  type SchemaExclusions,
} from "../scripts/iam-policy-checks";
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

describe("대표 주소 (BRD-162)", () => {
  const distributions = () =>
    Object.values(template.findResources("AWS::CloudFront::Distribution"));

  it("도메인·인증서 매개변수는 기본이 비어 있다(출시일 전까지 지금과 같은 배포)", () => {
    const params = template.findParameters("*");
    expect(params.SiteDomainName.Default).toBe("");
    expect(params.SiteCertificateArn.Default).toBe("");
    // CloudFront 인증서는 us-east-1 ACM만 받음
    expect(params.SiteCertificateArn.AllowedPattern).toContain(
      "arn:aws:acm:us-east-1:",
    );
  });

  it("대체 도메인·인증서는 도메인 값이 있을 때만 붙는다(SNI·TLS 1.2 이상)", () => {
    for (const dist of distributions()) {
      const config = dist.Properties.DistributionConfig;
      expect(config.Aliases).toEqual({
        "Fn::If": [
          "HasSiteDomain",
          [{ Ref: "SiteDomainName" }],
          { Ref: "AWS::NoValue" },
        ],
      });
      expect(config.ViewerCertificate).toEqual({
        "Fn::If": [
          "HasSiteDomain",
          {
            AcmCertificateArn: { Ref: "SiteCertificateArn" },
            SslSupportMethod: "sni-only",
            MinimumProtocolVersion: "TLSv1.2_2021",
          },
          { Ref: "AWS::NoValue" },
        ],
      });
    }
  });

  it("도메인과 인증서는 함께 넣거나 함께 비워야 배포된다", () => {
    const rules = template.toJSON().Rules as Record<
      string,
      { Assertions: { Assert: unknown }[] }
    >;
    const assertion = JSON.stringify(
      rules.SiteDomainNeedsCertificate?.Assertions,
    );
    expect(assertion).toContain('"Ref":"SiteDomainName"');
    expect(assertion).toContain('"Ref":"SiteCertificateArn"');
    expect(assertion).toContain("Fn::Or");
  });

  it("주소 변환 함수 코드에 도메인 매개변수가 들어간다(다른 호스트는 대표 주소로 이동)", () => {
    const rewrite = Object.values(
      template.findResources("AWS::CloudFront::Function"),
    ).filter(
      (fn) =>
        fn.Properties.FunctionConfig.Comment ===
        "Rewrite folder paths to index.html",
    );
    expect(rewrite).toHaveLength(1);
    expect(JSON.stringify(rewrite[0]?.Properties.FunctionCode)).toContain(
      '{"Ref":"SiteDomainName"}',
    );
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

type BootstrapStatement = {
  Effect: string;
  Sid?: string;
  Action?: string | string[];
  NotAction?: unknown;
  Resource?: string | string[];
  NotResource?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};

type BootstrapPolicy = {
  Statement: BootstrapStatement[];
};

// 실환경 계정 번호(비밀값 아님). Resource ARN 다섯 번째 콜론 이전에는 정책 변수를 쓸 수 없어 고정함 (BRD-93, BRD-121)
const ACCOUNT = "717304679248";

const EXECUTION_POLICY_FILES = [
  "cfn-execution-policy.json",
  "cfn-execution-workload-policy.json",
] as const;

function loadBootstrapPolicy(fileName: string): {
  fileName: string;
  raw: string;
  policy: BootstrapPolicy;
} {
  const raw = readFileSync(
    resolve(__dirname, "../bootstrap", fileName),
    "utf8",
  );
  return {
    fileName,
    raw,
    policy: JSON.parse(raw) as BootstrapPolicy,
  };
}

// 템플릿 리소스 종류별 CloudFormation create·read·update·delete 핸들러 필수 IAM 작업 표 (BRD-121)
// 현재 사용 속성의 검토된 부분집합임. 공식 스키마 전체 대조는 CI의 check:iam-actions에서 수행함.
// 스키마의 선택 권한·명시적 Deny는 scripts/cfn-permission-exclusions.json으로 따로 설명·검사함.
const REQUIRED_CFN_ACTIONS_BY_RESOURCE_TYPE: Record<
  string,
  {
    create: readonly string[];
    read: readonly string[];
    update: readonly string[];
    delete: readonly string[];
  }
> = {
  "AWS::Budgets::Budget": {
    create: [
      "budgets:ModifyBudget",
      "budgets:ViewBudget",
      "budgets:TagResource",
    ],
    read: ["budgets:ViewBudget", "budgets:ListTagsForResource"],
    update: [
      "budgets:ModifyBudget",
      "budgets:ViewBudget",
      "budgets:TagResource",
      "budgets:UntagResource",
    ],
    delete: ["budgets:ModifyBudget", "budgets:ViewBudget"],
  },
  "AWS::CloudFront::Distribution": {
    create: [
      "cloudfront:CreateDistribution",
      "cloudfront:GetDistribution",
      "cloudfront:GetDistributionConfig",
      "cloudfront:TagResource",
      "wafv2:GetWebACL",
    ],
    read: [
      "cloudfront:GetDistribution",
      "cloudfront:GetDistributionConfig",
      "cloudfront:ListTagsForResource",
    ],
    update: [
      "cloudfront:GetDistribution",
      "cloudfront:GetDistributionConfig",
      "cloudfront:UpdateDistribution",
      "cloudfront:ListTagsForResource",
      "cloudfront:TagResource",
      "cloudfront:UntagResource",
      "wafv2:GetWebACL",
    ],
    delete: [
      "cloudfront:DeleteDistribution",
      "cloudfront:GetDistribution",
      "cloudfront:GetDistributionConfig",
    ],
  },
  "AWS::CloudFront::Function": {
    create: [
      "cloudfront:CreateFunction",
      "cloudfront:PublishFunction",
      "cloudfront:DescribeFunction",
      "cloudfront:TagResource",
    ],
    read: [
      "cloudfront:DescribeFunction",
      "cloudfront:GetFunction",
      "cloudfront:ListTagsForResource",
    ],
    update: [
      "cloudfront:UpdateFunction",
      "cloudfront:PublishFunction",
      "cloudfront:DescribeFunction",
      "cloudfront:TagResource",
      "cloudfront:UntagResource",
    ],
    delete: ["cloudfront:DeleteFunction", "cloudfront:DescribeFunction"],
  },
  "AWS::CloudFront::OriginAccessControl": {
    create: ["cloudfront:CreateOriginAccessControl"],
    read: ["cloudfront:GetOriginAccessControl"],
    update: [
      "cloudfront:UpdateOriginAccessControl",
      "cloudfront:GetOriginAccessControl",
    ],
    delete: [
      "cloudfront:DeleteOriginAccessControl",
      "cloudfront:GetOriginAccessControl",
    ],
  },
  "AWS::CloudFront::ResponseHeadersPolicy": {
    create: ["cloudfront:CreateResponseHeadersPolicy"],
    read: ["cloudfront:GetResponseHeadersPolicy"],
    update: [
      "cloudfront:UpdateResponseHeadersPolicy",
      "cloudfront:GetResponseHeadersPolicy",
    ],
    delete: [
      "cloudfront:DeleteResponseHeadersPolicy",
      "cloudfront:GetResponseHeadersPolicy",
    ],
  },
  "AWS::CloudWatch::Alarm": {
    create: [
      "cloudwatch:PutMetricAlarm",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:TagResource",
      "cloudwatch:ListTagsForResource",
    ],
    read: ["cloudwatch:DescribeAlarms", "cloudwatch:ListTagsForResource"],
    update: [
      "cloudwatch:PutMetricAlarm",
      "cloudwatch:DescribeAlarms",
      "cloudwatch:TagResource",
      "cloudwatch:UntagResource",
      "cloudwatch:ListTagsForResource",
    ],
    delete: ["cloudwatch:DeleteAlarms", "cloudwatch:DescribeAlarms"],
  },
  // 사용자 지정 속성·KMS·SMS·Lambda 트리거·그룹 역할·분석 연결은 쓰지 않음(cfn-permission-exclusions.json)
  "AWS::Cognito::UserPool": {
    create: [
      "cognito-idp:CreateUserPool",
      "cognito-idp:SetUserPoolMfaConfig",
      "cognito-idp:DescribeUserPool",
      "cognito-idp:TagResource",
    ],
    read: ["cognito-idp:DescribeUserPool", "cognito-idp:GetUserPoolMfaConfig"],
    update: [
      "cognito-idp:UpdateUserPool",
      "cognito-idp:ListTagsForResource",
      "cognito-idp:TagResource",
      "cognito-idp:UntagResource",
      "cognito-idp:SetUserPoolMfaConfig",
      "cognito-idp:DescribeUserPool",
      "cognito-idp:GetUserPoolMfaConfig",
    ],
    delete: ["cognito-idp:DeleteUserPool"],
  },
  "AWS::Cognito::UserPoolClient": {
    create: ["cognito-idp:CreateUserPoolClient"],
    read: [
      "cognito-idp:DescribeUserPoolClient",
      "cognito-idp:ListUserPoolClientSecrets",
    ],
    update: ["cognito-idp:UpdateUserPoolClient"],
    delete: ["cognito-idp:DeleteUserPoolClient"],
  },
  "AWS::Cognito::UserPoolGroup": {
    create: ["cognito-idp:CreateGroup", "cognito-idp:GetGroup"],
    read: ["cognito-idp:GetGroup"],
    update: ["cognito-idp:UpdateGroup"],
    delete: ["cognito-idp:DeleteGroup", "cognito-idp:GetGroup"],
  },
  "AWS::DynamoDB::Table": {
    create: [
      "dynamodb:CreateTable",
      "dynamodb:DescribeTable",
      "dynamodb:DescribeTimeToLive",
      "dynamodb:UpdateTimeToLive",
      "dynamodb:DescribeContinuousBackups",
      "dynamodb:UpdateContinuousBackups",
      "dynamodb:DescribeContributorInsights",
      "dynamodb:DescribeKinesisStreamingDestination",
      "dynamodb:GetResourcePolicy",
      "dynamodb:ListTagsOfResource",
      "dynamodb:TagResource",
      "dynamodb:UpdateTable",
    ],
    read: [
      "dynamodb:DescribeTable",
      "dynamodb:DescribeContinuousBackups",
      "dynamodb:DescribeContributorInsights",
      "dynamodb:DescribeKinesisStreamingDestination",
      "dynamodb:ListTagsOfResource",
      "dynamodb:GetResourcePolicy",
      "dynamodb:DescribeTimeToLive",
    ],
    update: [
      "dynamodb:UpdateTable",
      "dynamodb:DescribeTable",
      "dynamodb:DescribeTimeToLive",
      "dynamodb:UpdateTimeToLive",
      "dynamodb:DescribeContinuousBackups",
      "dynamodb:UpdateContinuousBackups",
      "dynamodb:DescribeContributorInsights",
      "dynamodb:DescribeKinesisStreamingDestination",
      "dynamodb:GetResourcePolicy",
      "dynamodb:ListTagsOfResource",
      "dynamodb:TagResource",
      "dynamodb:UntagResource",
    ],
    delete: ["dynamodb:DeleteTable", "dynamodb:DescribeTable"],
  },
  "AWS::IAM::OIDCProvider": {
    create: [
      "iam:CreateOpenIDConnectProvider",
      "iam:GetOpenIDConnectProvider",
      "iam:TagOpenIDConnectProvider",
    ],
    read: ["iam:GetOpenIDConnectProvider"],
    update: [
      "iam:AddClientIDToOpenIDConnectProvider",
      "iam:GetOpenIDConnectProvider",
      "iam:ListOpenIDConnectProviderTags",
      "iam:RemoveClientIDFromOpenIDConnectProvider",
      "iam:TagOpenIDConnectProvider",
      "iam:UntagOpenIDConnectProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint",
    ],
    delete: ["iam:DeleteOpenIDConnectProvider"],
  },
  "AWS::IAM::Policy": {
    create: ["iam:GetRolePolicy", "iam:PutRolePolicy"],
    read: ["iam:GetRolePolicy"],
    update: ["iam:PutRolePolicy", "iam:DeleteRolePolicy"],
    delete: ["iam:DeleteRolePolicy"],
  },
  "AWS::IAM::Role": {
    create: [
      "iam:CreateRole",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
    ],
    read: [
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
    ],
    update: [
      "iam:DeleteRolePolicy",
      "iam:PutRolePermissionsBoundary",
      "iam:PutRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
    ],
    delete: [
      "iam:DeleteRole",
      "iam:DeleteRolePolicy",
      "iam:GetRole",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:TagRole",
      "iam:UntagRole",
    ],
  },
  "AWS::Lambda::EventInvokeConfig": {
    create: ["lambda:PutFunctionEventInvokeConfig"],
    read: ["lambda:GetFunctionEventInvokeConfig"],
    update: ["lambda:UpdateFunctionEventInvokeConfig"],
    delete: ["lambda:DeleteFunctionEventInvokeConfig"],
  },
  "AWS::Lambda::Function": {
    create: [
      "lambda:CreateFunction",
      "lambda:GetFunction",
      "lambda:GetFunctionCodeSigningConfig",
      "lambda:GetFunctionRecursionConfig",
      "lambda:GetRuntimeManagementConfig",
      "lambda:TagResource",
      "iam:PassRole",
      "s3:GetObject",
    ],
    read: [
      "lambda:GetFunction",
      "lambda:GetFunctionCodeSigningConfig",
      "lambda:GetFunctionRecursionConfig",
      "lambda:GetRuntimeManagementConfig",
      "lambda:GetFunctionScalingConfig",
    ],
    update: [
      "lambda:GetFunction",
      "lambda:UpdateFunctionConfiguration",
      "lambda:UpdateFunctionCode",
      "lambda:GetFunctionCodeSigningConfig",
      "lambda:GetFunctionRecursionConfig",
      "lambda:GetRuntimeManagementConfig",
      "lambda:TagResource",
      "lambda:UntagResource",
      "lambda:ListTags",
      "lambda:PutFunctionConcurrency",
      "lambda:DeleteFunctionConcurrency",
      "iam:PassRole",
      "s3:GetObject",
    ],
    delete: ["lambda:DeleteFunction", "lambda:GetFunction"],
  },
  "AWS::Lambda::Permission": {
    create: ["lambda:AddPermission"],
    read: ["lambda:GetPolicy"],
    update: ["lambda:AddPermission", "lambda:RemovePermission"],
    delete: ["lambda:RemovePermission"],
  },
  "AWS::Lambda::Url": {
    create: ["lambda:CreateFunctionUrlConfig"],
    read: ["lambda:GetFunctionUrlConfig"],
    update: ["lambda:UpdateFunctionUrlConfig"],
    delete: ["lambda:DeleteFunctionUrlConfig"],
  },
  "AWS::Logs::LogGroup": {
    create: [
      "logs:CreateLogGroup",
      "logs:DescribeLogGroups",
      "logs:PutRetentionPolicy",
      "logs:TagResource",
      "logs:GetDataProtectionPolicy",
    ],
    read: [
      "logs:DescribeLogGroups",
      "logs:ListTagsForResource",
      "logs:GetDataProtectionPolicy",
    ],
    update: [
      "logs:DescribeLogGroups",
      "logs:PutRetentionPolicy",
      "logs:DeleteRetentionPolicy",
      "logs:TagResource",
      "logs:UntagResource",
      "logs:ListTagsForResource",
      "logs:GetDataProtectionPolicy",
    ],
    delete: ["logs:DescribeLogGroups", "logs:DeleteLogGroup"],
  },
  "AWS::S3::Bucket": {
    create: [
      "s3:CreateBucket",
      "s3:PutBucketTagging",
      "s3:PutEncryptionConfiguration",
      "s3:PutBucketCORS",
      "s3:PutLifecycleConfiguration",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketOwnershipControls",
      "s3:GetBucketAcl",
      "s3:ListBucket",
      "s3:TagResource",
    ],
    read: [
      "s3:GetAccelerateConfiguration",
      "s3:GetAnalyticsConfiguration",
      "s3:GetBucketAbac",
      "s3:GetBucketCORS",
      "s3:GetBucketLogging",
      "s3:GetBucketMetadataTableConfiguration",
      "s3:GetBucketNotification",
      "s3:GetBucketObjectLockConfiguration",
      "s3:GetBucketOwnershipControls",
      "s3:GetBucketPublicAccessBlock",
      "s3:GetBucketTagging",
      "s3:GetBucketVersioning",
      "s3:GetBucketWebsite",
      "s3:GetEncryptionConfiguration",
      "s3:GetIntelligentTieringConfiguration",
      "s3:GetInventoryConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:GetMetricsConfiguration",
      "s3:GetReplicationConfiguration",
      "s3:ListBucket",
      "s3:ListTagsForResource",
    ],
    update: [
      "s3:PutBucketCORS",
      "s3:PutBucketOwnershipControls",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutBucketTagging",
      "s3:PutEncryptionConfiguration",
      "s3:PutLifecycleConfiguration",
      "s3:TagResource",
      "s3:UntagResource",
      "s3:ListBucket",
    ],
    delete: ["s3:DeleteBucket", "s3:ListBucket"],
  },
  "AWS::S3::BucketPolicy": {
    create: ["s3:GetBucketPolicy", "s3:PutBucketPolicy"],
    read: ["s3:GetBucketPolicy"],
    update: ["s3:GetBucketPolicy", "s3:PutBucketPolicy"],
    delete: ["s3:GetBucketPolicy", "s3:DeleteBucketPolicy"],
  },
  "AWS::SNS::Subscription": {
    create: ["sns:Subscribe"],
    read: ["sns:GetSubscriptionAttributes"],
    update: ["sns:SetSubscriptionAttributes"],
    delete: ["sns:Unsubscribe", "sns:GetSubscriptionAttributes"],
  },
  "AWS::SNS::Topic": {
    create: ["sns:CreateTopic", "sns:GetTopicAttributes", "sns:TagResource"],
    read: [
      "sns:GetTopicAttributes",
      "sns:ListTagsForResource",
      "sns:ListSubscriptionsByTopic",
      "sns:GetDataProtectionPolicy",
    ],
    update: [
      "sns:SetTopicAttributes",
      "sns:GetTopicAttributes",
      "sns:ListTagsForResource",
      "sns:ListSubscriptionsByTopic",
      "sns:GetDataProtectionPolicy",
      "sns:TagResource",
      "sns:UntagResource",
    ],
    delete: ["sns:DeleteTopic", "sns:GetTopicAttributes"],
  },
  "AWS::Scheduler::Schedule": {
    create: [
      "scheduler:CreateSchedule",
      "scheduler:GetSchedule",
      "iam:PassRole",
    ],
    read: ["scheduler:GetSchedule"],
    update: [
      "scheduler:UpdateSchedule",
      "scheduler:GetSchedule",
      "iam:PassRole",
    ],
    delete: ["scheduler:DeleteSchedule", "scheduler:GetSchedule"],
  },
};

describe("CDK bootstrap 실행 정책 (11장, BRD-121)", () => {
  const executionPolicies = EXECUTION_POLICY_FILES.map(loadBootstrapPolicy);
  const allStatements = executionPolicies.flatMap((p) => p.policy.Statement);
  const allowStatements = allStatements.filter((s) => s.Effect === "Allow");
  const allowedActionSet = new Set(
    allowStatements.flatMap((s) => toList(s.Action)),
  );
  const exclusions = JSON.parse(
    readFileSync(
      resolve(__dirname, "../scripts/cfn-permission-exclusions.json"),
      "utf8",
    ),
  ) as SchemaExclusions;
  it("스키마 권한을 제외한 선택 속성을 템플릿에서 사용하지 않는다", () => {
    expect(
      excludedPropertyErrors(template.toJSON().Resources, exclusions),
    ).toEqual([]);
  });

  it("DynamoDB의 고객 관리 KMS 키를 제외하므로 SSEEnabled는 false다", () => {
    for (const table of Object.values(
      template.findResources("AWS::DynamoDB::Table"),
    )) {
      expect(table.Properties.SSESpecification?.SSEEnabled).toBe(false);
    }
  });

  it("실제 운영 스택의 CloudFront 함수 이름과 예산 이름이 실행 정책 ARN에 맞는다", () => {
    // 기존 Test 스택 이름이 아니라 실제 배포 식별자로 합성해야 CDK의 생성 이름을 검사할 수 있음.
    const productionTemplate = Template.fromStack(
      new BaradunStack(
        new App({ context: { "aws:cdk:bundling-stacks": [] } }),
        "BaradunV2",
        { env: { account: ACCOUNT, region: "ap-northeast-2" } },
      ),
    );
    const functions = Object.values(
      productionTemplate.findResources("AWS::CloudFront::Function"),
    );
    const budgets = Object.values(
      productionTemplate.findResources("AWS::Budgets::Budget"),
    );
    expect(functions.length).toBeGreaterThan(0);
    expect(budgets.length).toBeGreaterThan(0);
    const cases = [
      ...functions.map((r) => ({
        arn: `arn:aws:cloudfront::${ACCOUNT}:function/${r.Properties.Name}`,
        actions: [
          "cloudfront:PublishFunction",
          "cloudfront:DescribeFunction",
          "cloudfront:TagResource",
        ],
      })),
      ...budgets.map((r) => ({
        arn: `arn:aws:budgets::${ACCOUNT}:budget/${r.Properties.Budget.BudgetName}`,
        actions: ["budgets:ModifyBudget", "budgets:ViewBudget"],
      })),
    ];
    for (const { arn, actions } of cases) {
      for (const action of actions) {
        expect(
          allowStatements.some(
            (s) =>
              toList(s.Action).includes(action) &&
              toList(s.Resource).some((r) => r !== "*" && arnMatches(r, arn)),
          ),
          `${action}: ${arn}`,
        ).toBe(true);
      }
    }
  });

  it("CloudFront 함수는 이름 ARN, 배포는 명시적 사용자 태그로 제한한다", () => {
    const statements = allowStatements.filter((s) =>
      toList(s.Action).some((a) => a.startsWith("cloudfront:")),
    );
    for (const statement of statements) {
      if (statement.Sid === "CloudFrontCreate") continue;
      const resources = toList(statement.Resource);
      if (statement.Sid === "CloudFrontTagOnCreate") {
        expect(statement.Action).toBe("cloudfront:TagResource");
        expect(resources).toEqual([
          `arn:aws:cloudfront::${ACCOUNT}:distribution/*`,
        ]);
        expect(
          statement.Condition?.StringEquals?.["aws:RequestTag/baradun:stack"],
        ).toBe("BaradunV2");
        continue;
      }
      expect(resources).toHaveLength(1);
      if (resources[0].includes(":function/")) {
        expect(resources[0]).toBe(
          `arn:aws:cloudfront::${ACCOUNT}:function/ap-northeast-2BaradunV2*`,
        );
        expect(statement.Condition).toBeUndefined();
      } else if (resources[0].includes(":distribution/")) {
        expect(
          statement.Condition?.StringEquals?.["aws:ResourceTag/baradun:stack"],
        ).toBe("BaradunV2");
      } else {
        expect(
          toList(statement.Action).some((a) =>
            [
              "cloudfront:TagResource",
              "cloudfront:UntagResource",
              "cloudfront:ListTagsForResource",
            ].includes(a),
          ),
        ).toBe(false);
      }
    }
    for (const resource of Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    )) {
      expect(resource.Properties.Tags).toContainEqual({
        Key: "baradun:stack",
        Value: "Test",
      });
    }
    expect(JSON.stringify(statements)).not.toContain("aws:cloudformation:");
  });
  // 핸들러 작업 외 예외: CFN의 bootstrap SSM 파라미터 해석과 Logs 구 태그 API 호환.
  // s3:GetObject는 Lambda 핸들러 표에 포함하되, 아래에서 자산 버킷 하나로 제한함.
  const approvedActionSet = new Set([
    ...Object.values(REQUIRED_CFN_ACTIONS_BY_RESOURCE_TYPE).flatMap(
      (handlers) => Object.values(handlers).flat(),
    ),
    "ssm:GetParameter",
    "ssm:GetParameters",
    "logs:ListTagsLogGroup",
    "logs:TagLogGroup",
    "logs:UntagLogGroup",
  ]);
  const unapprovedActions = (statements: readonly BootstrapStatement[]) =>
    statements
      .filter((s) => s.Effect === "Allow")
      .flatMap((s) => toList(s.Action))
      .filter((action) => !approvedActionSet.has(action));

  it("필수 핸들러 작업과 명시한 호환·bootstrap 예외만 허락한다", () => {
    expect(unapprovedActions(allStatements)).toEqual([]);
  });

  it.each([
    "dynamodb:TransactWriteItems",
    "dynamodb:ExecuteStatement",
    "dynamodb:BatchExecuteStatement",
    "dynamodb:BatchGetItem",
    "dynamodb:BatchWriteItem",
    "logs:GetQueryResults",
    "logs:GetLogRecord",
    "sns:PublishBatch",
    "s3:GetObjectVersion",
    "s3:GetObjectAttributes",
  ])("추가 데이터 평면 작업 %s는 허용 목록에서 거른다", (action) => {
    expect(
      unapprovedActions([
        ...allStatements,
        { Effect: "Allow", Action: action, Resource: "*" },
      ]),
    ).toEqual([action]);
  });

  it("모든 bootstrap Action과 핸들러 표는 공식 IAM Action 스냅샷에 존재한다", () => {
    // 공개 Service Authorization Reference에서 확인한 작업만 저장함.
    // CI는 네트워크 없이 검사하며, 최신 공식 문서 재확인은 check:iam-actions로 수행함.
    const snapshot = JSON.parse(
      readFileSync(resolve(__dirname, "fixtures/iam-actions.json"), "utf8"),
    ) as { actions: string[] };
    const officialActions = new Set(snapshot.actions);
    for (const { fileName, policy } of [
      ...executionPolicies,
      loadBootstrapPolicy("role-boundary-policy.json"),
    ]) {
      for (const statement of policy.Statement) {
        for (const action of toList(statement.Action)) {
          expect(officialActions.has(action), `${fileName}: ${action}`).toBe(
            true,
          );
        }
      }
    }
    for (const action of approvedActionSet) {
      expect(officialActions.has(action), `핸들러 표·예외: ${action}`).toBe(
        true,
      );
    }
    for (const apiName of [
      "cloudfront:CreateDistributionWithTags",
      "s3:DeleteBucketCors",
    ]) {
      expect(officialActions.has(apiName), apiName).toBe(false);
    }
  });

  it("정책 파일마다 공백 제외 6,144자(IAM 고객 관리형 정책 한도) 이하다", () => {
    const actualFiles = readdirSync(resolve(__dirname, "../bootstrap"))
      .filter((name) => name.endsWith(".json"))
      .sort();
    expect(actualFiles).toEqual(
      [...EXECUTION_POLICY_FILES, "role-boundary-policy.json"].sort(),
    );

    for (const { fileName, raw } of [
      ...executionPolicies,
      loadBootstrapPolicy("role-boundary-policy.json"),
    ]) {
      const nonWhitespaceLength = managedPolicyChars(raw);
      expect(
        nonWhitespaceLength,
        `${fileName}: ${nonWhitespaceLength}자`,
      ).toBeLessThanOrEqual(MAX_MANAGED_POLICY_CHARS);
    }
  });

  it("두 실행 정책 파일은 서비스 묶음이 겹치지 않게 나뉜다", () => {
    const servicesPerFile = executionPolicies.map(
      ({ fileName, policy }) =>
        [
          fileName,
          new Set(
            policy.Statement.flatMap((s) => toList(s.Action)).map(
              (a) => a.split(":")[0],
            ),
          ),
        ] as const,
    );
    const [first, second] = servicesPerFile;
    const overlap = [...first[1]].filter((svc) => second[1].has(svc));
    expect(overlap).toEqual([]);
  });

  it("모든 정책 파일에 서비스 단위 와일드카드(*)·NotAction·NotResource가 없다", () => {
    for (const { fileName, policy } of executionPolicies) {
      for (const s of policy.Statement) {
        expect(s.NotAction, fileName).toBeUndefined();
        expect(s.NotResource, fileName).toBeUndefined();
        const actions = toList(s.Action);
        expect(actions.length, `${fileName} ${s.Sid}`).toBeGreaterThan(0);
        for (const a of actions) {
          expect(a, `${fileName} ${s.Sid}: ${a}`).not.toContain("*");
          expect(a, `${fileName} ${s.Sid}: ${a}`).toMatch(
            /^[a-z0-9-]+:[A-Za-z0-9]+$/,
          );
        }
      }
    }
  });

  it("데이터 평면 작업을 주지 않고, S3 객체 읽기는 CDK 자산 버킷 하나만 예외로 허락한다", () => {
    for (const s of allowStatements) {
      for (const r of toList(s.Resource)) {
        expect(r, `${s.Sid}: ${r}`).not.toBe("arn:aws:s3:::baradunv2-*/*");
        expect(r, `${s.Sid}: ${r}`).not.toContain(":table/BaradunV2-*/*");
      }
    }

    const assetStatements = allStatements.filter(
      (s) =>
        s.Sid === "ReadLambdaCodeAssets" ||
        toList(s.Action).includes("s3:GetObject"),
    );
    expect(assetStatements).toEqual([
      {
        Sid: "ReadLambdaCodeAssets",
        Effect: "Allow",
        Action: "s3:GetObject",
        Resource:
          "arn:aws:s3:::cdk-hnb659fds-assets-${aws:PrincipalAccount}-ap-northeast-2/*",
      },
    ]);
  });

  it("Resource ARN 다섯 번째 콜론 이전에 정책 변수나 *가 없고 계정 번호를 고정한다", () => {
    for (const { fileName, policy } of executionPolicies) {
      for (const s of policy.Statement) {
        for (const r of toList(s.Resource)) {
          if (r === "*") continue;
          const parts = r.split(":");
          expect(
            parts.length,
            `${fileName} ${s.Sid}: ${r}`,
          ).toBeGreaterThanOrEqual(6);
          const beforeFifthColon = parts.slice(0, 5).join(":");
          expect(beforeFifthColon, `${fileName} ${s.Sid}: ${r}`).not.toContain(
            "${",
          );
          expect(beforeFifthColon, `${fileName} ${s.Sid}: ${r}`).not.toContain(
            "*",
          );

          const service = parts[2];
          const region = parts[3];
          const account = parts[4];
          if (service === "s3") {
            expect(region, r).toBe("");
            expect(account, r).toBe("");
          } else {
            expect(account, `${fileName} ${s.Sid}: ${r}`).toBe(ACCOUNT);
            if (["iam", "cloudfront", "budgets"].includes(service)) {
              expect(region, r).toBe("");
            } else if (service === "wafv2") {
              expect(region, r).toBe("us-east-1");
            } else {
              expect(region, r).toBe("ap-northeast-2");
            }
          }
        }
      }
    }
  });

  // 리소스 수준 권한을 지원하지 않는 작업만 Resource "*"를 허용함.
  // 리전 서비스(logs, cloudwatch, cognito-idp)는 서울 리전 조건을 걸고, 전역 서비스(cloudfront)에는 걸지 않음.
  it("Resource * 문장은 리소스 수준 권한이 없는 승인된 작업만 담는다", () => {
    const wildcardResourceStatements = allStatements.filter((s) =>
      toList(s.Resource).includes("*"),
    );
    expect(wildcardResourceStatements).toEqual([
      {
        Sid: "CloudFrontCreate",
        Effect: "Allow",
        Action: [
          "cloudfront:CreateDistribution",
          "cloudfront:CreateFunction",
          "cloudfront:CreateOriginAccessControl",
          "cloudfront:CreateResponseHeadersPolicy",
        ],
        Resource: "*",
      },
      {
        Sid: "LogsDescribeForGetAtt",
        Effect: "Allow",
        Action: "logs:DescribeLogGroups",
        Resource: "*",
        Condition: {
          StringEquals: {
            "aws:RequestedRegion": "ap-northeast-2",
          },
        },
      },
      {
        Sid: "OpsAlarmsDescribe",
        Effect: "Allow",
        Action: "cloudwatch:DescribeAlarms",
        Resource: "*",
        Condition: {
          StringEquals: {
            "aws:RequestedRegion": "ap-northeast-2",
          },
        },
      },
      {
        Sid: "OperatorUserPoolCreate",
        Effect: "Allow",
        Action: "cognito-idp:CreateUserPool",
        Resource: "*",
        Condition: {
          StringEquals: {
            "aws:RequestedRegion": "ap-northeast-2",
          },
        },
      },
    ]);
  });

  // BRD-93: CloudFormation이 로그 그룹 GetAtt를 읽을 때 필요. 읽기 하나만, 다른 logs 동작은 섞지 않음
  it("로그 그룹 목록 읽기는 DescribeLogGroups 하나만 서울 리전 조건으로 따로 허락한다", () => {
    const statements = allStatements.filter((s) =>
      toList(s.Action).includes("logs:DescribeLogGroups"),
    );
    expect(statements).toEqual([
      {
        Sid: "LogsDescribeForGetAtt",
        Effect: "Allow",
        Action: "logs:DescribeLogGroups",
        Resource: "*",
        Condition: {
          StringEquals: {
            "aws:RequestedRegion": "ap-northeast-2",
          },
        },
      },
    ]);
  });

  it("Lambda ARN은 unqualified와 qualified($LATEST·버전·별칭) 둘 다 덮는다", () => {
    const lambdaStatements = allowStatements.filter((s) =>
      toList(s.Action).some((a) => a.startsWith("lambda:")),
    );
    expect(lambdaStatements).toHaveLength(1);
    expect(toList(lambdaStatements[0].Resource)).toEqual([
      `arn:aws:lambda:ap-northeast-2:${ACCOUNT}:function:BaradunV2-*`,
      `arn:aws:lambda:ap-northeast-2:${ACCOUNT}:function:BaradunV2-*:*`,
    ]);
  });

  it("Budget은 고정 ARN 하나와 ModifyBudget·ViewBudget·ListTagsForResource·TagResource·UntagResource 5개만 허락한다", () => {
    const budgetStatements = allStatements.filter((s) =>
      toList(s.Action).some((a) => a.startsWith("budgets:")),
    );
    expect(budgetStatements).toEqual([
      {
        Sid: "Budget",
        Effect: "Allow",
        Action: [
          "budgets:ListTagsForResource",
          "budgets:ModifyBudget",
          "budgets:TagResource",
          "budgets:UntagResource",
          "budgets:ViewBudget",
        ],
        Resource: `arn:aws:budgets::${ACCOUNT}:budget/baradun-v2-monthly`,
      },
    ]);
  });

  it("템플릿 리소스 종류별 Create·Read·Update·Delete 필수 작업이 모두 정책에 들어 있다", () => {
    const templateResourceTypes = new Set(
      Object.values(
        template.toJSON().Resources as Record<string, { Type: string }>,
      )
        .map((r) => r.Type)
        .filter((t) => t.startsWith("AWS::") && t !== "AWS::CDK::Metadata"),
    );

    // 템플릿에 새 리소스 종류가 생기면 필수 작업 표에도 반드시 등록해야 함
    expect([...templateResourceTypes].sort()).toEqual(
      Object.keys(REQUIRED_CFN_ACTIONS_BY_RESOURCE_TYPE).sort(),
    );

    for (const [resourceType, handlers] of Object.entries(
      REQUIRED_CFN_ACTIONS_BY_RESOURCE_TYPE,
    )) {
      for (const lifecycle of ["create", "read", "update", "delete"] as const) {
        const requiredActions = handlers[lifecycle];
        expect(
          requiredActions.length,
          `${resourceType}.${lifecycle} 필수 작업이 비어 있어요`,
        ).toBeGreaterThan(0);
        for (const action of requiredActions) {
          expect(
            allowedActionSet.has(action),
            `${resourceType}.${lifecycle}에 필요한 ${action}이 실행 정책에 없어요`,
          ).toBe(true);
        }
      }
    }
  });

  // BRD-89: 실행 역할을 손에 넣어도 역할에 넓은 권한을 붙여 권한을 키우지 못하게 함
  const boundaryArn = `arn:aws:iam::\${aws:PrincipalAccount}:policy/${ROLE_BOUNDARY_POLICY_NAME}`;
  const iamActions = (effect: "Allow" | "Deny") =>
    allStatements
      .filter((s) => s.Effect === effect)
      .flatMap((s) => toList(s.Action).filter((a) => a.startsWith("iam:")));

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
      const statements = allStatements.filter(
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
    const policyEdit = allStatements.find(
      (s) => s.Sid === "NoBoundaryPolicyEdit",
    );
    expect(policyEdit?.Resource).toBe(
      `arn:aws:iam::${ACCOUNT}:policy/${ROLE_BOUNDARY_POLICY_NAME}`,
    );
  });

  it("역할 넘기기(PassRole)는 대상 ARN과 Lambda·Scheduler 서비스 조건이 함께 있다", () => {
    const statements = allStatements.filter(
      (s) => s.Effect === "Allow" && toList(s.Action).includes("iam:PassRole"),
    );
    expect(statements).toHaveLength(1);
    expect(statements[0].Resource).toBe(
      `arn:aws:iam::${ACCOUNT}:role/BaradunV2-*`,
    );
    expect(
      toList(
        statements[0].Condition?.StringEquals?.["iam:PassedToService"] as
          string | string[],
      ).sort(),
    ).toEqual(["lambda.amazonaws.com", "scheduler.amazonaws.com"]);
  });

  it("문서의 관리자 역할은 실행 정책의 IAM 관리·PassRole 범위 밖이다", () => {
    const readme = readFileSync(resolve(__dirname, "../README.md"), "utf8");
    const adminRoleName = readme.match(
      /aws iam create-role --role-name ([A-Za-z0-9+=,.@_-]+)/,
    )?.[1];
    expect(adminRoleName).toBeDefined();
    const adminArn = `arn:aws:iam::${ACCOUNT}:role/${adminRoleName}`;
    for (const statement of allowStatements.filter((s) =>
      toList(s.Action).some((action) => action.startsWith("iam:")),
    )) {
      for (const resource of toList(statement.Resource)) {
        expect(
          arnMatches(resource, adminArn),
          `${statement.Sid}: ${resource}`,
        ).toBe(false);
      }
    }
  });
});

describe("역할 권한 상한 (BRD-89)", () => {
  const boundary = loadBootstrapPolicy("role-boundary-policy.json").policy;
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
