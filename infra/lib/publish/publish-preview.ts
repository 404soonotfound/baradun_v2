import { Duration } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import * as path from "node:path";
import {
  DATA_PREFIX,
  LOG_RETENTION,
  PREVIEW_TIMEOUT_SECONDS,
  PUBLISHER_MEMORY_MB,
  RETRY_LIMITS,
} from "../settings";

// 게시 변경 미리보기 함수 (#331, 캔버스 N2). 운영 API가 동기 호출로 부름
// - publisher와 같은 코드(services/src/publisher/handler.ts previewHandler)로 '지금 게시' 뒤 해변 분류를 미리 계산
// - publisher 함수와 따로 둔 까닭: 게시 중단 알림(PublishStopped)은 publisher 실행 수, 게시 오류 알림은 publisher 오류 수로
//   판정함 → 미리보기를 publisher로 부르면 수집이 멈춰도 미리보기 호출이 중단 알림을 가리고, 미리보기 실패가 오류 알림을 울림
// - 역할은 읽기만: State 읽기(분류 입력), 게시 버킷 data/ 읽기·목록(지금 게시본). 쓰기·Ops·Inquiry 권한 없음
//   운영 API 역할은 계속 State를 읽지 않음(아키텍처 18.3·결정 기록 D16-B2)
// - 일정·비동기 호출 없음. 이 함수에는 경보를 두지 않음(경보 상한 13, 실패는 운영 API가 '만들지 못함'으로 보여 줌)

export interface PublishPreviewProps {
  readonly bucket: s3.IBucket;
  readonly stateTable: dynamodb.ITable;
}

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const HANDLER_FILE = path.join(REPO_ROOT, "services/src/publisher/handler.ts");

export class PublishPreview extends Construct {
  readonly function: nodejs.NodejsFunction;
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: PublishPreviewProps) {
    super(scope, id);

    this.role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "publish preview: read State and data/ only (no writes)",
    });
    // State 읽기: publisher와 같은 동작(키 하나·pk 목록·여러 키). 쓰기 없음
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
    // 지금 게시본(manifest → status.json) 읽기. 없는 파일 확인용 목록도 data/ 접두어만
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [props.bucket.arnForObjects(`${DATA_PREFIX}*`)],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [props.bucket.bucketArn],
        conditions: { StringLike: { "s3:prefix": [`${DATA_PREFIX}*`] } },
      }),
    );

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: LOG_RETENTION,
    });
    logGroup.grant(this.role, "logs:CreateLogStream", "logs:PutLogEvents");

    this.function = new nodejs.NodejsFunction(this, "Function", {
      entry: HANDLER_FILE,
      handler: "previewHandler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: PUBLISHER_MEMORY_MB,
      timeout: Duration.seconds(PREVIEW_TIMEOUT_SECONDS),
      logGroup,
      role: this.role,
      description: "baradun v2 publish preview (read-only)",
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, "package-lock.json"),
      bundling: {
        externalModules: [],
        target: "node22",
        // publisher와 같게 해변 파일을 함수 폴더 beaches/로 복사함(previewHandler가 읽음)
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir: string, outputDir: string) => [
            `mkdir -p "${outputDir}/beaches"`,
            `cp "${inputDir}"/data/beaches/b*.json "${outputDir}/beaches/"`,
          ],
        },
      },
      environment: {
        SNAPSHOT_BUCKET: props.bucket.bucketName,
        STATE_TABLE_NAME: props.stateTable.tableName,
      },
    });
    // 동기 호출로만 부름. 비동기 호출 재시도는 막아 둠(11장 재시도 제한)
    this.function.configureAsyncInvoke({
      retryAttempts: 0,
      maxEventAge: Duration.seconds(RETRY_LIMITS.asyncMaxEventAgeSeconds),
    });
  }
}
