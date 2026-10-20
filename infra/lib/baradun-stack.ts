import {
  Aws,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  Fn,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { GitHubDeployRole } from "./deploy/github-deploy-role";
import { CostBudget } from "./ops/cost-budget";
import { PublisherRole } from "./publish/publisher-role";
import { SiteDelivery } from "./site/site-delivery";
import { StorageTables } from "./storage/tables";

// 바라던 바다 V2 인프라 스택. 기능 묶음(사이트 전달, 수집, 게시…)을 여기에 하나씩 붙임.
export class BaradunStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // 배포할 때 넘기는 값 (저장소에 남기지 않음). 한 번 넘기면 다음 배포부터는
    // CloudFormation이 이전 값을 그대로 씀.
    const alertEmail = new CfnParameter(this, "AlertEmail", {
      type: "String",
      allowedPattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
      description: "Budget and alarm notification email",
    });
    const siteWebAclArn = new CfnParameter(this, "SiteWebAclArn", {
      type: "String",
      default: "",
      allowedPattern: "^$|^arn:aws:wafv2:us-east-1:[0-9]{12}:global/webacl/.+$",
      description:
        "WAF web ACL ARN attached by the CloudFront flat-rate plan (empty before subscribing)",
    });
    const hasSiteWebAcl = new CfnCondition(this, "HasSiteWebAcl", {
      expression: Fn.conditionNot(
        Fn.conditionEquals(siteWebAclArn.valueAsString, ""),
      ),
    });

    const site = new SiteDelivery(this, "Site", {
      // 값이 있으면 그 web ACL을 붙이고, 비어 있으면 속성 자체를 뺌.
      webAclId: Fn.conditionIf(
        hasSiteWebAcl.logicalId,
        siteWebAclArn.valueAsString,
        Aws.NO_VALUE,
      ).toString(),
    });

    // State·Ops·Inquiry 테이블 (BRD-55)
    const tables = new StorageTables(this, "Storage");

    // data/ 쓰기 전용 역할 (BRD-61의 publish-snapshot이 사용)
    new PublisherRole(this, "Publisher", {
      bucket: site.bucket,
      stateTable: tables.state,
      opsTable: tables.ops,
    });

    // 사이트 경로 쓰기 전용 역할 (GitHub Actions OIDC)
    const deploy = new GitHubDeployRole(this, "Deploy", {
      bucket: site.bucket,
      distribution: site.distribution,
    });

    // 월 $1 예산 알림 (콘솔의 Zero-Spend 예산을 대신함)
    new CostBudget(this, "Budget", { email: alertEmail.valueAsString });

    // 배포 후 콘솔·터미널에서 바로 확인할 값
    new CfnOutput(this, "SiteBucketName", { value: site.bucket.bucketName });
    new CfnOutput(this, "DistributionDomainName", {
      value: site.distribution.distributionDomainName,
    });
    // GitHub 배포 워크플로가 쓰는 값 (비밀값 아님, GitHub Variables에 넣음)
    new CfnOutput(this, "DistributionId", {
      value: site.distribution.distributionId,
    });
    new CfnOutput(this, "DeployRoleArn", { value: deploy.role.roleArn });
    // 테이블 이름은 CDK가 붙임. Lambda 환경 변수와 운영 확인(AWS CLI)에 씀
    new CfnOutput(this, "StateTableName", { value: tables.state.tableName });
    new CfnOutput(this, "OpsTableName", { value: tables.ops.tableName });
    new CfnOutput(this, "InquiryTableName", {
      value: tables.inquiry.tableName,
    });
  }
}
