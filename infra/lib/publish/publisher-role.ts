import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { DATA_PREFIX } from "../settings";

export interface PublisherRoleProps {
  readonly bucket: s3.IBucket;
  // 게시 판단에 읽는 사실 (읽기만)
  readonly stateTable: dynamodb.ITable;
  // 슬롯 기록·게시 잠금·게시 버전 (읽기·쓰기)
  readonly opsTable: dynamodb.ITable;
}

// publish-snapshot Lambda가 쓸 역할. data/ 쓰기는 이 역할만 가짐 (BRD-52, 6.2 단일 작성자).
// State 읽기·Ops 잠금과 게시 버전 읽기·쓰기도 가짐 (BRD-55).
// 함수는 BRD-61에서 만들고 이 역할을 붙임.
export class PublisherRole extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: PublisherRoleProps) {
    super(scope, id);

    this.role = new iam.Role(this, "Role", {
      // Lambda 서비스만 이 역할을 쓸 수 있음
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

    // 보존 개수(최근 48개)를 세려면 목록이 필요함. 목록도 data/ 아래만
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [props.bucket.bucketArn],
        conditions: { StringLike: { "s3:prefix": [`${DATA_PREFIX}*`] } },
      }),
    );

    // DynamoDB 권한은 동작을 하나씩 적음 (BRD-55 최소 권한)
    // table.grantReadData()는 Scan·ConditionCheckItem·DescribeTable까지 줌 → 쓰지 않음
    // 테이블 ARN만 줌. GSI가 없어서 index/* 주소는 필요 없음
    // Scan·테이블 관리(Create/Delete/UpdateTable 등)·Inquiry 권한은 없음

    // State 읽기: 키 하나(GetItem), pk 아래 목록(Query), 여러 키 한 번에(BatchGetItem)
    // State 쓰기는 수집기 역할(BRD-56)이 가짐
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:BatchGetItem",
        ],
        resources: [props.stateTable.tableArn],
      }),
    );

    // Ops 잠금·슬롯 기록·게시 버전. 조건부 쓰기(ConditionExpression)는 같은 동작 권한으로 됨
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
        ],
        resources: [props.opsTable.tableArn],
      }),
    );
  }
}
