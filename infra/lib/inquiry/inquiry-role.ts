import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import { Stack } from "aws-cdk-lib";
import { Construct } from "constructs";

export interface InquiryRoleProps {
  readonly table: dynamodb.ITable;
  readonly photoBucket: s3.IBucket;
  readonly topic: sns.ITopic;
}

export class InquiryRole extends Construct {
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: InquiryRoleProps) {
    super(scope, id);

    this.role = new iam.Role(this, "Role", {
      roleName: `${Stack.of(this).stackName}-InquiryRole`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Data inquiry intake Lambda role",
    });

    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:DeleteItem",
          "dynamodb:TransactWriteItems",
          "dynamodb:UpdateItem",
        ],
        resources: [props.table.tableArn],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"],
        resources: [props.photoBucket.arnForObjects("*")],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sns:Publish"],
        resources: [props.topic.topicArn],
      }),
    );
  }
}
