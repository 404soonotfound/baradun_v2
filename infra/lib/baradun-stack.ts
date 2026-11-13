import {
  Aws,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  CfnRule,
  Fn,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import { OperatorAuth } from "./admin/operator-auth";
import { OpsApi } from "./admin/ops-api";
import { Collectors } from "./collect/collectors";
import { GitHubDeployRole } from "./deploy/github-deploy-role";
import { InquiryBackend } from "./inquiry/inquiry-backend";
import { CostBudget } from "./ops/cost-budget";
import { OpsAlarms } from "./ops/alarms";
import { Publisher } from "./publish/publisher";
import { PublisherRole } from "./publish/publisher-role";
import { PublishPreview } from "./publish/publish-preview";
import { ROLE_BOUNDARY_POLICY_NAME } from "./settings";
import { createSecurityHeadersPolicy } from "./site/security-headers";
import { AdminSite } from "./admin/admin-site";
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

    // 대표 주소 (BRD-162). 출시일 전까지 비워 둠 → 지금과 같은 배포(CloudFront 기본 주소만)
    // 값을 넣으면 그 도메인을 대체 도메인으로 붙이고, 다른 호스트로 온 요청은 그 도메인으로 301 이동
    // 인증서는 CloudFront 규칙상 us-east-1 ACM에 미리 만들어 둔 것(DNS 검증 완료)
    const siteDomainName = new CfnParameter(this, "SiteDomainName", {
      type: "String",
      default: "",
      allowedPattern: "^$|^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$",
      description:
        "Canonical site domain such as www.baradun.app (empty keeps the CloudFront default domain only)",
    });
    const siteCertificateArn = new CfnParameter(this, "SiteCertificateArn", {
      type: "String",
      default: "",
      allowedPattern:
        "^$|^arn:aws:acm:us-east-1:[0-9]{12}:certificate/[0-9a-f-]+$",
      description:
        "ACM certificate ARN in us-east-1 covering SiteDomainName (empty when SiteDomainName is empty)",
    });
    const ga4PropertyId = new CfnParameter(this, "Ga4PropertyId", {
      type: "String",
      default: "",
      allowedPattern: "^$|^[0-9]+$",
      description:
        "GA4 property ID for /ops/stats (empty keeps stats unconfigured)",
    });
    const domainEmpty = Fn.conditionEquals(siteDomainName.valueAsString, "");
    const certificateEmpty = Fn.conditionEquals(
      siteCertificateArn.valueAsString,
      "",
    );
    const hasSiteDomain = new CfnCondition(this, "HasSiteDomain", {
      expression: Fn.conditionNot(domainEmpty),
    });
    // 도메인과 인증서는 함께 넣거나 함께 비움. 하나만 있으면 배포를 시작하기 전에 거부함
    new CfnRule(this, "SiteDomainNeedsCertificate", {
      assertions: [
        {
          assert: Fn.conditionOr(
            Fn.conditionAnd(domainEmpty, certificateEmpty),
            Fn.conditionAnd(
              Fn.conditionNot(domainEmpty),
              Fn.conditionNot(certificateEmpty),
            ),
          ),
          assertDescription:
            "SiteDomainName and SiteCertificateArn must be set together or both left empty",
        },
      ],
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
      siteDomain: {
        name: siteDomainName.valueAsString,
        certificateArn: siteCertificateArn.valueAsString,
        condition: hasSiteDomain,
      },
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

    // 게시 변경 미리보기 함수(#331). State·data/ 읽기만, 운영 API가 동기 호출
    const publishPreview = new PublishPreview(this, "PublishPreview", {
      bucket: site.bucket,
      stateTable: tables.state,
    });

    // 수집 Lambda 3개와 실행 일정 (BRD-56·BRD-58)
    // 테이블 두 개를 넘겨서 수집기가 그 표를 읽고 쓰게 함. 수집 뒤 publisher를 깨움
    const collectors = new Collectors(this, "Collect", {
      stateTable: tables.state,
      opsTable: tables.ops,
      publisher: publisher.function,
    });

    // 운영자 풀(MFA 필수)·샘플 풀과 각 앱 클라이언트·권한 그룹 (BRD-145). 계정은 배포 뒤 콘솔·CLI로 초대
    const operatorAuth = new OperatorAuth(this, "OperatorAuth");

    // 운영 API 함수 /ops/* (BRD-146). 함수 URL은 운영자 사이트 배포의 /ops/*로만 부름(OAC)
    const opsApi = new OpsApi(this, "OpsApi", {
      opsTable: tables.ops,
      inquiryTable: tables.inquiry,
      auth: operatorAuth,
      snapshotBucket: site.bucket, // 해변 관리 지금 표시 상태(BRD-150): data/ 읽기·목록만
      publisher: publisher.function, // 지금 게시·되돌리기 작업(#331): 비동기 호출만
      preview: publishPreview.function, // 게시 변경 미리보기(#331): 동기 호출, 읽기 전용 함수
      ga4PropertyId: ga4PropertyId.valueAsString, // 이용 통계(#333): 비어 있으면 미연결
    });

    // 운영자 사이트: 사용자 사이트와 따로 버킷·CloudFront, /ops/*는 운영 API (BRD-147)
    const adminSite = new AdminSite(this, "AdminSite", {
      opsFunctionUrl: opsApi.functionUrl,
    });

    // 사이트 경로 쓰기 전용 역할 (GitHub Actions OIDC)
    const deploy = new GitHubDeployRole(this, "Deploy", {
      bucket: site.bucket,
      distribution: site.distribution,
      admin: { bucket: adminSite.bucket, distribution: adminSite.distribution },
    });

    // 운영 경보: 수집 실패·멈춤, 게시 실패·멈춤을 AlertEmail로 알림 (BRD-62)
    new OpsAlarms(this, "Ops", {
      email: alertEmail.valueAsString, // 예산·문의 알림과 같은 주소
      collectors: collectors.functions,
      publisher: publisher.function,
      opsApi: opsApi.function, // 운영 API 5xx·권한 거부 급증 감시(D17-7)
      opsApiLogGroup: opsApi.logGroup,
      inquiryLogGroup: inquiry.logGroup, // 문의 이메일 기한 초과·정리 실패 감시(BRD-119)
      inquiryCleanupFailuresQueue: inquiry.cleanupFailuresQueue,
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
    // 운영자 사이트 배포 값(BRD-147). GitHub Variables ADMIN_SITE_BUCKET·ADMIN_DISTRIBUTION_ID에 넣음
    new CfnOutput(this, "AdminSiteBucketName", {
      value: adminSite.bucket.bucketName,
    });
    new CfnOutput(this, "AdminDistributionId", {
      value: adminSite.distribution.distributionId,
    });
    new CfnOutput(this, "AdminDistributionDomainName", {
      value: adminSite.distribution.distributionDomainName,
    });
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
    // 관리자 앱 로그인 설정에 넣는 값(비밀값 아님). 실증 절차(infra/README.md)에서도 씀
    new CfnOutput(this, "OperatorUserPoolId", {
      value: operatorAuth.userPool.userPoolId,
    });
    new CfnOutput(this, "OperatorAdminWebClientId", {
      value: operatorAuth.client.userPoolClientId,
    });
    new CfnOutput(this, "SampleUserPoolId", {
      value: operatorAuth.samplePool.userPoolId,
    });
    new CfnOutput(this, "SampleAdminWebClientId", {
      value: operatorAuth.sampleClient.userPoolClientId,
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
