import { describe, expect, it } from "vitest";
import { OBSERVATION_POLICY } from "../../services/src/core/observations/policy";
import { WARNING_POLICY } from "../../services/src/core/warnings/policy";
import { ALARM_LABELS } from "../../services/src/ops/alarm-notification";
import { COLLECTOR_SCHEDULE_MINUTES, RETRY_LIMITS } from "../lib/settings";
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
  it("경보는 10개: 오류 5(수집기 4·게시) + 심장박동 4(특보·관측·이안류·게시) + 알림 발송 실패 1", () => {
    expect(alarms).toHaveLength(10);
    expect(
      byMetric("Errors")
        .map(([, a]) => fnOf(a))
        .sort(),
    ).toEqual([
      expect.stringMatching(/^CollectCatalogFunction/),
      expect.stringMatching(/^CollectOceanFunction/),
      expect.stringMatching(/^CollectRipFunction/),
      expect.stringMatching(/^CollectWarningsFunction/),
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
      expect(p.TreatMissingData, id).toBe(beat ? "breaching" : "ignore");
      expect(p.AlarmActions, id).toBeUndefined();
      expect(p.OKActions, id).toBeUndefined();
      expect(p.InsufficientDataActions, id).toBeUndefined();
      expect(statOf(a).Statistic, id).toBe(
        metric === "ApproximateNumberOfMessagesVisible" ? "Maximum" : "Sum",
      );
      expect(p.Threshold, id).toBe(1);
    }
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
    expect(rule!.Properties.EventPattern.resources).toHaveLength(10);
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
});
