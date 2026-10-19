import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BaradunStack } from "../lib/baradun-stack";

// AWS가 만들어 둔 CachingOptimized 정책 ID (모든 계정 공통)
const CACHING_OPTIMIZED_ID = "658327ea-f89d-4fab-a63d-7e88639e58f6";

// 스택을 CloudFormation 템플릿(JSON)으로 만들어서 검사함. AWS 계정은 필요 없음.
const template = Template.fromStack(
  new BaradunStack(new App(), "Test", { env: { region: "ap-northeast-2" } }),
);

describe("버킷", () => {
  it("공개 접근을 모두 막는다", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it("스택을 지워도 버킷은 남긴다", () => {
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  it("읽기 허용은 CloudFront뿐이고, 누구나(*) 허용은 없다", () => {
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);

    const statements = Object.values(
      template.findResources("AWS::S3::BucketPolicy"),
    ).flatMap(
      (policy) =>
        policy.Properties.PolicyDocument.Statement as Array<
          Record<string, unknown>
        >,
    );
    const allows = statements.filter((s) => s.Effect === "Allow");

    expect(allows.length).toBeGreaterThan(0);
    for (const s of allows) {
      expect(s.Principal).toEqual({ Service: "cloudfront.amazonaws.com" });
    }
  });
});

describe("CloudFront 배포", () => {
  it("https로 보내고, 기본 캐시 정책을 쓰고, 예전 방식 설정(ForwardedValues)은 없다", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: "redirect-to-https",
          CachePolicyId: CACHING_OPTIMIZED_ID,
          ForwardedValues: Match.absent(),
          FunctionAssociations: [
            Match.objectLike({ EventType: "viewer-request" }),
          ],
        }),
      }),
    });
  });

  it("없는 파일(403)은 404 페이지로 보여 준다", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: [
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 404,
            ResponsePagePath: "/404.html",
          }),
        ],
      }),
    });
  });

  it("주소 변환 함수는 JS 2.0 런타임이다", () => {
    template.hasResourceProperties("AWS::CloudFront::Function", {
      FunctionConfig: Match.objectLike({ Runtime: "cloudfront-js-2.0" }),
    });
  });
});
