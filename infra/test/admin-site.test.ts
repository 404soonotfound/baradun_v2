import { describe, expect, it } from "vitest";
import {
  ADMIN_ROBOTS_TAG,
  buildAdminContentSecurityPolicy,
  COGNITO_ENDPOINT,
} from "../lib/admin/admin-site";
import {
  allIamPolicies,
  resourceText,
  template,
  toList,
} from "./stack-template";

// 운영자 사이트 전달 (BRD-147, 아키텍처 18.7)

type Resource = { Properties: Record<string, any> };

function one(type: string, prefix: string): [string, Resource] {
  const found = Object.entries(template.findResources(type)).filter(([id]) =>
    id.startsWith(prefix),
  );
  expect(found, `${type} ${prefix}`).toHaveLength(1);
  return found[0] as [string, Resource];
}

const [distributionId, distribution] = one(
  "AWS::CloudFront::Distribution",
  "AdminSiteDistribution",
);
const config = distribution.Properties.DistributionConfig;
const [headersId, headers] = one(
  "AWS::CloudFront::ResponseHeadersPolicy",
  "AdminSiteHeaders",
);
const [bucketId, bucket] = one("AWS::S3::Bucket", "AdminSiteBucket");

describe("운영자 사이트 배포", () => {
  it("사용자 사이트와 다른 버킷·배포이고, 버킷은 공개 차단·남김이다", () => {
    expect(distributionId).not.toMatch(/^SiteDistribution/);
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(
      template.findResources("AWS::S3::Bucket")[bucketId]?.DeletionPolicy,
    ).toBe("Retain");
    // 대체 도메인은 아직 없음(D16-E3) → CloudFront 기본 주소
    expect(config.Aliases).toBeUndefined();
  });

  it("화면은 S3(OAC), /ops/*는 운영 API 함수 URL(OAC)로 보내고 캐시하지 않는다", () => {
    const origins = config.Origins as Record<string, any>[];
    const target = (id: string) => origins.find((o) => o.Id === id);
    expect(
      resourceText(
        target(config.DefaultCacheBehavior.TargetOriginId)?.DomainName,
      ),
    ).toContain(bucketId);

    const behaviors = config.CacheBehaviors as Record<string, any>[];
    expect(behaviors.map((b) => b.PathPattern)).toEqual(["ops/*"]);
    const ops = behaviors[0]!;
    expect(JSON.stringify(target(ops.TargetOriginId)?.DomainName)).toContain(
      "OpsApiFunctionFunctionUrl",
    );
    expect(ops.CachePolicyId).toBe("4135ea2d-6df8-44a3-9df3-4b5a84be39ad"); // Managed-CachingDisabled
    expect(ops.OriginRequestPolicyId).toBe(
      "b689b0a8-53d0-40ab-baf2-68738e2966ac", // Managed-AllViewerExceptHostHeader
    );
    expect(ops.AllowedMethods).toContain("POST");
    expect(ops.ViewerProtocolPolicy).toBe("https-only");
    // 폴더 주소를 index.html로 바꾸는 함수는 화면에만(운영 API 경로를 바꾸지 않게)
    expect(ops.FunctionAssociations).toBeUndefined();
    expect(config.DefaultCacheBehavior.FunctionAssociations).toHaveLength(1);
  });

  it("오류 응답을 바꾸지 않는다(운영 API의 401·403·404 JSON이 HTML로 바뀌지 않게)", () => {
    expect(config.CustomErrorResponses).toBeUndefined();
  });

  it("CloudFront만 운영 API를 부를 수 있고, 그 출처는 운영자 사이트 배포다", () => {
    const permissions = Object.values(
      template.findResources("AWS::Lambda::Permission"),
    ).filter((p) =>
      JSON.stringify(p.Properties.FunctionName).includes("OpsApiFunction"),
    );
    expect(permissions.map((p) => p.Properties.Action).sort()).toEqual([
      "lambda:InvokeFunction",
      "lambda:InvokeFunctionUrl",
    ]);
    for (const p of permissions) {
      expect(p.Properties.Principal).toBe("cloudfront.amazonaws.com");
      expect(JSON.stringify(p.Properties.SourceArn)).toContain(distributionId);
    }
  });
});

describe("운영자 사이트 응답 헤더", () => {
  const policy = headers.Properties.ResponseHeadersPolicyConfig;

  it("화면·운영 API 모두 같은 헤더 정책을 쓴다", () => {
    expect(config.DefaultCacheBehavior.ResponseHeadersPolicyId).toEqual({
      Ref: headersId,
    });
    expect(config.CacheBehaviors[0].ResponseHeadersPolicyId).toEqual({
      Ref: headersId,
    });
  });

  it("검색 노출 차단 헤더와 보안 헤더를 붙인다", () => {
    expect(policy.CustomHeadersConfig.Items).toContainEqual({
      Header: "X-Robots-Tag",
      Value: ADMIN_ROBOTS_TAG,
      Override: true,
    });
    expect(ADMIN_ROBOTS_TAG).toMatch(/noindex/);
    const security = policy.SecurityHeadersConfig;
    expect(security.FrameOptions.FrameOption).toBe("DENY");
    expect(security.ReferrerPolicy.ReferrerPolicy).toBe("no-referrer");
    expect(security.StrictTransportSecurity.AccessControlMaxAgeSec).toBe(
      31536000,
    );
    expect(security.ContentSecurityPolicy.ContentSecurityPolicy).toBe(
      buildAdminContentSecurityPolicy(),
    );
  });

  it("CSP에 외부 스크립트·분석 도구가 없고, 연결은 자기 주소와 Cognito뿐이다", () => {
    const csp = buildAdminContentSecurityPolicy();
    expect(csp).not.toMatch(/googletagmanager|google-analytics|openfreemap/);
    expect(csp).toContain("script-src 'self' 'unsafe-inline';");
    expect(csp).toContain(`connect-src 'self' ${COGNITO_ENDPOINT};`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});

describe("운영자 사이트 E2E 정적 서버", () => {
  it("CSP·검색 차단 헤더가 CloudFront 헤더 정책과 같다(로컬 E2E가 실제 헤더로 검사되게)", async () => {
    const { ADMIN_CSP, ADMIN_HEADERS } =
      await // @ts-expect-error - static-server.mjs는 E2E용 JS 모듈이라 타입 선언 파일이 없음
      import("../../apps/admin/e2e/static-server.mjs");
    expect(ADMIN_CSP).toBe(buildAdminContentSecurityPolicy());
    expect(ADMIN_HEADERS["x-robots-tag"]).toBe(ADMIN_ROBOTS_TAG);
  });
});

describe("배포 역할 (GitHub Actions)", () => {
  const statements = allIamPolicies()
    .filter((p) => p.roles.some((r) => r.startsWith("DeployRole")))
    .flatMap((p) => p.statements);
  const allowed = (action: string) =>
    statements
      .filter((s) => s.Effect === "Allow" && toList(s.Action).includes(action))
      .flatMap((s) => toList(s.Resource).map(resourceText));

  it("운영자 사이트 버킷에 올리고 그 배포의 캐시를 비울 수 있다", () => {
    expect(allowed("s3:PutObject")).toContain(`${bucketId}.Arn/*`);
    expect(allowed("s3:ListBucket")).toContain(`${bucketId}.Arn`);
    expect(
      allowed("cloudfront:CreateInvalidation").some((r) =>
        r.includes(distributionId),
      ),
    ).toBe(true);
  });
});
