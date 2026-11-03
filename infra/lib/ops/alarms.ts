import { Duration, Stack } from "aws-cdk-lib"; // "5분" 같은 시간 값과 ARN을 만드는 도구
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch"; // 경보(Alarm)
import * as events from "aws-cdk-lib/aws-events"; // 경보 상태 변경 이벤트
import * as eventsTargets from "aws-cdk-lib/aws-events-targets"; // 이벤트가 깨울 Lambda
import * as iam from "aws-cdk-lib/aws-iam"; // Lambda 실행 역할
import * as kms from "aws-cdk-lib/aws-kms"; // SNS 저장 암호화 키
import type * as lambda from "aws-cdk-lib/aws-lambda"; // IFunction 타입만 씀(type import)
import * as lambdaRuntime from "aws-cdk-lib/aws-lambda"; // 알림 변환 Lambda 실행 환경
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs"; // TypeScript Lambda 묶기
import * as logs from "aws-cdk-lib/aws-logs"; // 알림 변환 로그
import * as sns from "aws-cdk-lib/aws-sns"; // 알림 주제
import * as sqs from "aws-cdk-lib/aws-sqs"; // 알림 발송 실패 대기열
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions"; // 이메일 구독
import { Construct } from "constructs";
import * as path from "node:path";
import { LOG_RETENTION, LOGIN_ABUSE_ALARM, RETRY_LIMITS } from "../settings";

// ② 운영 경보 (아키텍처 10장, BRD-62)
// 수집 중단·게시 실패·validUntil 초과(게시 멈춤)를 한국어 SNS 이메일로 알림
// 경보 11개 = 오류 5(수집기 4 + 게시) + 심장박동 4(특보·관측·이안류·게시) + 알림 발송 실패 1
//            + 로그인 반복 요청 1(결정 기록 D17-4)
// settings.ts MAX_ALARMS(11)를 다 씀. 경보를 더 넣으려면 기존 경보를 합치거나 상한을 다시 정해야 함
// catalog는 하루 1회라 심장박동 없이 오류 경보만. 데이터 문의 함수 경보는 두지 않음(BRD-63 결정)

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const NOTIFICATION_HANDLER_FILE = path.join(
  REPO_ROOT,
  "services/src/ops/alarm-notification.ts",
);

// 심장박동 창. CloudWatch 기본 평가는 슬라이딩 창이라 '최근 구간 길이 × 구간 수' 동안 실행이 없으면 울림
// → 마지막 실행 뒤 창 길이만큼 지나면 감지, 정상일 때는 (창 길이 − 실행 간격)까지 지표 지연을 견딤
// 특보·게시: 5분×5 = 25분. 유효시간 45분보다 20분 앞서 감지, 실행 간격 15분이라 지연 10분까지 견딤
// 관측·이안류: 5분×12 = 60분. 관측 유효시간 90분보다 30분 앞서 감지, 실행 간격 30분이라 지연 30분까지 견딤
// 구간은 5분으로 통일함. 창 경계가 어디서 끊기든 실행 시각과의 어긋남이 5분 안에 들어옴
// 15분×1·30분×1은 창 길이 = 실행 간격이라 지표가 1분만 늦어도 울렸음(BRD-167)
export const HEARTBEAT_WINDOWS = {
  Warnings: { periodMinutes: 5, periods: 5 },
  Ocean: { periodMinutes: 5, periods: 12 },
  Rip: { periodMinutes: 5, periods: 12 },
  Publish: { periodMinutes: 5, periods: 5 },
} as const;

// ③ 스택에서 넘겨받는 값
export interface OpsAlarmsProps {
  readonly email: string; // 경보 받을 주소. 배포 파라미터 AlertEmail 재사용
  // 수집기 이름("Ocean"·"Warnings"·"Catalog"·"Rip") → 함수. Collectors가 만든 Map 그대로
  readonly collectors: ReadonlyMap<string, lambda.IFunction>;
  readonly publisher: lambda.IFunction; // publish-snapshot 함수
  // 로그인 반복 요청 감시 대상(운영자·데모 풀의 관리자 앱 클라이언트, D17-4)
  readonly signInClients: readonly {
    readonly userPoolId: string;
    readonly clientId: string;
  }[];
}

// ④ 클래스. 스택에서 new OpsAlarms(...) 한 줄로 아래가 전부 만들어짐
export class OpsAlarms extends Construct {
  // 경보가 직접 게시하지 않게 밖에 공개하지 않음. alias/aws/sns로 암호화한 주제는
  // CloudWatch·EventBridge가 직접 게시할 수 없고, 한국어 변환 Lambda만 게시함
  private readonly topic: sns.Topic;
  private readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: OpsAlarmsProps) {
    super(scope, id); // CDK 규칙: 부모 준비를 맨 먼저

    // 운영 경보 전용 주제. 문의 알림 주제와 분리(메일 보낸 이 이름으로 구분)
    this.topic = new sns.Topic(this, "Topic", {
      displayName: "바라던 바다 운영 경보",
      masterKey: kms.Alias.fromAliasName(this, "TopicKey", "alias/aws/sns"),
    });
    // 배포 뒤 확인 메일의 링크를 눌러야 구독이 활성화됨
    this.topic.addSubscription(
      new subscriptions.EmailSubscription(props.email),
    );

    // Map에서 수집기를 꺼냄. 이름이 틀리면 synth에서 바로 실패(경보가 조용히 빠지지 않게)
    const collector = (name: string): lambda.IFunction => {
      const found = props.collectors.get(name);
      if (!found) throw new Error(`수집기 없음: ${name}`);
      return found;
    };

    // ⑥-1 오류 경보 5개: 함수가 오류로 끝나면 5분 안에 울림
    // 수집기는 partial·failed를 오류로 던지고(finishRun), 게시 실패도 오류로 던짐(publisher/handler.ts)
    // 이안류 비수기 실행은 skipped(정상)로 끝나므로 오류가 아님
    this.errorAlarm(
      "WarningsErrors",
      collector("Warnings"),
      "특보 수집 실패. 사유는 CloudWatch 로그의 reason",
    );
    this.errorAlarm(
      "OceanErrors",
      collector("Ocean"),
      "바다 관측 수집 실패. 사유는 CloudWatch 로그의 reason",
    );
    this.errorAlarm(
      "CatalogErrors",
      collector("Catalog"),
      "사진 확인 수집 실패(하루 1회). 사유는 CloudWatch 로그",
    );
    this.errorAlarm(
      "RipErrors",
      collector("Rip"),
      "이안류 수집 실패. 사유는 CloudWatch 로그의 reason",
    );
    this.errorAlarm(
      "PublishErrors",
      props.publisher,
      "데이터 게시 실패. manifest는 이전 버전 유지됨",
    );

    // ⑥-2 심장박동 경보 4개: 정해진 시간 동안 실행 자체가 없으면 울림(일정 꺼짐·고장)
    this.heartbeatAlarm(
      "WarningsStopped",
      collector("Warnings"),
      HEARTBEAT_WINDOWS.Warnings,
      "특보 수집이 돌지 않음(일정 확인). 45분 뒤 전 해변 '특보 확인 못 함'이 됨",
    );
    this.heartbeatAlarm(
      "OceanStopped",
      collector("Ocean"),
      HEARTBEAT_WINDOWS.Ocean,
      "바다 관측 수집이 돌지 않음(일정 확인). 90분 뒤 '관측 지연'이 됨",
    );
    // 이안류는 비수기에도 30분마다 깨어남(비수기 판단은 수집기 안) → 1년 내내 같은 창
    this.heartbeatAlarm(
      "RipStopped",
      collector("Rip"),
      HEARTBEAT_WINDOWS.Rip,
      "이안류 수집이 돌지 않음(일정 확인). 장소 화면의 이안류 정보가 갱신되지 않음",
    );
    // 게시는 수집이 끝날 때마다 깨어남(특보만 따져도 15분마다)
    this.heartbeatAlarm(
      "PublishStopped",
      props.publisher,
      HEARTBEAT_WINDOWS.Publish,
      "데이터 게시가 멈춤. 45분 뒤 validUntil 초과로 전 해변 판단불가가 됨",
    );

    this.loginAbuseAlarm(props.signInClients);

    this.addKoreanNotifications();
  }

  // ⑤-3 로그인 반복 요청 경보(D17-4): 5분 동안 로그인 실패 합계 ≥ 10 또는 계정 복구 API ≥ 5이면 울림
  // 두 값을 각 기준으로 나눈 것 중 큰 값이 1 이상인지로 한 경보에 묶음(경보 자리 1개)
  // 차단은 하지 않음(Cognito 기본 잠금·요청 제한이 막고, 이 경보는 알기만 함)
  private loginAbuseAlarm(
    clients: readonly { userPoolId: string; clientId: string }[],
  ): void {
    const period = Duration.minutes(LOGIN_ABUSE_ALARM.periodMinutes);
    const usingMetrics: Record<string, cloudwatch.IMetric> = {};
    const failures: string[] = [];
    clients.forEach((client, i) => {
      const dimensionsMap = {
        UserPool: client.userPoolId,
        UserPoolClient: client.clientId,
      };
      // 시도 수(표본 수)와 성공 수(합계). 실패 = 시도 − 성공
      usingMetrics[`tries${i}`] = new cloudwatch.Metric({
        namespace: "AWS/Cognito",
        metricName: "SignInSuccesses",
        dimensionsMap,
        statistic: "SampleCount",
        period,
      });
      usingMetrics[`oks${i}`] = new cloudwatch.Metric({
        namespace: "AWS/Cognito",
        metricName: "SignInSuccesses",
        dimensionsMap,
        statistic: "Sum",
        period,
      });
      failures.push(`(FILL(tries${i}, 0) - FILL(oks${i}, 0))`);
    });
    // 계정 단위 사용량 지표(두 풀 합계). 차원 값은 Cognito 문서 '사용량 지표' 기준
    usingMetrics.recovery = new cloudwatch.Metric({
      namespace: "AWS/Usage",
      metricName: "CallCount",
      dimensionsMap: {
        Service: "Cognito user pool",
        Type: "API",
        Resource: "UserAccountRecovery",
        Class: "None",
      },
      statistic: "Sum",
      period,
    });
    const alarm = new cloudwatch.Alarm(this, "LoginAbuse", {
      alarmName: this.alarmName("LoginAbuse"),
      metric: new cloudwatch.MathExpression({
        expression: `MAX([(${failures.join(" + ")}) / ${LOGIN_ABUSE_ALARM.signInFailures}, FILL(recovery, 0) / ${LOGIN_ABUSE_ALARM.accountRecoveryCalls}])`,
        usingMetrics,
        period,
        label: "로그인 실패·계정 복구 요청 / 기준",
      }),
      threshold: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      // 로그인이 없는 구간은 정상(요청이 없으면 반복도 없음)
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: `로그인 반복 요청. 5분에 로그인 실패 ${LOGIN_ABUSE_ALARM.signInFailures}회 또는 비밀번호 찾기·변경 ${LOGIN_ABUSE_ALARM.accountRecoveryCalls}회 이상. Cognito 잠금·요청 제한이 막고 있음`,
    });
    this.alarms.push(alarm);
  }

  // ⑤-1 오류 경보 도우미: 5분 합계 오류 ≥ 1이면 울림. private = 이 클래스 안에서만 씀
  private errorAlarm(
    id: string,
    fn: lambda.IFunction,
    description: string,
  ): void {
    const alarm = new cloudwatch.Alarm(this, id, {
      alarmName: this.alarmName(id),
      metric: fn.metricErrors({
        period: Duration.minutes(5),
        statistic: "Sum",
      }), // 5분 동안 오류 수 합계
      threshold: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD, // 1 이상
      evaluationPeriods: 1, // 한 구간만 보고 판정(실패 1번도 알림)
      // 실행이 없어 지표가 비면 지금 상태를 유지함. 실행 없음은 심장박동 경보의 몫(이중 알림 방지)
      // 정상으로 보면(notBreaching) 실패 뒤 빈 구간마다 OK로 돌아가 실패 실행마다 메일이 다시 감
      // 성공한 실행은 오류 0을 남기므로 그때 OK로 돌아옴
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
      alarmDescription: description,
    });
    this.alarms.push(alarm);
  }

  // ⑤-2 심장박동 경보 도우미: periodMinutes 구간의 실행 수 < 1이 periods번 이어지면 울림
  private heartbeatAlarm(
    id: string,
    fn: lambda.IFunction,
    window: { periodMinutes: number; periods: number },
    description: string,
  ): void {
    const period = Duration.minutes(window.periodMinutes);
    const alarm = new cloudwatch.Alarm(this, id, {
      alarmName: this.alarmName(id),
      // 실행 횟수. 실패한 실행도 세므로 '아예 안 돎'만 잡음
      // 실행이 없으면 지표 자체가 안 생김. CloudWatch는 평가 구간보다 넓게 조회해 실제 값이 있으면
      // treatMissingData를 쓰지 않으므로, 빈 구간을 0으로 채워 지난 실행이 최근 빈 구간을 대신하지 않게 함
      metric: new cloudwatch.MathExpression({
        expression: "FILL(m, 0)",
        usingMetrics: { m: fn.metricInvocations({ period, statistic: "Sum" }) },
        period,
        label: "Invocations (빈 구간 0)",
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD, // 1 미만
      evaluationPeriods: window.periods,
      // 조회 범위 전체에 실행이 없어 수식 값도 없을 때를 위한 안전장치: 데이터 없음을 위반으로 봄
      // (기본값이면 '데이터 부족'에 머물러 조용함. 데이터 없음을 정상으로 보지 않기)
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: description,
    });
    this.alarms.push(alarm);
  }

  // 경보 이름 = 스택 이름-경보 ID. 알림 Lambda가 이름 끝의 ID로 한국어 제목을 고름
  // 실행 정책이 경보 ARN을 'BaradunV2-*'로 제한하므로 스택 이름으로 시작해야 함
  private alarmName(id: string): string {
    return `${Stack.of(this).stackName}-${id}`;
  }

  // CloudWatch 상태 변경 → EventBridge → 한국어 변환 Lambda → 기존 이메일 SNS 주제
  // 이메일 주제는 그대로 두므로 배포 뒤 구독 확인을 다시 할 필요가 없음
  private addKoreanNotifications(): void {
    const logGroup = new logs.LogGroup(this, "NotificationLogs", {
      retention: LOG_RETENTION,
    });
    const role = new iam.Role(this, "NotificationRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    logGroup.grant(role, "logs:CreateLogStream", "logs:PutLogEvents");

    const fn = new nodejs.NodejsFunction(this, "NotificationFunction", {
      entry: NOTIFICATION_HANDLER_FILE,
      handler: "alarmNotificationHandler",
      runtime: lambdaRuntime.Runtime.NODEJS_22_X,
      architecture: lambdaRuntime.Architecture.ARM_64,
      memorySize: 128,
      timeout: Duration.seconds(10),
      logGroup,
      role,
      description: "baradun v2 Korean CloudWatch alarm notification",
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, "package-lock.json"),
      bundling: { externalModules: [], target: "node22" },
      environment: { OPS_TOPIC_ARN: this.topic.topicArn },
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sns:Publish"],
        resources: [this.topic.topicArn],
      }),
    );
    // alias/aws/sns 키 하나만, SNS를 거친 요청에서 SNS가 실제 암복호화를 수행할 때 필요한 두 작업만 허용함
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["kms:Decrypt", "kms:GenerateDataKey"],
        resources: [
          Stack.of(this).formatArn({
            service: "kms",
            resource: "key",
            resourceName: "*",
          }),
        ],
        conditions: {
          "ForAnyValue:StringEquals": {
            "kms:ResourceAliases": "alias/aws/sns",
          },
          StringEquals: {
            "kms:ViaService": `sns.${Stack.of(this).region}.amazonaws.com`,
          },
        },
      }),
    );
    // 실패 대기열: SNS 게시 실패·시간 초과(Lambda 재시도 뒤)와 EventBridge 전달 실패를 모두 남김
    // SNS·KMS와 무관한 SQS 관리형 암호화를 써서 알림 경로가 고장 나도 기록은 남음. 14일 보관(최대)
    const failures = new sqs.Queue(this, "NotificationFailures", {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    // 경보 알림은 같은 내용을 다시 보내도 해가 없어 재시도함(상한 RETRY_LIMITS)
    // 재시도도 실패하면 이벤트를 버리지 않고 실패 대기열로 보냄
    // SqsDestination은 쓰지 않는 GetQueueUrl·GetQueueAttributes까지 주므로 SendMessage만 직접 허락함
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sqs:SendMessage"],
        resources: [failures.queueArn],
      }),
    );
    fn.configureAsyncInvoke({
      retryAttempts: RETRY_LIMITS.asyncMaxRetries,
      maxEventAge: Duration.seconds(RETRY_LIMITS.asyncMaxEventAgeSeconds),
      onFailure: { bind: () => ({ destination: failures.queueArn }) },
    });

    // ⑥-3 알림 발송 실패 경보: 실패 대기열에 메시지가 1개라도 있으면 울림
    // 이 경보도 같은 Lambda로 알리므로, 일시적 실패였다면 다음 시도에서 메일이 감
    // 계속 실패하면 메일 없이 CloudWatch 경보 화면과 대기열에만 남음(암호화 주제는 경보가 직접 게시 못 함)
    // 대기열이 비어 지표가 끊기면 지금 상태를 유지함. 메시지를 확인·삭제하면 0이 되어 OK로 돌아옴
    this.alarms.push(
      new cloudwatch.Alarm(this, "NotificationFailed", {
        alarmName: this.alarmName("NotificationFailed"),
        metric: failures.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(5),
          statistic: "Maximum",
        }),
        threshold: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.IGNORE,
        alarmDescription:
          "운영 알림 메일 발송 실패. 다른 경보 메일이 오지 않았을 수 있으니 CloudWatch 경보 화면과 실패 대기열을 확인",
      }),
    );

    const rule = new events.Rule(this, "AlarmStateRule", {
      eventPattern: {
        source: ["aws.cloudwatch"],
        detailType: ["CloudWatch Alarm State Change"],
        resources: this.alarms.map((alarm) => alarm.alarmArn),
        detail: { state: { value: ["ALARM"] } },
      },
    });
    rule.addTarget(
      new eventsTargets.LambdaFunction(fn, {
        deadLetterQueue: failures,
        retryAttempts: RETRY_LIMITS.scheduleMaxRetries,
        maxEventAge: Duration.seconds(RETRY_LIMITS.scheduleMaxEventAgeSeconds),
      }),
    );
  }
}
