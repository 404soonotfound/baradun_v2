import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import * as path from "node:path";
import { LOG_RETENTION, RETRY_LIMITS } from "../settings";
import { InquiryRole } from "./inquiry-role";
import { inquiryRequestGuardCode } from "./request-guard";

export interface InquiryBackendProps {
  readonly table: dynamodb.ITable;
  readonly distribution: cloudfront.Distribution;
  readonly notificationEmail: string;
}

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const HANDLER_FILE = path.join(REPO_ROOT, "services/src/inquiry/handler.ts");

export class InquiryBackend extends Construct {
  readonly function: nodejs.NodejsFunction;
  readonly photoBucket: s3.Bucket;
  readonly topic: sns.Topic;

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
    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: LOG_RETENTION,
    });
    logGroup.grant(role.role, "logs:CreateLogStream", "logs:PutLogEvents");

    this.function = new nodejs.NodejsFunction(this, "Function", {
      entry: HANDLER_FILE,
      handler: "inquiryHandler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      logGroup,
      role: role.role,
      description: "baradun v2 data inquiry intake",
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, "package-lock.json"),
      bundling: { externalModules: [], target: "node22" },
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

    const functionUrl = this.function.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });
    const origin = origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl);
    const requestGuard = new cloudfront.Function(this, "RequestGuard", {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(inquiryRequestGuardCode),
      comment: "Reject malformed inquiry requests before origin",
    });
    const originRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      "OriginRequestPolicy",
      {
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
          "content-type",
          "content-length",
          "x-amz-content-sha256",
        ),
      },
    );

    props.distribution.addBehavior("api/inquiries*", origin, {
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      functionAssociations: [
        {
          function: requestGuard,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        },
      ],
    });
  }
}
