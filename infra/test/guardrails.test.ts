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
  apiKeyParameterName,
} from "../lib/settings";
import { template, toList } from "./stack-template";

// 아키텍처 11장 '과금·보안 가드레일'을 템플릿으로 검사해요.
// 지금은 검사 대상이 0개인 항목도 있어요. 다음 묶음에서 리소스가 생기면 바로 걸러요.

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
