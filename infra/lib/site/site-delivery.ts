import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { rewriteIndexCode } from "./rewrite-index";

export interface SiteDeliveryProps {
  // CloudFront 정액 요금제가 붙인 WAF web ACL의 ARN (us-east-1). 없으면 비워 둠.
  // 요금제를 쓰는 배포에서 web ACL을 떼면 안 돼서, 구독 뒤에는 꼭 넘겨야 함.
  readonly webAclId?: string;
  // CloudFront 보안 응답 헤더 정책 (CSP·HSTS·nosniff 등, BRD-118)
  readonly responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;
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
    });

    // 폴더 주소를 index.html로 바꾸는 함수 (정액 Free 요금제에 포함된 기능)
    const rewriteIndex = new cloudfront.Function(this, "RewriteIndex", {
      code: cloudfront.FunctionCode.fromInline(rewriteIndexCode),
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
  }
}
