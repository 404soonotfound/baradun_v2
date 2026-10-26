import { Duration } from "aws-cdk-lib"; // "5분" 같은 시간 값을 만드는 도구
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch"; // 경보(Alarm)
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions"; // 경보가 울릴 때 할 일(SNS 발송)
import type * as lambda from "aws-cdk-lib/aws-lambda"; // IFunction 타입만 씀(type import)
import * as sns from "aws-cdk-lib/aws-sns"; // 알림 주제
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions"; // 이메일 구독
import { Construct } from "constructs";

// ② 운영 경보 (아키텍처 10장, BRD-62)
// 수집 중단·게시 실패·validUntil 초과(게시 멈춤)를 SNS 이메일로 알림
// 경보 9개 = 오류 5(수집기 4 + 게시) + 심장박동 4(특보·관측·이안류·게시). settings.ts MAX_ALARMS(10) 안
// catalog는 하루 1회라 심장박동 없이 오류 경보만. 데이터 문의 함수 경보는 두지 않음(BRD-63 결정)

// ③ 스택에서 넘겨받는 값
export interface OpsAlarmsProps {
  readonly email: string; // 경보 받을 주소. 배포 파라미터 AlertEmail 재사용
  // 수집기 이름("Ocean"·"Warnings"·"Catalog"·"Rip") → 함수. Collectors가 만든 Map 그대로
  readonly collectors: ReadonlyMap<string, lambda.IFunction>;
  readonly publisher: lambda.IFunction; // publish-snapshot 함수
}

// ④ 클래스. 스택에서 new OpsAlarms(...) 한 줄로 아래가 전부 만들어짐
export class OpsAlarms extends Construct {
  readonly topic: sns.Topic; // 밖에서 읽을 수 있게 공개(바꿔치기는 못 함)

  constructor(scope: Construct, id: string, props: OpsAlarmsProps) {
    super(scope, id); // CDK 규칙: 부모 준비를 맨 먼저

    // 운영 경보 전용 주제. 문의 알림 주제와 분리(메일 보낸 이 이름으로 구분)
    this.topic = new sns.Topic(this, "Topic", {
      displayName: "바라던 바다 운영 경보",
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
      15,
      1,
      "특보 수집이 돌지 않음(일정 확인). 45분 뒤 전 해변 '특보 확인 못 함'이 됨",
    );
    this.heartbeatAlarm(
      "OceanStopped",
      collector("Ocean"),
      30,
      1,
      "바다 관측 수집이 돌지 않음(일정 확인). 90분 뒤 '관측 지연'이 됨",
    );
    // 이안류는 비수기에도 30분마다 깨어남(비수기 판단은 수집기 안) → 1년 내내 같은 창
    this.heartbeatAlarm(
      "RipStopped",
      collector("Rip"),
      30,
      1, // [B안] A안이면 이 줄(호출 전체) 삭제
      "이안류 수집이 돌지 않음(일정 확인). 장소 화면의 이안류 정보가 갱신되지 않음",
    );
    // 게시는 수집이 끝날 때마다 깨어남. 15분 창 2회 연속(30분) 없으면 울림 → 유효시간 45분 전에 감지
    this.heartbeatAlarm(
      "PublishStopped",
      props.publisher,
      15,
      2,
      "데이터 게시가 멈춤. 45분 뒤 validUntil 초과로 전 해변 판단불가가 됨",
    );
  }

  // ⑤-1 오류 경보 도우미: 5분 합계 오류 ≥ 1이면 울림. private = 이 클래스 안에서만 씀
  private errorAlarm(
    id: string,
    fn: lambda.IFunction,
    description: string,
  ): void {
    const alarm = new cloudwatch.Alarm(this, id, {
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
    alarm.addAlarmAction(new cloudwatchActions.SnsAction(this.topic)); // 울리면 운영 주제로 발송
  }

  // ⑤-2 심장박동 경보 도우미: periodMinutes 구간의 실행 수 < 1이 periods번 이어지면 울림
  private heartbeatAlarm(
    id: string,
    fn: lambda.IFunction,
    periodMinutes: number,
    periods: number,
    description: string,
  ): void {
    const alarm = new cloudwatch.Alarm(this, id, {
      // 실행 횟수. 실패한 실행도 세므로 '아예 안 돎'만 잡음
      metric: fn.metricInvocations({
        period: Duration.minutes(periodMinutes),
        statistic: "Sum",
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD, // 1 미만
      evaluationPeriods: periods,
      // 핵심: 실행이 없으면 지표 자체가 안 생김 → '데이터 없음'을 위반으로 봐야 울림
      // (기본값이면 '데이터 부족'에 머물러 조용함. 데이터 없음을 정상으로 보지 않기)
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      alarmDescription: description,
    });
    alarm.addAlarmAction(new cloudwatchActions.SnsAction(this.topic));
  }
}
