import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { GitHubDeployRole } from "./deploy/github-deploy-role";
import { PublisherRole } from "./publish/publisher-role";
import { SiteDelivery } from "./site/site-delivery";

// 바라던 바다 V2 인프라 스택. 기능 묶음(사이트 전달, 수집, 게시…)을 여기에 하나씩 붙여요.
export class BaradunStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const site = new SiteDelivery(this, "Site");

    // data/ 쓰기 전용 역할 (BRD-61의 publish-snapshot이 사용)
    new PublisherRole(this, "Publisher", { bucket: site.bucket });

    // 사이트 경로 쓰기 전용 역할 (GitHub Actions OIDC)
    const deploy = new GitHubDeployRole(this, "Deploy", {
      bucket: site.bucket,
      distribution: site.distribution,
    });

    // 배포 후 콘솔·터미널에서 바로 확인할 값
    new CfnOutput(this, "SiteBucketName", { value: site.bucket.bucketName });
    new CfnOutput(this, "DistributionDomainName", {
      value: site.distribution.distributionDomainName,
    });
    // GitHub 배포 워크플로가 쓰는 값 (비밀값 아님, GitHub Variables에 넣어요)
    new CfnOutput(this, "DistributionId", {
      value: site.distribution.distributionId,
    });
    new CfnOutput(this, "DeployRoleArn", { value: deploy.role.roleArn });
  }
}
