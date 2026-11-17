import {
  Aws,
  type CfnCondition,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  Tags,
} from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import {
  CANONICAL_HOST_PLACEHOLDER,
  rewriteIndexCode,
} from "../site/rewrite-index";

// 운영자 사이트 전달 (BRD-147, 아키텍처 18.7, 10/20 결정 2안 별도 사이트)
// - 사용자 사이트와 버킷·CloudFront를 나눔(주소·캐시·헤더가 섞이지 않게). WAF·IP 제한 없음(18.7 Free 플랜)
// - /ops/*는 운영 API 함수 URL(AWS_IAM)로 보냄. CloudFront가 OAC로 서명하므로 함수 URL을 직접 부를 수 없음
// - 화면 파일에는 데이터가 없음. 데이터는 로그인 뒤 /ops/*로만
// - 대체 도메인은 스택 매개변수(AdminSiteDomainName·AdminSiteCertificateArn)로 붙임(GH-341). 비우면 CloudFront 기본 주소만 씀
//   기본 주소도 계속 열어 둠(이동 없음). 검색 노출 차단이라 대표 주소를 하나로 모을 까닭이 없음

// Cognito 사용자 풀 엔드포인트. 로그인 화면(BRD-148)이 SRP 로그인·토큰 갱신을 브라우저에서 직접 부름
export const COGNITO_ENDPOINT =
  "https://cognito-idp.ap-northeast-2.amazonaws.com";

// 운영자 사이트 CSP. 외부 스크립트·분석 도구 없음(공개 웹의 GA·지도 출처를 넣지 않음)
// 인라인 스크립트는 페이지 meta CSP의 해시만 실행됨(apps/admin/scripts/check-out.mts)
export function buildAdminContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    `connect-src 'self' ${COGNITO_ENDPOINT}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// 검색 노출 차단 응답 헤더(18.7). 페이지 meta·robots.txt와 함께 막음
export const ADMIN_ROBOTS_TAG = "noindex, nofollow, noarchive";

export interface AdminSiteProps {
  // 운영 API 함수 URL(AWS_IAM). /ops/*의 원본
  readonly opsFunctionUrl: lambda.IFunctionUrl;
  // 대체 도메인. condition이 참일 때만 도메인·인증서(us-east-1 ACM)를 붙임
  readonly domain?: {
    readonly name: string;
    readonly certificateArn: string;
    readonly condition: CfnCondition;
  };
}

export class AdminSite extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: AdminSiteProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, "Bucket", {
      // 읽기는 CloudFront(OAC)만
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // 화면 파일만 있어 다시 올리면 되지만, 사용자 사이트 버킷과 같게 스택을 지워도 남김
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // 폴더 주소를 index.html로 바꿈. 대표 주소 이동은 쓰지 않음(대체 도메인을 붙여도 기본 주소를 그대로 엶)
    const rewriteIndex = new cloudfront.Function(this, "RewriteIndex", {
      code: cloudfront.FunctionCode.fromInline(
        rewriteIndexCode.split(CANONICAL_HOST_PLACEHOLDER).join(""),
      ),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: "Admin site: rewrite folder paths to index.html",
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, "Headers", {
      comment: "Admin site security headers (noindex)",
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: buildAdminContentSecurityPolicy(),
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: false,
          preload: false,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        // 운영 화면 주소(문의 ID 등)를 다른 사이트에 넘기지 않음
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: "X-Robots-Tag", value: ADMIN_ROBOTS_TAG, override: true },
          {
            header: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
            override: true,
          },
        ],
      },
    });

    const siteOrigin = origins.S3BucketOrigin.withOriginAccessControl(
      this.bucket,
    );
    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "baradun v2 operator console",
      defaultRootObject: "index.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: siteOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        // 파일의 Cache-Control을 따름(배포 때 해시 파일 1년, HTML은 매번 확인)
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: rewriteIndex,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      additionalBehaviors: {
        // 운영 API: 캐시 없음, 모든 method. Host만 빼고 뷰어 헤더를 넘김(OAC 서명은 함수 URL 주소로 해야 함)
        // 쓰기 요청은 화면이 본문 해시(x-amz-content-sha256)를 함께 보내야 OAC 서명이 통과함(문의 API와 같음)
        "ops/*": {
          origin: origins.FunctionUrlOrigin.withOriginAccessControl(
            props.opsFunctionUrl,
          ),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
        // 배포 표지는 현재 확인값으로 읽으므로 CloudFront 캐시를 끔.
        "deploy-version.txt": {
          origin: siteOrigin,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: headers,
        },
      },
      // 오류 응답 바꾸기(403→404 페이지)는 두지 않음: 배포 전체에 걸려 운영 API의 401·403·404 JSON까지
      // HTML로 바뀌어 화면이 오류 이유를 읽지 못함. 없는 화면 주소는 S3의 403이 그대로 보임
    });

    // 대체 도메인: 값이 있을 때만 도메인·인증서를 붙이고, 없으면 두 속성을 빼서 지금과 같게 둠(사용자 사이트와 같음)
    // SNI(전용 IP 요금 없음) · TLS 1.2 이상(TLSv1.2_2021)
    if (props.domain) {
      const { name, certificateArn, condition } = props.domain;
      const cfn = this.distribution.node
        .defaultChild as cloudfront.CfnDistribution;
      cfn.addPropertyOverride(
        "DistributionConfig.Aliases",
        Fn.conditionIf(condition.logicalId, [name], Aws.NO_VALUE),
      );
      cfn.addPropertyOverride(
        "DistributionConfig.ViewerCertificate",
        Fn.conditionIf(
          condition.logicalId,
          {
            AcmCertificateArn: certificateArn,
            SslSupportMethod: "sni-only",
            MinimumProtocolVersion: "TLSv1.2_2021",
          },
          Aws.NO_VALUE,
        ),
      );
    }

    // CloudFront는 CFN 시스템 태그를 지원하지 않으므로 사용자 태그를 명시함(사이트 배포와 같음)
    Tags.of(this.distribution).add("baradun:stack", Stack.of(this).stackName);
  }
}
