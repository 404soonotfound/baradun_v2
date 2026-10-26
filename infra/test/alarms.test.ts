import { describe, expect, it } from "vitest";
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

// 경보가 가리키는 함수의 논리 ID
const fnOf = (a: Resource): string =>
  a.Properties.Dimensions?.find((d: any) => d.Name === "FunctionName")?.Value
    ?.Ref;

const byMetric = (name: string) =>
  alarms.filter(([, a]) => a.Properties.MetricName === name);

describe("운영 경보 (BRD-62)", () => {
  it("경보는 9개: 오류 5(수집기 4·게시) + 심장박동 4(특보·관측·이안류·게시)", () => {
    expect(alarms).toHaveLength(9); // A안이면 8
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
    expect(byMetric("Invocations")).toHaveLength(4); // A안이면 3
  });

  it("모든 경보가 '데이터 없음' 처리를 명시하고 운영 주제로만 발송한다", () => {
    for (const [id, a] of alarms) {
      const p = a.Properties;
      // 심장박동은 실행이 없으면(지표 없음) 위반, 오류는 실행 없음을 정상으로 봄
      expect(p.TreatMissingData, id).toBe(
        p.MetricName === "Invocations" ? "breaching" : "notBreaching",
      );
      expect(p.AlarmActions, id).toEqual([{ Ref: opsTopicId }]);
      expect(p.Statistic, id).toBe("Sum");
      expect(p.Threshold, id).toBe(1);
    }
  });

  it("심장박동 창: 특보 15분·관측 30분·게시 15분×2(30분 < 특보 유효시간 45분)", () => {
    const beat = (prefix: string) =>
      byMetric("Invocations").find(([, a]) => fnOf(a).startsWith(prefix))![1]
        .Properties;
    const w = beat("CollectWarningsFunction");
    expect([w.Period, w.EvaluationPeriods]).toEqual([900, 1]);
    const o = beat("CollectOceanFunction");
    expect([o.Period, o.EvaluationPeriods]).toEqual([1800, 1]);
    const p = beat("PublishFunction");
    expect([p.Period, p.EvaluationPeriods]).toEqual([900, 2]);
    expect(p.Period * p.EvaluationPeriods).toBeLessThan(45 * 60);
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
  });
});
