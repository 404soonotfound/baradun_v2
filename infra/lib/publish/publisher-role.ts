import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { DATA_PREFIX } from "../settings";

export interface PublisherRoleProps {
  readonly bucket: s3.IBucket;
}

// publish-snapshot Lambda가 쓸 역할. data/ 쓰기는 이 역할만 가져요 (BRD-52, 6.2 단일 작성자).
// 함수는 BRD-61에서 만들고 이 역할을 붙여요.
export class PublisherRole extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: PublisherRoleProps) {
    super(scope, id);

    this.role = new iam.Role(this, "Role", {
      // Lambda 서비스만 이 역할을 쓸 수 있어요
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "publish-snapshot: write data/ snapshots and manifest only",
    });

    // 스냅샷·manifest 올리기, 오래된 스냅샷 지우기, 롤백용 읽기 (data/ 아래만)
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [props.bucket.arnForObjects(`${DATA_PREFIX}*`)],
      }),
    );

    // 보존 개수(최근 48개)를 세려면 목록이 필요해요. 목록도 data/ 아래만
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [props.bucket.bucketArn],
        conditions: { StringLike: { "s3:prefix": [`${DATA_PREFIX}*`] } },
      }),
    );
  }
}
