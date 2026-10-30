import { Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  CSP_MAX_LENGTH,
} from "../lib/site/security-headers";
import { template } from "./stack-template";

describe("CloudFront 보안 응답 헤더 정책 (BRD-118)", () => {
  it("ResponseHeadersPolicy 리소스가 생성되고 보안 헤더가 설정된다", () => {
    template.resourceCountIs("AWS::CloudFront::ResponseHeadersPolicy", 1);
    template.hasResourceProperties(
      "AWS::CloudFront::ResponseHeadersPolicy",
      Match.objectLike({
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            StrictTransportSecurity: {
              AccessControlMaxAgeSec: 31536000, // 1년
              IncludeSubdomains: false,
              Override: true,
              Preload: false,
            },
            ContentTypeOptions: {
              Override: true, // nosniff
            },
            FrameOptions: {
              FrameOption: "DENY",
              Override: true,
            },
            ReferrerPolicy: {
              Override: true,
              ReferrerPolicy: "strict-origin-when-cross-origin",
            },
            ContentSecurityPolicy: Match.objectLike({
              Override: true,
            }),
          }),
          CustomHeadersConfig: {
            Items: [
              {
                Header: "Permissions-Policy",
                Override: true,
                Value: "camera=(), microphone=(), geolocation=(self)",
              },
            ],
          },
        }),
      }),
    );
  });

  it("사이트 기본 동작(defaultBehavior)에 보안 헤더 정책이 붙는다", () => {
    const policies = Object.keys(
      template.findResources("AWS::CloudFront::ResponseHeadersPolicy"),
    );
    expect(policies).toHaveLength(1);
    const policyLogicalId = policies[0]!;

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ResponseHeadersPolicyId: { Ref: policyLogicalId },
        }),
      }),
    });
  });

  it("문의 API 동작(api/inquiries*)에도 보안 헤더 정책이 붙는다", () => {
    const policies = Object.keys(
      template.findResources("AWS::CloudFront::ResponseHeadersPolicy"),
    );
    expect(policies).toHaveLength(1);
    const policyLogicalId = policies[0]!;

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: "api/inquiries*",
            ResponseHeadersPolicyId: { Ref: policyLogicalId },
          }),
        ]),
      }),
    });
  });

  describe("CSP 문자열 생성 및 사진 버킷 조건부 허용 (결정 2)", () => {
    it("사진 받기 꺼짐(기본값)일 때는 사진 버킷 주소가 connect-src에 들어가지 않는다", () => {
      const csp = buildContentSecurityPolicy({
        photoUploadEnabled: false,
        photoBucketName: "test-photo-bucket",
      });
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("script-src 'self' 'unsafe-inline'");
      expect(csp).toContain("style-src 'self'");
      expect(csp).toContain(
        "img-src 'self' blob: https://tiles.openfreemap.org https://tong.visitkorea.or.kr",
      );
      expect(csp).toContain("font-src 'self'");
      expect(csp).toContain("connect-src 'self' https://tiles.openfreemap.org");
      expect(csp).not.toContain("test-photo-bucket");
      expect(csp).not.toContain("amazonaws.com");
      expect(csp).toContain("worker-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp.length).toBeLessThanOrEqual(CSP_MAX_LENGTH);
    });

    it("사진 받기 켜짐일 때는 사진 버킷 주소가 connect-src에 들어간다", () => {
      const csp = buildContentSecurityPolicy({
        photoUploadEnabled: true,
        photoBucketName: "baradun-inquiry-photos-prod",
      });
      expect(csp).toContain(
        "connect-src 'self' https://tiles.openfreemap.org https://baradun-inquiry-photos-prod.s3.ap-northeast-2.amazonaws.com",
      );
      expect(csp.length).toBeLessThanOrEqual(CSP_MAX_LENGTH);
    });

    it("CSP 길이가 CloudFront 한도(1,783자)를 넘지 않는다", () => {
      const cspOff = buildContentSecurityPolicy({ photoUploadEnabled: false });
      const cspOn = buildContentSecurityPolicy({
        photoUploadEnabled: true,
        photoBucketName: "a".repeat(63), // S3 버킷 이름 최대 길이
      });
      expect(cspOff.length).toBeLessThanOrEqual(CSP_MAX_LENGTH);
      expect(cspOn.length).toBeLessThanOrEqual(CSP_MAX_LENGTH);
      expect(cspOn.length).toBeLessThan(500); // 1,783자 한도보다 훨씬 여유 있음(약 390자)
    });
  });
});
