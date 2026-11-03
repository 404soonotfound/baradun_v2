import { Duration, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "node:path";
import { LOG_RETENTION, RETRY_LIMITS } from "../settings";
import type { OperatorAuth } from "./operator-auth";

// 운영 API 단일 함수 /ops/* (BRD-146, 결정 기록 D16-B1·B2·E4, 아키텍처 18.3)
// - 코드는 services/src/admin. 문의 접수 함수와 역할을 나눔
// - 함수 URL은 IAM 인증(AWS_IAM)이라 서명 없는 요청은 Lambda 앞에서 막힘
//   관리자 사이트 CloudFront + OAC에 /ops/* 동작으로 연결하는 일은 관리자 배포(BRD-147)에서 함
//   → 그 전까지 이 함수 URL을 부를 수 있는 곳이 없음
// - 역할 권한은 Ops 테이블 항목 읽기·쓰기만. State·Inquiry 테이블과 판단 상태(status)는 건드리지 않음(G1)
//   트랜잭션(TransactWriteItems)은 품목별 동작(PutItem·UpdateItem)으로 판정됨
// - 토큰 검증 공개 키(JWKS)는 Cognito 공개 주소에서 받음(키·비밀값 없음)

export interface OpsApiProps {
  readonly opsTable: dynamodb.ITable;
  readonly auth: OperatorAuth;
}

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const HANDLER_FILE = path.join(REPO_ROOT, "services/src/admin/handler.ts");

export class OpsApi extends Construct {
  readonly function: nodejs.NodejsFunction;
  readonly functionUrl: lambda.FunctionUrl;
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: OpsApiProps) {
    super(scope, id);

    this.role = new iam.Role(this, "Role", {
      roleName: `${Stack.of(this).stackName}-OpsApiRole`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Operator console API Lambda role",
    });
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ],
        resources: [props.opsTable.tableArn],
      }),
    );

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: LOG_RETENTION,
    });
    logGroup.grant(this.role, "logs:CreateLogStream", "logs:PutLogEvents");

    this.function = new nodejs.NodejsFunction(this, "Function", {
      entry: HANDLER_FILE,
      handler: "opsHandler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup,
      role: this.role,
      description: "baradun v2 operator console API",
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, "package-lock.json"),
      bundling: { externalModules: [], target: "node22" },
      environment: {
        OPS_TABLE_NAME: props.opsTable.tableName,
        OPERATOR_USER_POOL_ID: props.auth.userPool.userPoolId,
        OPERATOR_CLIENT_ID: props.auth.client.userPoolClientId,
        SAMPLE_USER_POOL_ID: props.auth.samplePool.userPoolId,
        SAMPLE_CLIENT_ID: props.auth.sampleClient.userPoolClientId,
      },
    });
    // 함수 URL로만 부름(동기). 비동기 호출 재시도는 막아 둠(11장 재시도 제한)
    this.function.configureAsyncInvoke({
      retryAttempts: 0,
      maxEventAge: Duration.seconds(RETRY_LIMITS.asyncMaxEventAgeSeconds),
    });

    this.functionUrl = this.function.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });
  }
}
