import { Duration } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { Construct } from "constructs";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.join(__dirname, "../../..");

// 문의 사진·이메일 받기 설정 단일 출처 (BRD-130, services/src/inquiry/policy.ts)
// 모노레포 패키지 경계를 존중해 소스에서 직접 읽음(infra/test/inquiry.test.ts와 같음)
export function readInquiryContactEnabled(): boolean {
  const policyFile = path.join(REPO_ROOT, "services/src/inquiry/policy.ts");
  const text = readFileSync(policyFile, "utf8");
  const match = /export const INQUIRY_CONTACT_ENABLED = (true|false);/.exec(text);
  if (!match) {
    throw new Error(`${policyFile}에서 INQUIRY_CONTACT_ENABLED를 찾지 못함`);
  }
  return match[1] === "true";
}

export const CSP_MAX_LENGTH = 1783; // CloudFront ResponseHeadersPolicy CSP 길이 한도

export interface CspOptions {
  // 문의 사진 업로드 버킷 이름. 사진 기능이 켜져 있을 때만 connect-src에 포함
  readonly photoBucketName?: string;
  // 사진 업로드 허용 여부 (기본값: readInquiryContactEnabled())
  readonly photoUploadEnabled?: boolean;
}

// CSP 지시어 문자열 생성 (BRD-118)
export function buildContentSecurityPolicy(options: CspOptions = {}): string {
  const photoEnabled = options.photoUploadEnabled ?? readInquiryContactEnabled();
  const connectSources = ["'self'", "https://tiles.openfreemap.org"];

  // 결정 2: 사진 받기 설정이 켜져 있고 버킷 이름이 있을 때만 버킷 origin 추가
  if (photoEnabled && options.photoBucketName) {
    connectSources.push(
      `https://${options.photoBucketName}.s3.ap-northeast-2.amazonaws.com`,
    );
  }

  const directives: string[] = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self'",
    "img-src 'self' blob: https://tiles.openfreemap.org https://tong.visitkorea.or.kr",
    "font-src 'self'",
    `connect-src ${connectSources.join(" ")}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];

  const csp = directives.join("; ");
  if (csp.length > CSP_MAX_LENGTH) {
    throw new Error(
      `CSP 길이가 한도(${CSP_MAX_LENGTH}자)를 초과함: ${csp.length}자`,
    );
  }

  return csp;
}

export interface SecurityHeadersPolicyProps extends CspOptions {
  readonly comment?: string;
}

// CloudFront 보안 응답 헤더 정책 생성 (BRD-118)
// CSP·HSTS 1년·nosniff·X-Frame-Options DENY·Referrer-Policy·Permissions-Policy 적용
export function createSecurityHeadersPolicy(
  scope: Construct,
  id: string,
  props: SecurityHeadersPolicyProps = {},
): cloudfront.ResponseHeadersPolicy {
  return new cloudfront.ResponseHeadersPolicy(scope, id, {
    comment: props.comment ?? "Security response headers for baradun v2",
    securityHeadersBehavior: {
      contentSecurityPolicy: {
        contentSecurityPolicy: buildContentSecurityPolicy(props),
        override: true,
      },
      strictTransportSecurity: {
        accessControlMaxAge: Duration.days(365),
        includeSubdomains: false,
        preload: false,
        override: true,
      },
      contentTypeOptions: {
        override: true,
      },
      frameOptions: {
        frameOption: cloudfront.HeadersFrameOption.DENY,
        override: true,
      },
      referrerPolicy: {
        referrerPolicy:
          cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
        override: true,
      },
    },
    customHeadersBehavior: {
      customHeaders: [
        {
          header: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=(self)",
          override: true,
        },
      ],
    },
  });
}
