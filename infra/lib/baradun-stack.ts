import {
  Aws,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  Fn,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { Collectors } from "./collect/collectors";
import { GitHubDeployRole } from "./deploy/github-deploy-role";
import { InquiryBackend } from "./inquiry/inquiry-backend";
import { CostBudget } from "./ops/cost-budget";
import { OpsAlarms } from "./ops/alarms";
import { Publisher } from "./publish/publisher";
import { PublisherRole } from "./publish/publisher-role";
import { ROLE_BOUNDARY_POLICY_NAME } from "./settings";
import { createSecurityHeadersPolicy } from "./site/security-headers";
import { SiteDelivery } from "./site/site-delivery";
import { StorageTables } from "./storage/tables";

// 바라던 바다 V2 인프라 스택. 기능 묶음(사이트 전달, 수집, 게시…)을 여기에 하나씩 붙임.
export class BaradunStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // 이 스택이 만드는 모든 역할(CDK가 자동으로 만드는 역할 포함)에 권한 상한을 붙임 (BRD-89).
    // 실행 정책은 이 boundary가 없는 역할의 생성·정책 변경을 거부하므로 빠뜨리면 배포가 실패함
    iam.PermissionsBoundary.of(this).apply(
      iam.ManagedPolicy.fromManagedPolicyName(
        this,
        "RoleBoundary",
        ROLE_BOUNDARY_POLICY_NAME,
      ),
    );

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

    // State·Ops·Inquiry 테이블 (BRD-55)
    const tables = new StorageTables(this, "Storage");

    // 데이터 문의 접수 백엔드와 사진 버킷 (BRD-63)
    const inquiry = new InquiryBackend(this, "Inquiry", {
      table: tables.inquiry,
      notificationEmail: alertEmail.valueAsString,
    });

    // CloudFront 보안 응답 헤더 정책 (CSP·HSTS·nosniff·frame-ancestors 등, BRD-118)
    // 사이트 전달과 문의 API 동작 둘 다 같은 보안 헤더 정책을 적용함
    const securityHeaders = createSecurityHeadersPolicy(
      this,
      "SecurityHeaders",
      {
        photoBucketName: inquiry.photoBucket.bucketName,
      },
    );

    const site = new SiteDelivery(this, "Site", {
      // 값이 있으면 그 web ACL을 붙이고, 비어 있으면 속성 자체를 뺌.
      webAclId: Fn.conditionIf(
        hasSiteWebAcl.logicalId,
        siteWebAclArn.valueAsString,
        Aws.NO_VALUE,
      ).toString(),
      responseHeadersPolicy: securityHeaders,
    });

    // 기존 배포의 /api/inquiries* 동작 연결 (보안 헤더 정책 포함)
    inquiry.attachToDistribution(site.distribution, securityHeaders);

    // data/ 쓰기 전용 역할 (BRD-52). 논리 ID(PublisherRole…)를 유지하려고 여기서 만듦
    const publisherRole = new PublisherRole(this, "Publisher", {
      bucket: site.bucket,
      stateTable: tables.state,
      opsTable: tables.ops,
    });

    // publish-snapshot Lambda (BRD-61). 위 역할을 씀
    const publisher = new Publisher(this, "Publish", {
      bucket: site.bucket,
      stateTable: tables.state,
      opsTable: tables.ops,
      role: publisherRole.role,
    });

    // 수집 Lambda 3개와 실행 일정 (BRD-56·BRD-58)
    // 테이블 두 개를 넘겨서 수집기가 그 표를 읽고 쓰게 함. 수집 뒤 publisher를 깨움
    const collectors = new Collectors(this, "Collect", {
      stateTable: tables.state,
      opsTable: tables.ops,
      publisher: publisher.function,
    });

    // 사이트 경로 쓰기 전용 역할 (GitHub Actions OIDC)
    const deploy = new GitHubDeployRole(this, "Deploy", {
      bucket: site.bucket,
      distribution: site.distribution,
    });

    // 운영 경보: 수집 실패·멈춤, 게시 실패·멈춤을 AlertEmail로 알림 (BRD-62)
    new OpsAlarms(this, "Ops", {
      email: alertEmail.valueAsString, // 예산·문의 알림과 같은 주소
      collectors: collectors.functions,
      publisher: publisher.function,
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
    // 웹 빌드가 사진 업로드 주소를 이 버킷 하나로만 허용함(BRD-103). GitHub Variables INQUIRY_PHOTO_BUCKET에 넣음
    new CfnOutput(this, "InquiryPhotoBucketName", {
      value: inquiry.photoBucket.bucketName,
    });
    // 테이블 이름은 CDK가 붙임. Lambda 환경 변수와 운영 확인(AWS CLI)에 씀
    new CfnOutput(this, "StateTableName", { value: tables.state.tableName });
    new CfnOutput(this, "OpsTableName", { value: tables.ops.tableName });
    new CfnOutput(this, "InquiryTableName", {
      value: tables.inquiry.tableName,
    });
    // 수집 함수 이름을 배포 결과에 출력. 배포 뒤 손으로 한 번 실행해 볼 때 씀(aws lambda invoke)
    // 출력 이름 예: OceanCollectorFunctionName
    new CfnOutput(this, "PublisherFunctionName", {
      value: publisher.function.functionName,
    });
    for (const [name, fn] of collectors.functions) {
      new CfnOutput(this, `${name}CollectorFunctionName`, {
        value: fn.functionName,
      });
    }
  }
}
