import { Duration } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { DATA_PREFIX, GITHUB_OIDC_SUBJECT } from "../settings";

const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";

export interface GitHubDeployRoleProps {
  readonly bucket: s3.IBucket;
  readonly distribution: cloudfront.IDistribution;
}

// GitHub Actions가 장기 키 없이 사이트 파일을 올리는 역할 (OIDC, 11장)
// 사이트 경로만 쓰고 data/는 건드리지 못함. 인프라 배포(cdk deploy) 권한은 없음.
export class GitHubDeployRole extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: GitHubDeployRoleProps) {
    super(scope, id);

    // GitHub가 발급한 토큰을 AWS가 믿게 하는 등록 정보 (계정에 주소당 하나)
    // Native: CloudFormation 기본 리소스라 별도 Lambda를 만들지 않음
    const provider = new iam.OidcProviderNative(this, "GitHubOidc", {
      url: `https://${GITHUB_OIDC_HOST}`,
      clientIds: ["sts.amazonaws.com"],
    });

    this.role = new iam.Role(this, "Role", {
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        // 와일드카드 없이 정확히 같을 때만 (StringEquals)
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: "sts.amazonaws.com",
          [`${GITHUB_OIDC_HOST}:sub`]: GITHUB_OIDC_SUBJECT,
        },
      }),
      description: "GitHub Actions site deploy (production environment only)",
      maxSessionDuration: Duration.hours(1),
    });

    // 사이트 파일 올리기·지우기 (aws s3 sync --delete)
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:DeleteObject"],
        resources: [props.bucket.arnForObjects("*")],
      }),
    );

    // data/는 명시적으로 거부. 거부는 허용보다 항상 우선함 (sync에서 빠뜨려도 안전)
    this.role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ["s3:PutObject", "s3:DeleteObject"],
        resources: [props.bucket.arnForObjects(`${DATA_PREFIX}*`)],
      }),
    );

    // sync가 올릴 파일을 고르려면 버킷 목록이 필요함
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [props.bucket.bucketArn],
      }),
    );

    // 새 사이트 파일이 바로 보이게 캐시 비우기 (이 배포 하나만)
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudfront:CreateInvalidation"],
        resources: [props.distribution.distributionArn],
      }),
    );
  }
}
