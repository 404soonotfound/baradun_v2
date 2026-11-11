import { ArnFormat, Duration, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import * as path from "node:path";
import {
  API_KEY_NAMES,
  apiKeyParameterName,
  INQUIRY_STATUS_INDEX,
  LOG_RETENTION,
  NOTICE_KEY,
  PUBLISH_SUMMARY_KEY,
  RETRY_LIMITS,
  RUN_LOG_KEY_PREFIX,
} from "../settings";
import type { OperatorAuth } from "./operator-auth";

// 운영 API 단일 함수 /ops/* (BRD-146, 결정 기록 D16-B1·B2·E4, 아키텍처 18.3)
// - 코드는 services/src/admin. 문의 접수 함수와 역할을 나눔
// - 함수 URL은 IAM 인증(AWS_IAM)이라 서명 없는 요청은 Lambda 앞에서 막힘
//   관리자 사이트 CloudFront + OAC에 /ops/* 동작으로 연결하는 일은 관리자 배포(BRD-147)에서 함
//   → 그 전까지 이 함수 URL을 부를 수 있는 곳이 없음
// - 역할 권한은 Ops 테이블 항목 읽기·쓰기와 문의 항목 읽기·처리 상태 바꾸기·목록 GSI 조회만
//   State 테이블과 판단 상태(status)는 건드리지 않음(G1). 문의를 만들거나 지우지 않음
//   트랜잭션(TransactWriteItems)은 품목별 동작(PutItem·UpdateItem)으로 판정됨
// - 변경 이력(감사, BRD-155·D16-B5): Ops admin#audit#… 키에 Put만. 바꾸기·지우기는 명시적으로 거부
//   추가 전용은 Put 권한만으로는 성립하지 않음 → 코드가 새 키에만 씀(attribute_not_exists)·업무 변경과 같은 트랜잭션
//   Ops Query는 감사 키(월 파티션)·공지 파티션·수집 실행 기록(BRD-149, 수집기별 파티션)·게시 요약(BRD-187)에만 허용
// - CloudWatch 경보(BRD-187): 이 스택 경보(스택 이름-*)의 설정·상태 변경 기록 읽기만. 구독(받는 주소)·바꾸기 권한 없음
// - 토큰 검증 공개 키(JWKS)는 Cognito 공개 주소에서 받음(키·비밀값 없음)

export interface OpsApiProps {
  readonly opsTable: dynamodb.ITable;
  // 문의 처리 상태·메모(BRD-153). 문의 항목 읽기·바꾸기와 상태 GSI 조회만
  readonly inquiryTable: dynamodb.ITable;
  readonly auth: OperatorAuth;
}

// 감사 기록 파티션 키 모양(services/src/admin/keys.ts AUDIT_PREFIX와 같음)
const AUDIT_KEYS = "admin#audit#*";

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const HANDLER_FILE = path.join(REPO_ROOT, "services/src/admin/handler.ts");

export class OpsApi extends Construct {
  readonly function: nodejs.NodejsFunction;
  readonly functionUrl: lambda.FunctionUrl;
  readonly role: iam.Role;
  readonly logGroup: logs.LogGroup;

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
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [props.opsTable.tableArn],
        conditions: {
          // 키가 없는 요청에 ForAllValues가 참이 되지 않게 Null 검사를 함께 둠
          "ForAllValues:StringLike": {
            "dynamodb:LeadingKeys": [
              AUDIT_KEYS,
              NOTICE_KEY,
              `${RUN_LOG_KEY_PREFIX}*`,
              PUBLISH_SUMMARY_KEY,
            ],
          },
          Null: { "dynamodb:LeadingKeys": "false" },
        },
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ["dynamodb:UpdateItem", "dynamodb:DeleteItem"],
        resources: [props.opsTable.tableArn],
        conditions: {
          "ForAnyValue:StringLike": { "dynamodb:LeadingKeys": [AUDIT_KEYS] },
        },
      }),
    );
    // 수집 현황의 경보 설정·기록(BRD-187). 지표 경보만 경보 ARN으로 좁힘(복합 경보는 * 범위가 필요해 쓰지 않음)
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "cloudwatch:DescribeAlarms",
          "cloudwatch:DescribeAlarmHistory",
        ],
        resources: [
          Stack.of(this).formatArn({
            service: "cloudwatch",
            resource: "alarm",
            resourceName: `${Stack.of(this).stackName}-*`,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
    // 데이터 출처의 인증키 등록 여부·만료일(ADM-SRC). 태그만 읽음(값을 돌려주는 ssm:GetParameter는 주지 않음)
    // 키 파라미터 두 개로만 좁힘. 파라미터가 없으면 InvalidResourceId → 화면은 '등록 안 됨'
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:ListTagsForResource"],
        resources: API_KEY_NAMES.map((name) =>
          Stack.of(this).formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: apiKeyParameterName(name).slice(1),
          }),
        ),
      }),
    );
    // 문의: 상세 읽기·처리 상태 바꾸기(트랜잭션 Update)·목록 GSI 조회. 만들기·지우기·Scan은 없음
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [props.inquiryTable.tableArn],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query"],
        resources: [
          `${props.inquiryTable.tableArn}/index/${INQUIRY_STATUS_INDEX.name}`,
        ],
      }),
    );

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: LOG_RETENTION,
    });
    this.logGroup = logGroup;
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
        INQUIRY_TABLE_NAME: props.inquiryTable.tableName,
        OPERATOR_USER_POOL_ID: props.auth.userPool.userPoolId,
        OPERATOR_CLIENT_ID: props.auth.client.userPoolClientId,
        SAMPLE_USER_POOL_ID: props.auth.samplePool.userPoolId,
        SAMPLE_CLIENT_ID: props.auth.sampleClient.userPoolClientId,
        // 경보 이름 접두어(infra/lib/ops/alarms.ts alarmName = 스택 이름-경보 ID)
        OPS_ALARM_PREFIX: `${Stack.of(this).stackName}-`,
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
