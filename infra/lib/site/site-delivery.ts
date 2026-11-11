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
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { CANONICAL_HOST_PLACEHOLDER, rewriteIndexCode } from "./rewrite-index";

export interface SiteDeliveryProps {
  // CloudFront 정액 요금제가 붙인 WAF web ACL의 ARN (us-east-1). 없으면 비워 둠.
  // 요금제를 쓰는 배포에서 web ACL을 떼면 안 돼서, 구독 뒤에는 꼭 넘겨야 함.
  readonly webAclId?: string;
  // CloudFront 보안 응답 헤더 정책 (CSP·HSTS·nosniff 등, BRD-118)
  readonly responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;
  // 대표 주소(BRD-162). 배포 때 넘기는 매개변수라 값이 비어 있을 수 있음 → condition이 참일 때만 붙임
  // name: 대체 도메인(예: www.baradun.app), certificateArn: us-east-1 ACM 인증서
  readonly siteDomain?: {
    readonly name: string;
    readonly certificateArn: string;
    readonly condition: CfnCondition;
  };
}

// 사이트 전달: S3 버킷 하나(사이트 파일 + data/ 스냅샷, BRD-52) + CloudFront 하나(G3)
// 쓰기 권한: data/는 PublisherRole, 사이트 경로는 GitHubDeployRole만 가짐.
export class SiteDelivery extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: SiteDeliveryProps = {}) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, "Bucket", {
      // 인터넷에 직접 공개하지 않음. 읽기는 CloudFront(OAC)만 (11장)
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // https가 아닌 요청은 거부
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // 스택을 지워도 버킷과 스냅샷은 남김 (실수로 데이터가 사라지지 않게)
      removalPolicy: RemovalPolicy.RETAIN,
      // 지도 파일(수백 MB)을 여러 조각으로 올리다 끊기면 보이지 않는 조각에 요금이 붙음 → 1일 뒤 지움(결정 기록 D19-1)
      lifecycleRules: [
        {
          id: "AbortIncompleteUploads",
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    const [functionCodeBefore = "", functionCodeAfter = ""] =
      rewriteIndexCode.split(CANONICAL_HOST_PLACEHOLDER);

    // 폴더 주소를 index.html로 바꾸는 함수 (정액 Free 요금제에 포함된 기능)
    const rewriteIndex = new cloudfront.Function(this, "RewriteIndex", {
      // 대표 주소 자리에 도메인 값을 끼움(비어 있으면 이동 없음)
      code: cloudfront.FunctionCode.fromInline(
        // Fn::Join 구분자에는 매개변수를 쓸 수 없어 앞뒤 조각 사이에 끼움
        Fn.join("", [
          functionCodeBefore,
          props.siteDomain?.name ?? "",
          functionCodeAfter,
        ]),
      ),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: "Rewrite folder paths to index.html",
    });

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "baradun v2 site and data snapshots",
      defaultRootObject: "index.html",
      webAclId: props.webAclId,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        // OAC: CloudFront만 버킷을 읽을 수 있게 하는 서명 방식 (OAI는 정액 요금제 미지원)
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: props.responseHeadersPolicy,
        // AWS 기본 정책: 파일의 Cache-Control 헤더를 따름.
        // 정액 Free는 직접 만든 캐시 정책을 못 써서, manifest 60초·버전 경로 불변은
        // publisher가 올릴 때 붙이는 Cache-Control로 정함 (6.2, 11장 제안)
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: rewriteIndex,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      // OAC로 막힌 S3는 없는 파일에 404 대신 403을 줌. 사용자에게는 404 페이지로 보여 줌
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: "/404.html",
          ttl: Duration.minutes(1),
        },
      ],
    });
    // 대표 주소: 도메인 값이 있을 때만 대체 도메인·인증서를 붙이고, 없으면 두 속성을 빼서 지금과 같게 둠
    // SNI(전용 IP 요금 없음) · TLS 1.2 이상(TLSv1.2_2021, CloudFront 권장 정책)
    if (props.siteDomain) {
      const { name, certificateArn, condition } = props.siteDomain;
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

    // CloudFront는 CFN 시스템 태그를 지원하지 않으므로 사용자 태그를 명시함.
    // 기존 배포는 README의 태그 선반영 절차 후 실행 정책을 전환함.
    Tags.of(this.distribution).add("baradun:stack", Stack.of(this).stackName);
  }
}
