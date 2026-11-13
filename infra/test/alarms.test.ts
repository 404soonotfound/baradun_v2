import { describe, expect, it } from "vitest";
import { COLLECT_POLICY } from "../../services/src/collectors/policy";
import { OBSERVATION_POLICY } from "../../services/src/core/observations/policy";
import { WARNING_POLICY } from "../../services/src/core/warnings/policy";
import { ALARM_LABELS } from "../../services/src/ops/alarm-notification";
import {
  COLLECTOR_SCHEDULE_MINUTES,
  INQUIRY_EMAIL_OVERDUE_ALARM,
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

// 경보가 보는 원래 지표. 오류는 지표 하나, 심장박동은 수식(FILL)이 감싼 지표 m,
// 성공 없음은 수식이 읽는 실행 수(runs: Errors 지표의 표본 수)
const statOf = (a: Resource) => {
  const p = a.Properties;
  const m = p.Metrics?.find(
    (x: any) => x.Id === "m" || x.Id === "runs",
  )?.MetricStat;
  return m
    ? { ...m.Metric, Period: m.Period, Statistic: m.Stat }
    : {
        MetricName: p.MetricName,
        Dimensions: p.Dimensions,
        Period: p.Period,
        Statistic: p.Statistic,
      };
};

// 성공 없음 경보(GH-424): 수집기의 오류 경보와 심장박동 경보를 함수마다 하나로 합친 것. 날씨(WeatherFailing)는 다른 방식
const NO_SUCCESS_ID = /^Ops(Warnings|Ocean|Rip)Failing/;
const noSuccess = alarms.filter(([id]) => NO_SUCCESS_ID.test(id));

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

// 성공 없음·심장박동 경보의 슬라이딩 창 길이(초)
const windowOf = (prefix: string): number => {
  const a = [...noSuccess, ...byMetric("Invocations")].find(([, a]) =>
    fnOf(a).startsWith(prefix),
  )![1];
  return statOf(a).Period * a.Properties.EvaluationPeriods;
};

const failureQueueId = Object.keys(
  template.findResources("AWS::SQS::Queue"),
).find((id) => id.startsWith("OpsNotificationFailures"))!;

describe("운영 경보 (BRD-62)", () => {
  it("경보 수는 상한 MAX_ALARMS(10)와 같다", () => {
    expect(alarms).toHaveLength(MAX_ALARMS);
    // 로그인 반복 요청 경보(D17-4, 지표 3개)는 뺌(GH-424). 다시 넣으면 지표 상한 검사도 함께 봐야 함
    expect(
      alarms.filter(([id]) => id.startsWith("OpsLoginAbuse")),
    ).toHaveLength(0);
    expect(
      alarms.filter(([id]) => id.startsWith("OpsOpsApiErrors")),
    ).toHaveLength(1);
    // 성공 없음 경보: 특보·관측·이안류 수집
    expect(noSuccess.map(([, a]) => fnOf(a)).sort()).toEqual([
      expect.stringMatching(/^CollectOceanFunction/),
      expect.stringMatching(/^CollectRipFunction/),
      expect.stringMatching(/^CollectWarningsFunction/),
    ]);
    // 오류 지표를 그대로 보는 경보: 사진 확인(하루 1회)·날씨·게시
    expect(
      alarms
        .filter(([, a]) => a.Properties.MetricName === "Errors")
        .map(([, a]) => fnOf(a))
        .sort(),
    ).toEqual([
      expect.stringMatching(/^CollectCatalogFunction/),
      expect.stringMatching(/^CollectWeatherFunction/),
      expect.stringMatching(/^PublishFunction/),
    ]);
    // 심장박동은 게시만. 게시는 성공 없음으로 합치지 않음(한 번의 게시 실패를 다른 게시의 성공이 가리지 않게, D16-C2)
    expect(byMetric("Invocations").map(([, a]) => fnOf(a))).toEqual([
      expect.stringMatching(/^PublishFunction/),
    ]);
    // 합친 수집기의 예전 오류·실행 없음 경보 쌍은 남기지 않음(같은 일을 두 번 알리지 않고, 지표도 두 번 세지 않음)
    expect(
      alarms.filter(([id]) =>
        /^Ops(Warnings|Ocean|Rip)(Errors|Stopped)/.test(id),
      ),
    ).toHaveLength(0);
    expect(byMetric("ApproximateNumberOfMessagesVisible")).toHaveLength(1);
  });

  it("모든 경보가 '데이터 없음' 처리를 명시하고 직접 영문 SNS 알림은 보내지 않는다", () => {
    for (const [id, a] of alarms) {
      const p = a.Properties;
      const metric = statOf(a).MetricName;
      const quiet = NO_SUCCESS_ID.test(id);
      const beat = metric === "Invocations" || quiet;
      // 성공 없음·심장박동은 실행이 없으면(지표 없음) 위반, 오류·대기열은 지표 없음에 상태를 유지함(정상으로 보지 않음)
      // 운영 API 오류 급증은 호출이 없으면 오류도 없으므로 정상(notBreaching)
      // 문의 이메일 기한 초과는 초과 항목이 발견된 날에만 지표가 나오므로 지표 없음은 정상(notBreaching)
      const opsApi = id.startsWith("OpsOpsApiErrors");
      const inquiryEmailOverdue = id.startsWith("OpsInquiryEmailOverdue");
      // 날씨는 실행 없음도 실패로 보는 오류 경보(경보 하나로 오류·중단을 함께 잡음, BRD-181)
      const weather = id.startsWith("OpsWeatherFailing");
      expect(p.TreatMissingData, id).toBe(
        opsApi || inquiryEmailOverdue
          ? "notBreaching"
          : beat || weather
            ? "breaching"
            : "ignore",
      );
      expect(p.AlarmActions, id).toBeUndefined();
      expect(p.OKActions, id).toBeUndefined();
      expect(p.InsufficientDataActions, id).toBeUndefined();
      // 성공 없음·운영 API 오류 급증·문의 이메일 기한 초과는 수식이라 아래 전용 테스트에서 통계를 봄
      if (quiet || opsApi || inquiryEmailOverdue) continue;
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

  it("성공 없음 경보는 성공한 실행 수(실행 수 − 오류 수)가 1 미만인 구간이 이어지면 울린다", () => {
    expect(noSuccess).toHaveLength(3);
    for (const [id, a] of noSuccess) {
      const p = a.Properties;
      // 빈 구간을 0으로 채워 지난 성공이 최근 빈 구간을 대신하지 않음
      const out = p.Metrics.filter((x: any) => x.ReturnData !== false);
      expect(out, id).toEqual([
        expect.objectContaining({
          Expression: "FILL(runs, 0) - FILL(errors, 0)",
        }),
      ]);
      expect(p.Threshold, id).toBe(1);
      expect(p.ComparisonOperator, id).toBe("LessThanThreshold");
      const stats = p.Metrics.filter((x: any) => x.MetricStat);
      expect(
        stats.map((x: any) => [x.Id, x.MetricStat.Stat]).sort(),
        id,
      ).toEqual([
        ["errors", "Sum"],
        ["runs", "SampleCount"],
      ]);
      // 과금: 두 통계가 같은 지표(이름·차원)를 읽어야 경보 지표 1개로 셈. Invocations를 따로 읽으면 2개가 됨
      expect(
        new Set(stats.map((x: any) => JSON.stringify(x.MetricStat.Metric)))
          .size,
        id,
      ).toBe(1);
      expect(stats[0].MetricStat.Metric).toMatchObject({
        Namespace: "AWS/Lambda",
        MetricName: "Errors",
      });
      expect(
        stats.every((x: any) => x.MetricStat.Period === 5 * MINUTE),
        id,
      ).toBe(true);
    }
  });

  // 슬라이딩 창: 마지막 성공(게시는 마지막 실행) 뒤 창 길이만큼 지나면 울림. 정상일 때는 (창 − 실행 간격)까지 지표 지연을 견딤
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
      expect(windowOf(prefix) + 15 * MINUTE).toBeLessThanOrEqual(ttl);
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
    "%s 정상 실행은 지표가 10분 늦어도 성공 없음·심장박동 경보를 울리지 않는다",
    (_name, prefix, gapMinutes) => {
      expect(windowOf(prefix) - gapMinutes * MINUTE).toBeGreaterThanOrEqual(
        10 * MINUTE,
      );
    },
  );

  // 예전 오류 경보는 한 번의 실패에도 울렸음. 합친 뒤에도 수집기는 한 번의 실패를 알려야 함:
  // 실패가 한 번 끼면 성공 사이가 실행 간격의 2배로 벌어짐 → 그 사이에 빈 구간이 창을 채울 만큼(구간 하나 여유) 있어야 울림
  it.each([
    [
      "특보 수집",
      "CollectWarningsFunction",
      COLLECTOR_SCHEDULE_MINUTES.warnings,
    ],
    [
      "바다 관측 수집",
      "CollectOceanFunction",
      COLLECTOR_SCHEDULE_MINUTES.ocean,
    ],
    ["이안류 수집", "CollectRipFunction", COLLECTOR_SCHEDULE_MINUTES.rip],
  ] as const)(
    "%s 실패가 한 번이어도 성공 없음 경보가 울린다",
    (_name, prefix, schedule) => {
      const interval = maxGapMinutes(schedule) * MINUTE;
      expect(2 * interval - 5 * MINUTE).toBeGreaterThanOrEqual(
        windowOf(prefix),
      );
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

  // 운영 API 5xx·권한 거부 급증(결정 기록 D17-7): Lambda 함수 URL 5xx와 401·403 로그 지표를 5분 기준으로 나눠 큰 값 ≥ 1
  it("운영 API 5xx·권한 거부 급증 경보는 함수 URL 5xx와 401·403 로그 지표를 5분 기준으로 본다", () => {
    // 1) 로그 지표 필터 검증 (401·403에만 남는 ops_auth_denied 이벤트 수)
    const filters = Object.entries(
      template.findResources("AWS::Logs::MetricFilter"),
    ) as [string, Resource][];
    const authFilter = filters.find(([id]) =>
      id.startsWith("OpsOpsApiAuthDeniedFilter"),
    );
    expect(authFilter).toBeDefined();
    const fp = authFilter![1].Properties;
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
  });

  // 문의 이메일 기한 초과 경보(BRD-119): 89일 이상 남은 이메일 항목 발견 시 울림
  it("문의 이메일 기한 초과 경보는 inquiry_email_overdue 로그 지표를 감시한다", () => {
    const filters = Object.entries(
      template.findResources("AWS::Logs::MetricFilter"),
    ) as [string, Resource][];
    const overdueFilter = filters.find(([id]) =>
      id.startsWith("OpsInquiryEmailOverdueFilter"),
    );
    expect(overdueFilter).toBeDefined();
    const fp = overdueFilter![1].Properties;
    expect(fp.FilterPattern).toBe(
      "%\\x22event\\x22:\\x22inquiry_email_overdue\\x22%",
    );
    expect(fp.MetricTransformations).toEqual([
      {
        MetricName: INQUIRY_EMAIL_OVERDUE_ALARM.metricName,
        MetricNamespace: INQUIRY_EMAIL_OVERDUE_ALARM.metricNamespace,
        MetricValue: "1",
      },
    ]);

    const [, alarm] = alarms.find(([id]) =>
      id.startsWith("OpsInquiryEmailOverdue"),
    )!;
    const p = alarm.Properties;
    expect(p.Threshold).toBe(1);
    expect(p.ComparisonOperator).toBe("GreaterThanOrEqualToThreshold");
    expect(p.EvaluationPeriods).toBe(1);
    expect(p.TreatMissingData).toBe("notBreaching");
    const metrics = p.Metrics as any[];
    const expression = metrics.find((m) => m.Expression)?.Expression as string;
    expect(expression).toBe("MAX([FILL(overdue, 0), FILL(dlq, 0)])");
    const stats = metrics.filter((m) => m.MetricStat).map((m) => m.MetricStat);
    expect(
      stats.every(
        (s) => s.Period === INQUIRY_EMAIL_OVERDUE_ALARM.periodMinutes * 60,
      ),
    ).toBe(true);
    const overdueStat = stats.find(
      (s) => s.Metric.MetricName === INQUIRY_EMAIL_OVERDUE_ALARM.metricName,
    )!;
    const dlqStat = stats.find(
      (s) => s.Metric.MetricName === "ApproximateNumberOfMessagesVisible",
    )!;
    expect(overdueStat.Metric.Namespace).toBe(
      INQUIRY_EMAIL_OVERDUE_ALARM.metricNamespace,
    );
    expect(overdueStat.Stat).toBe("Sum");
    expect(dlqStat.Metric.Namespace).toBe("AWS/SQS");
    expect(dlqStat.Stat).toBe("Maximum");
  });
});
