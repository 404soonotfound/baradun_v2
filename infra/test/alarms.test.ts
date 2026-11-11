import { describe, expect, it } from "vitest";
import { COLLECT_POLICY } from "../../services/src/collectors/policy";
import { OBSERVATION_POLICY } from "../../services/src/core/observations/policy";
import { WARNING_POLICY } from "../../services/src/core/warnings/policy";
import { ALARM_LABELS } from "../../services/src/ops/alarm-notification";
import {
  COLLECTOR_SCHEDULE_MINUTES,
  LOGIN_ABUSE_ALARM,
  MAX_ALARMS,
  OPS_API_ALARM,
  RETRY_LIMITS,
  WEATHER_ALARM,
} from "../lib/settings";
import { template } from "./stack-template";

// 운영 경보 (BRD-62). 템플릿(JSON)만 검사 — AWS 계정 불필요

type Resource = { Type: string; Properties: Record<string, any> };

const alarms = Object.entries(
  template.findResources("AWS::CloudWatch::Alarm"),
) as [string, Resource][];

// 운영 주제의 논리 ID (문의 주제 InquiryTopic…과 구분)
const opsTopicId = Object.keys(template.findResources("AWS::SNS::Topic")).find(
  (id) => id.startsWith("OpsTopic"),
)!;
const notificationFunctionId = Object.keys(
  template.findResources("AWS::Lambda::Function"),
).find((id) => id.startsWith("OpsNotificationFunction"))!;

// 경보가 보는 원래 지표. 오류는 지표 하나, 심장박동은 수식(FILL)이 감싼 지표 m
const statOf = (a: Resource) => {
  const p = a.Properties;
  const m = p.Metrics?.find((x: any) => x.Id === "m")?.MetricStat;
  return m
    ? { ...m.Metric, Period: m.Period, Statistic: m.Stat }
    : {
        MetricName: p.MetricName,
        Dimensions: p.Dimensions,
        Period: p.Period,
        Statistic: p.Statistic,
      };
};

// 경보가 가리키는 함수의 논리 ID
const fnOf = (a: Resource): string =>
  statOf(a).Dimensions?.find((d: any) => d.Name === "FunctionName")?.Value?.Ref;

const byMetric = (name: string) =>
  alarms.filter(([, a]) => statOf(a).MetricName === name);

const MINUTE = 60;

// 일정 분 목록("3,18,33,48") 여럿을 합쳐 이웃한 실행 사이의 가장 긴 간격(분). 정시를 넘어가는 간격 포함
const maxGapMinutes = (...schedules: string[]): number => {
  const minutes = [
    ...new Set(schedules.flatMap((s) => s.split(",").map(Number))),
  ].sort((a, b) => a - b);
  return Math.max(
    ...minutes.map((m, i) => (minutes[i + 1] ?? minutes[0]! + 60) - m),
  );
};

// 심장박동 경보의 슬라이딩 창 길이(초)
const heartbeatWindow = (prefix: string): number => {
  const a = byMetric("Invocations").find(([, a]) =>
    fnOf(a).startsWith(prefix),
  )![1];
  return statOf(a).Period * a.Properties.EvaluationPeriods;
};

const failureQueueId = Object.keys(
  template.findResources("AWS::SQS::Queue"),
).find((id) => id.startsWith("OpsNotificationFailures"))!;

describe("운영 경보 (BRD-62)", () => {
  it("경보는 13개 이하(상한 MAX_ALARMS)이며 이번 경보 추가로 정확히 13개다", () => {
    expect(alarms.length).toBeLessThanOrEqual(MAX_ALARMS);
    expect(alarms).toHaveLength(13);
    expect(
      alarms.filter(([id]) => id.startsWith("OpsLoginAbuse")),
    ).toHaveLength(1);
    expect(
      alarms.filter(([id]) => id.startsWith("OpsOpsApiErrors")),
    ).toHaveLength(1);
    expect(
      byMetric("Errors")
        .map(([, a]) => fnOf(a))
        .sort(),
    ).toEqual([
      expect.stringMatching(/^CollectCatalogFunction/),
      expect.stringMatching(/^CollectOceanFunction/),
      expect.stringMatching(/^CollectRipFunction/),
      expect.stringMatching(/^CollectWarningsFunction/),
      expect.stringMatching(/^CollectWeatherFunction/),
      expect.stringMatching(/^PublishFunction/),
    ]);
    expect(byMetric("Invocations")).toHaveLength(4);
    expect(byMetric("ApproximateNumberOfMessagesVisible")).toHaveLength(1);
  });

  it("모든 경보가 '데이터 없음' 처리를 명시하고 직접 영문 SNS 알림은 보내지 않는다", () => {
    for (const [id, a] of alarms) {
      const p = a.Properties;
      const metric = statOf(a).MetricName;
      const beat = metric === "Invocations";
      // 심장박동은 실행이 없으면(지표 없음) 위반, 오류·대기열은 지표 없음에 상태를 유지함(정상으로 보지 않음)
      // 로그인 반복 요청·운영 API 오류 급증은 호출이 없으면 오류도 없으므로 정상(notBreaching)
      const login = id.startsWith("OpsLoginAbuse");
      const opsApi = id.startsWith("OpsOpsApiErrors");
      // 날씨는 실행 없음도 실패로 보는 오류 경보(경보 하나로 오류·중단을 함께 잡음, BRD-181)
      const weather = id.startsWith("OpsWeatherFailing");
      expect(p.TreatMissingData, id).toBe(
        login || opsApi
          ? "notBreaching"
          : beat || weather
            ? "breaching"
            : "ignore",
      );
      expect(p.AlarmActions, id).toBeUndefined();
      expect(p.OKActions, id).toBeUndefined();
      expect(p.InsufficientDataActions, id).toBeUndefined();
      // 로그인 반복 요청·운영 API 오류 급증은 여러 지표의 수식이라 아래 전용 테스트에서 통계를 봄
      if (login || opsApi) continue;
      expect(statOf(a).Statistic, id).toBe(
        metric === "ApproximateNumberOfMessagesVisible" ? "Maximum" : "Sum",
      );
      expect(p.Threshold, id).toBe(1);
    }
  });

  it("날씨 수집 경보: 1시간 구간 오류(또는 실행 없음)가 3번 이어질 때만 울린다(BRD-181)", () => {
    const [[, a]] = alarms.filter(([id]) => id.startsWith("OpsWeatherFailing"));
    expect(fnOf(a)).toMatch(/^CollectWeatherFunction/);
    expect(a.Properties).toMatchObject({
      MetricName: "Errors",
      Statistic: "Sum",
      Period: WEATHER_ALARM.periodMinutes * 60,
      EvaluationPeriods: WEATHER_ALARM.periods,
      DatapointsToAlarm: WEATHER_ALARM.periods,
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "breaching",
    });
    // 매시 한 번 도는 수집기라 구간 하나에 실행이 하나씩 들어감
    expect(WEATHER_ALARM.periodMinutes).toBe(
      COLLECT_POLICY.weatherSchedule.periodMinutes,
    );
  });

  it("심장박동은 빈 구간을 0으로 채워 지난 실행이 최근 빈 구간을 대신하지 않는다", () => {
    for (const [id, a] of byMetric("Invocations")) {
      const out = a.Properties.Metrics.filter((x: any) => x.ReturnData);
      expect(out, id).toEqual([
        expect.objectContaining({ Expression: "FILL(m, 0)" }),
      ]);
    }
  });

  // 슬라이딩 창: 마지막 실행 뒤 창 길이만큼 지나면 울림. 정상일 때는 (창 − 실행 간격)까지 지표 지연을 견딤
  const warningsTtl = WARNING_POLICY.confirmationTtlMs / 1000;
  const waveTtl = OBSERVATION_POLICY.expiryMs.waveHeight / 1000;
  const warningsGap = maxGapMinutes(COLLECTOR_SCHEDULE_MINUTES.warnings);
  const publishGap = maxGapMinutes(
    ...Object.values(COLLECTOR_SCHEDULE_MINUTES),
  );

  it.each([
    ["특보 수집", "CollectWarningsFunction", warningsTtl],
    ["게시", "PublishFunction", warningsTtl],
    ["바다 관측 수집", "CollectOceanFunction", waveTtl],
  ] as const)(
    "%s 중단은 화면이 바뀌기(유효시간) 15분 이상 전에 감지한다",
    (_name, prefix, ttl) => {
      expect(heartbeatWindow(prefix) + 15 * MINUTE).toBeLessThanOrEqual(ttl);
    },
  );

  it.each([
    ["특보 수집", "CollectWarningsFunction", warningsGap],
    ["게시", "PublishFunction", publishGap],
    [
      "바다 관측 수집",
      "CollectOceanFunction",
      maxGapMinutes(COLLECTOR_SCHEDULE_MINUTES.ocean),
    ],
    [
      "이안류 수집",
      "CollectRipFunction",
      maxGapMinutes(COLLECTOR_SCHEDULE_MINUTES.rip),
    ],
  ] as const)(
    "%s 정상 실행은 지표가 10분 늦어도 심장박동 경보를 울리지 않는다",
    (_name, prefix, gapMinutes) => {
      expect(
        heartbeatWindow(prefix) - gapMinutes * MINUTE,
      ).toBeGreaterThanOrEqual(10 * MINUTE);
    },
  );

  it("알림 Lambda는 재시도하고, 그래도 실패하면 SNS와 무관한 SQS 대기열에 남긴다", () => {
    const configs = Object.values(
      template.findResources("AWS::Lambda::EventInvokeConfig"),
    ).filter((c) => c.Properties.FunctionName?.Ref === notificationFunctionId);
    expect(configs).toHaveLength(1);
    expect(configs[0]!.Properties.MaximumRetryAttempts).toBe(
      RETRY_LIMITS.asyncMaxRetries,
    );
    expect(configs[0]!.Properties.MaximumRetryAttempts).toBeGreaterThan(0);
    expect(configs[0]!.Properties.DestinationConfig).toEqual({
      OnFailure: {
        Destination: { "Fn::GetAtt": [failureQueueId, "Arn"] },
      },
    });

    const queue = template.findResources("AWS::SQS::Queue")[failureQueueId]!;
    expect(queue.Properties.SqsManagedSseEnabled).toBe(true);
    expect(queue.Properties.KmsMasterKeyId).toBeUndefined();
    expect(queue.Properties.MessageRetentionPeriod).toBe(14 * 24 * 60 * 60);
  });

  it("알림 발송 실패 경보는 실패 대기열에 메시지가 하나라도 있으면 울린다", () => {
    const [[, a]] = byMetric("ApproximateNumberOfMessagesVisible") as [
      [string, Resource],
    ];
    expect(statOf(a).Dimensions).toEqual([
      {
        Name: "QueueName",
        Value: { "Fn::GetAtt": [failureQueueId, "QueueName"] },
      },
    ]);
    expect(a.Properties).toMatchObject({
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1,
    });
  });

  it("경보 이름은 스택 이름-경보 ID라서 알림 Lambda가 이름 끝으로 제목을 고른다", () => {
    // 알림 Lambda의 제목 목록과 경보 ID가 어긋나면 한국어 제목 대신 설명 첫 문장으로 떨어짐
    expect(alarms.map(([, a]) => a.Properties.AlarmName).sort()).toEqual(
      ALARM_LABELS.map(([id]) => `Test-${id}`).sort(),
    );
  });

  it("ALARM 상태 변경만 한국어 변환 Lambda로 전달한다", () => {
    const rules = Object.values(template.findResources("AWS::Events::Rule"));
    const rule = rules.find((resource) =>
      resource.Properties.Targets?.some(
        (target: any) =>
          target.Arn?.["Fn::GetAtt"]?.[0] === notificationFunctionId,
      ),
    );

    expect(rule).toBeDefined();
    expect(rule!.Properties.EventPattern).toMatchObject({
      source: ["aws.cloudwatch"],
      "detail-type": ["CloudWatch Alarm State Change"],
      detail: { state: { value: ["ALARM"] } },
    });
    expect(rule!.Properties.EventPattern.resources).toHaveLength(alarms.length);
    expect(rule!.Properties.Targets).toHaveLength(1);
    // 전달 실패도 버리지 않고 같은 실패 대기열로 보냄
    expect(rule!.Properties.Targets[0].DeadLetterConfig).toEqual({
      Arn: { "Fn::GetAtt": [failureQueueId, "Arn"] },
    });
  });

  it("운영 주제 구독은 AlertEmail 이메일 하나뿐이다", () => {
    const subs = Object.values(
      template.findResources("AWS::SNS::Subscription"),
    ).filter((s) => s.Properties.TopicArn?.Ref === opsTopicId);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.Properties).toMatchObject({
      Protocol: "email",
      Endpoint: { Ref: "AlertEmail" },
    });
    expect(
      JSON.stringify(
        template.findResources("AWS::SNS::Topic")[opsTopicId]?.Properties
          ?.KmsMasterKeyId,
      ),
    ).toContain("alias/aws/sns");
  });

  it("한국어 변환 Lambda만 기존 운영 이메일 주제에 게시할 수 있다", () => {
    const policies = Object.values(
      template.findResources("AWS::IAM::Policy"),
    ).filter((policy) =>
      policy.Properties.Roles?.some((role: { Ref?: string }) =>
        role.Ref?.startsWith("OpsNotificationRole"),
      ),
    );
    const statements = policies.flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement,
    );

    expect(statements).toContainEqual(
      expect.objectContaining({
        Action: "sns:Publish",
        Effect: "Allow",
        Resource: { Ref: opsTopicId },
      }),
    );
  });

  // 로그인 반복 요청(결정 기록 D17-4): 두 풀의 로그인 실패 합계와 계정 복구 API 호출을 기준으로 나눠 큰 값 ≥ 1
  it("로그인 반복 요청 경보는 두 풀의 로그인 실패와 계정 복구 호출을 5분 기준으로 본다", () => {
    const [, alarm] = alarms.find(([id]) => id.startsWith("OpsLoginAbuse"))!;
    const p = alarm.Properties;
    expect(p.Threshold).toBe(1);
    expect(p.ComparisonOperator).toBe("GreaterThanOrEqualToThreshold");
    expect(p.EvaluationPeriods).toBe(1);
    const metrics = p.Metrics as any[];
    const expression = metrics.find((m) => m.Expression)?.Expression as string;
    expect(expression).toBe(
      `MAX([((FILL(tries0, 0) - FILL(oks0, 0)) + (FILL(tries1, 0) - FILL(oks1, 0))) / ${LOGIN_ABUSE_ALARM.signInFailures}, FILL(recovery, 0) / ${LOGIN_ABUSE_ALARM.accountRecoveryCalls}])`,
    );
    const stats = metrics.filter((m) => m.MetricStat).map((m) => m.MetricStat);
    expect(
      stats.every((s) => s.Period === LOGIN_ABUSE_ALARM.periodMinutes * 60),
    ).toBe(true);
    const pools = stats
      .filter((s) => s.Metric.MetricName === "SignInSuccesses")
      .map((s) =>
        JSON.stringify(
          s.Metric.Dimensions.find((d: any) => d.Name === "UserPool").Value,
        ),
      );
    // 운영자 풀·데모(샘플) 풀을 모두 봄
    expect(pools.some((v) => v.includes("OperatorAuthUserPool"))).toBe(true);
    expect(pools.some((v) => v.includes("OperatorAuthSamplePool"))).toBe(true);
    expect(
      stats.find((s) => s.Metric.Namespace === "AWS/Usage")?.Metric.Dimensions,
    ).toEqual(
      expect.arrayContaining([
        { Name: "Resource", Value: "UserAccountRecovery" },
        { Name: "Service", Value: "Cognito User Pool" },
      ]),
    );
    expect(LOGIN_ABUSE_ALARM).toEqual({
      periodMinutes: 5,
      signInFailures: 10,
      accountRecoveryCalls: 5,
    });
  });

  // 운영 API 5xx·권한 거부 급증(결정 기록 D17-7): Lambda 함수 URL 5xx와 401·403 로그 지표를 5분 기준으로 나눠 큰 값 ≥ 1
  it("운영 API 5xx·권한 거부 급증 경보는 함수 URL 5xx와 401·403 로그 지표를 5분 기준으로 본다", () => {
    // 1) 로그 지표 필터 검증 (401·403에만 남는 ops_auth_denied 이벤트 수)
    const filters = Object.entries(
      template.findResources("AWS::Logs::MetricFilter"),
    ) as [string, Resource][];
    expect(filters).toHaveLength(1);
    const [, filter] = filters[0];
    const fp = filter.Properties;
    // Lambda 텍스트 로그 접두어와 상관없이 맞도록 JSON 패턴이 아닌 정규식. 낱말이 아니라 "event":"ops_auth_denied" 필드만 셈
    // (다른 줄 path 값에 같은 낱말이 있어도 세지 않음. 401·403 제한은 handleOps가 보장)
    expect(fp.FilterPattern).toBe(
      "%\\x22event\\x22:\\x22ops_auth_denied\\x22%",
    );
    expect(fp.MetricTransformations).toEqual([
      {
        MetricName: OPS_API_ALARM.metricName,
        MetricNamespace: OPS_API_ALARM.metricNamespace,
        MetricValue: "1",
      },
    ]);

    // 2) 경보 설정 검증
    const [, alarm] = alarms.find(([id]) => id.startsWith("OpsOpsApiErrors"))!;
    const p = alarm.Properties;
    expect(p.Threshold).toBe(1);
    expect(p.ComparisonOperator).toBe("GreaterThanOrEqualToThreshold");
    expect(p.EvaluationPeriods).toBe(1);
    expect(p.TreatMissingData).toBe("notBreaching");
    const metrics = p.Metrics as any[];
    const expression = metrics.find((m) => m.Expression)?.Expression as string;
    expect(expression).toBe(
      `MAX([FILL(m5, 0) / ${OPS_API_ALARM.serverErrors}, FILL(m4, 0) / ${OPS_API_ALARM.authFailures}])`,
    );
    const stats = metrics.filter((m) => m.MetricStat).map((m) => m.MetricStat);
    expect(
      stats.every((s) => s.Period === OPS_API_ALARM.periodMinutes * 60),
    ).toBe(true);
    expect(stats.every((s) => s.Stat === "Sum")).toBe(true);
    const m5 = stats.find((s) => s.Metric.MetricName === "Url5xxCount")!;
    const m4 = stats.find(
      (s) => s.Metric.MetricName === OPS_API_ALARM.metricName,
    )!;
    expect(m5.Metric.Namespace).toBe("AWS/Lambda");
    expect(m4.Metric.Namespace).toBe(OPS_API_ALARM.metricNamespace);
    expect(
      m5.Metric.Dimensions.find((d: any) => d.Name === "FunctionName")?.Value
        ?.Ref,
    ).toMatch(/^OpsApiFunction/);
    expect(m4.Metric.Dimensions).toBeUndefined();
    expect(OPS_API_ALARM).toEqual({
      periodMinutes: 5,
      serverErrors: 3,
      authFailures: 10,
      metricNamespace: "Baradun/Ops",
      metricName: "AuthDenied",
    });
  });
});
