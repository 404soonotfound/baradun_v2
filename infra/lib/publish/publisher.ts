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
  LOG_RETENTION,
  PUBLISHER_MEMORY_MB,
  PUBLISHER_TIMEOUT_SECONDS,
  RETRY_LIMITS,
} from "../settings";

// publish-snapshot Lambda (아키텍처 6.2, BRD-61 PR ②)
// State를 읽어 해변 상태를 한 번 계산하고 S3 data/에 버전 경로 → manifest 순서로 올림
// 실행 일정은 따로 없음: 수집기 3개가 수집을 마칠 때마다 비동기로 깨움(collect/collectors.ts)
// 역할은 PublisherRole(data/ 쓰기를 가진 유일한 역할, BRD-52)

export interface PublisherProps {
  readonly bucket: s3.IBucket;
  readonly stateTable: dynamodb.ITable;
  readonly opsTable: dynamodb.ITable;
  // PublisherRole(BRD-52). 스택에서 이미 만든 역할을 그대로 씀(논리 ID 유지 → 배포 때 역할을 새로 만들지 않음)
  readonly role: iam.Role;
}

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const HANDLER_FILE = path.join(REPO_ROOT, "services/src/publisher/handler.ts");

// 비동기 호출이 실패해도 AWS가 다시 부르지 않음
// 다음 수집(15분 안)이 다시 깨우고, 그때 최신 State로 게시함 → 지난 호출을 다시 돌릴 이유가 없음
const ASYNC_RETRIES = 0;

export class Publisher extends Construct {
  readonly function: nodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: PublisherProps) {
    super(scope, id);

    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: LOG_RETENTION,
    });
    logGroup.grant(props.role, "logs:CreateLogStream", "logs:PutLogEvents");

    this.function = new nodejs.NodejsFunction(this, "Function", {
      entry: HANDLER_FILE,
      handler: "publishHandler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: PUBLISHER_MEMORY_MB,
      timeout: Duration.seconds(PUBLISHER_TIMEOUT_SECONDS),
      logGroup,
      role: props.role,
      description: "baradun v2 publish-snapshot (6.2)",
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, "package-lock.json"),
      bundling: {
        externalModules: [],
        target: "node22",
        // 해변 파일(data/beaches/b*.json)을 함수 폴더 beaches/로 복사함. 핸들러가 실행 때 읽음
        // 별표 구역표·운영 기간은 JSON import로 묶이므로 복사하지 않음
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
        OPS_TABLE_NAME: props.opsTable.tableName,
      },
    });

    this.function.configureAsyncInvoke({
      retryAttempts: ASYNC_RETRIES,
      maxEventAge: Duration.seconds(RETRY_LIMITS.asyncMaxEventAgeSeconds),
    });
  }
}
