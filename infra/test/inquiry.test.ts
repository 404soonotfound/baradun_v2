import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { template } from "./stack-template";

describe("데이터 문의 접수 인프라", () => {
  it("함수 URL을 AWS_IAM과 CloudFront OAC로 잠근다", () => {
    template.resourceCountIs("AWS::Lambda::Url", 1);
    template.hasResourceProperties("AWS::Lambda::Url", {
      AuthType: "AWS_IAM",
    });
    template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: "lambda",
        SigningBehavior: "always",
        SigningProtocol: "sigv4",
      }),
    });

    const permissions = Object.values(
      template.findResources("AWS::Lambda::Permission"),
    ).filter(
      (permission) =>
        permission.Properties.Principal === "cloudfront.amazonaws.com",
    );
    expect(
      permissions.map((permission) => permission.Properties.Action),
    ).toEqual(
      expect.arrayContaining([
        "lambda:InvokeFunctionUrl",
        "lambda:InvokeFunction",
      ]),
    );
    expect(permissions).toHaveLength(2);
    for (const permission of permissions) {
      expect(permission.Properties.SourceArn).toBeDefined();
      expect(permission.Properties.Principal).not.toBe("*");
    }
    expect(
      permissions.find(
        (permission) =>
          permission.Properties.Action === "lambda:InvokeFunction",
      )?.Properties.InvokedViaFunctionUrl,
    ).toBe(true);
  });

  it("문의 경로에 캐시 없음과 CloudFront Function 선행 검사를 붙인다", () => {
    const distributions = Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    );
    expect(distributions).toHaveLength(1);
    const behaviors = distributions[0]?.Properties.DistributionConfig
      .CacheBehaviors as Array<Record<string, unknown>>;
    const inquiry = behaviors.find(
      (behavior) => behavior.PathPattern === "api/inquiries*",
    );
    expect(inquiry).toMatchObject({
      PathPattern: "api/inquiries*",
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: [
        "GET",
        "HEAD",
        "OPTIONS",
        "PUT",
        "PATCH",
        "POST",
        "DELETE",
      ],
    });
    expect(inquiry?.FunctionAssociations).toEqual([
      expect.objectContaining({ EventType: "viewer-request" }),
    ]);

    const functions = Object.values(
      template.findResources("AWS::CloudFront::Function"),
    );
    const code = functions
      .map((resource) => String(resource.Properties.FunctionCode))
      .find((value) => value.includes("x-amz-content-sha256"));
    expect(code).toContain("content-length");
    expect(code).toContain("32768");
  });

  it("오리진 요청 정책은 관리형 AllViewerExceptHostHeader를 쓴다 (x-amz-*는 allowlist 금지)", () => {
    // 직접 만든 정책이 없어야 함: content-length·x-amz-content-sha256은 CloudFront가
    // allowlist에 못 넣게 하는 헤더라 정책 생성이 거부됨(2026-10-26 실배포 오류)
    template.resourceCountIs("AWS::CloudFront::OriginRequestPolicy", 0);
    const distributions = Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    );
    const behaviors = distributions[0]?.Properties.DistributionConfig
      .CacheBehaviors as Array<Record<string, unknown>>;
    const inquiry = behaviors.find(
      (behavior) => behavior.PathPattern === "api/inquiries*",
    );
    // 관리형 Managed-AllViewerExceptHostHeader의 고정 id
    expect(inquiry?.OriginRequestPolicyId).toBe(
      "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    );
  });

  it("사진 버킷은 비공개이고 30일 뒤 삭제한다", () => {
    const buckets = Object.values(template.findResources("AWS::S3::Bucket"));
    const photos = buckets.find(
      (bucket) => bucket.Properties.CorsConfiguration !== undefined,
    );
    expect(photos?.Properties).toMatchObject({
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: {
        Rules: [{ ExpirationInDays: 30, Status: "Enabled" }],
      },
    });
  });

  it("메일 주제 하나와 이메일 구독 하나를 만든다", () => {
    // 스택에는 운영 경보 주제(BRD-62)도 있으므로 문의 주제만 골라 셈
    const topics = Object.entries(
      template.findResources("AWS::SNS::Topic"),
    ).filter(([id]) => id.startsWith("InquiryTopic")); // 논리 ID가 InquiryTopic…인 것만
    expect(topics).toHaveLength(1);
    const [topicId] = topics[0]!; // [논리 ID, 리소스] 중 논리 ID만 꺼냄

    // 그 주제에 붙은 구독만 셈
    const subs = Object.values(
      template.findResources("AWS::SNS::Subscription"),
    ).filter((s) => s.Properties.TopicArn?.Ref === topicId);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.Properties).toMatchObject({
      Protocol: "email",
      Endpoint: { Ref: "AlertEmail" },
    });
  });

  it("새 계정 한도 때문에 예약 동시 실행을 설정하지 않는다", () => {
    const functions = Object.values(
      template.findResources("AWS::Lambda::Function"),
    );
    const inquiry = functions.find((resource) =>
      String(resource.Properties.Description).includes("data inquiry"),
    );
    expect(inquiry).toBeDefined();
    expect(inquiry?.Properties.ReservedConcurrentExecutions).toBeUndefined();
  });
});
