import { Duration, RemovalPolicy, TimeZone } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as targets from "aws-cdk-lib/aws-scheduler-targets";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import * as path from "node:path";
import { LOG_RETENTION, RETRY_LIMITS } from "../settings";
import { InquiryRole } from "./inquiry-role";
import { inquiryRequestGuardCode } from "./request-guard";

export interface InquiryBackendProps {
  readonly table: dynamodb.ITable;
  readonly distribution?: cloudfront.Distribution;
  readonly notificationEmail: string;
  readonly responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;
}

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const HANDLER_FILE = path.join(REPO_ROOT, "services/src/inquiry/handler.ts");

// sharp는 네이티브/WASM 바이너리와 패키지 경로를 런타임에 읽으므로 esbuild로 합치지 않고
// Lambda 번들 node_modules에 필요한 런타임 패키지(전이 의존성 포함)를 복사함(BRD-116)
const SHARP_REQUIRED_PACKAGES = [
  "sharp",
  "detect-libc",
  "@emnapi/runtime",
  "tslib",
  "@img/colour",
  "@img/sharp-wasm32",
] as const;
const SHARP_OPTIONAL_PACKAGES = [
  "semver",
  "@img/sharp-linux-arm64",
  "@img/sharp-libvips-linux-arm64",
] as const;

export function sharpBundlingCommand(
  inputDir: string,
  outputDir: string,
): string {
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const inputNm = path.join(${JSON.stringify(inputDir)}, 'node_modules');`,
    `const outputNm = path.join(${JSON.stringify(outputDir)}, 'node_modules');`,
    `const queue = [...${JSON.stringify(SHARP_REQUIRED_PACKAGES)}];`,
    `for (const opt of ${JSON.stringify(SHARP_OPTIONAL_PACKAGES)}) {`,
    "  if (fs.existsSync(path.join(inputNm, opt))) queue.push(opt);",
    "}",
    "const copied = new Set();",
    "while (queue.length > 0) {",
    "  const pkg = queue.shift();",
    "  if (copied.has(pkg)) continue;",
    "  copied.add(pkg);",
    "  const src = path.join(inputNm, pkg);",
    "  if (!fs.existsSync(src)) throw new Error('Missing sharp runtime package: ' + pkg);",
    "  const dst = path.join(outputNm, pkg);",
    "  fs.mkdirSync(path.dirname(dst), { recursive: true });",
    "  fs.cpSync(src, dst, { recursive: true });",
    "  const meta = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));",
    "  for (const dep of Object.keys(meta.dependencies || {})) {",
    "    if (!fs.existsSync(path.join(src, 'node_modules', dep, 'package.json'))) {",
    "      queue.push(dep);",
    "    }",
    "  }",
    "}",
  ].join(" ");
  return `node -e '${script.replace(/'/g, "'\\''")}'`;
}

export class InquiryBackend extends Construct {
  readonly function: nodejs.NodejsFunction;
  readonly logGroup: logs.LogGroup;
  readonly cleanupFailuresQueue: sqs.Queue;
  readonly photoBucket: s3.Bucket;
  readonly topic: sns.Topic;
  readonly functionUrl: lambda.FunctionUrl;
  readonly requestGuard: cloudfront.Function;

  constructor(scope: Construct, id: string, props: InquiryBackendProps) {
    super(scope, id);

    this.photoBucket = new s3.Bucket(this, "Photos", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { expiration: Duration.days(30) },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.POST],
          // CORS는 브라우저 읽기 규칙만 완화함. 업로드 권한은 짧은 presigned POST 정책으로 제한함
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          maxAge: 600,
        },
      ],
    });

    this.topic = new sns.Topic(this, "Topic", {
      displayName: "바라던 바다 데이터 문의",
    });
    this.topic.addSubscription(
      new subscriptions.EmailSubscription(props.notificationEmail),
    );

    const role = new InquiryRole(this, "InquiryRole", {
      table: props.table,
      photoBucket: this.photoBucket,
      topic: this.topic,
    });
    this.logGroup = new logs.LogGroup(this, "Logs", {
      retention: LOG_RETENTION,
    });
    this.logGroup.grant(role.role, "logs:CreateLogStream", "logs:PutLogEvents");

    this.function = new nodejs.NodejsFunction(this, "Function", {
      entry: HANDLER_FILE,
      handler: "inquiryHandler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      logGroup: this.logGroup,
      role: role.role,
      description: "baradun v2 data inquiry intake",
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, "package-lock.json"),
      bundling: {
        externalModules: ["sharp"],
        target: "node22",
        commandHooks: {
          beforeBundling(): string[] {
            return [];
          },
          beforeInstall(): string[] {
            return [];
          },
          afterBundling(inputDir: string, outputDir: string): string[] {
            return [sharpBundlingCommand(inputDir, outputDir)];
          },
        },
      },
      environment: {
        INQUIRY_TABLE_NAME: props.table.tableName,
        PHOTO_BUCKET_NAME: this.photoBucket.bucketName,
        INQUIRY_TOPIC_ARN: this.topic.topicArn,
      },
    });
    this.function.configureAsyncInvoke({
      retryAttempts: 0,
      maxEventAge: Duration.seconds(RETRY_LIMITS.asyncMaxEventAgeSeconds),
    });

    // 하루 1회 기한(88일) 지난 문의 이메일 항목을 명시적으로 삭제함 (BRD-119)
    // 호출·실행·시간 초과 실패 시 Scheduler가 재시도 후 실패 대기열로 보내 경보에 연결됨
    this.cleanupFailuresQueue = new sqs.Queue(this, "EmailCleanupFailures", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });
    new scheduler.Schedule(this, "EmailCleanupSchedule", {
      schedule: scheduler.ScheduleExpression.cron({
        minute: "30",
        hour: "3",
        timeZone: TimeZone.ASIA_SEOUL,
      }),
      target: new targets.LambdaInvoke(this.function, {
        input: scheduler.ScheduleTargetInput.fromObject({
          action: "cleanup_expired_emails",
        }),
        deadLetterQueue: this.cleanupFailuresQueue,
        retryAttempts: RETRY_LIMITS.scheduleMaxRetries,
        maxEventAge: Duration.seconds(RETRY_LIMITS.scheduleMaxEventAgeSeconds),
      }),
      description: "Delete expired inquiry email items daily (88-day retention)",
    });

    this.functionUrl = this.function.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });
    this.requestGuard = new cloudfront.Function(this, "RequestGuard", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(inquiryRequestGuardCode),
      comment: "Reject malformed inquiry requests before origin",
    });

    if (props.distribution) {
      this.attachToDistribution(
        props.distribution,
        props.responseHeadersPolicy,
      );
    }
  }

  // CloudFront 배포에 /api/inquiries* 동작 연결 (BRD-63 · BRD-118 보안 헤더 적용)
  attachToDistribution(
    distribution: cloudfront.Distribution,
    responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy,
  ): void {
    const origin = origins.FunctionUrlOrigin.withOriginAccessControl(
      this.functionUrl,
    );
    distribution.addBehavior("api/inquiries*", origin, {
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      responseHeadersPolicy,
      // x-amz-* 헤더는 CloudFront가 정책 allowlist에 못 넣게 함(실배포 거부, 2026-10-26)
      // → Host만 빼고 모든 뷰어 헤더(content-type·본문 해시 헤더 포함)를 전달하는 관리형 정책 사용
      //   (Host는 OAC 서명이 함수 URL 주소로 해야 해서 전달하면 안 됨)
      originRequestPolicy:
        cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      functionAssociations: [
        {
          function: this.requestGuard,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        },
      ],
    });
  }
}
