import type { SNSClient } from "@aws-sdk/client-sns";
import { describe, expect, it } from "vitest";
import {
  formatAlarmNotification,
  sendAlarmNotification,
  type CloudWatchAlarmEvent,
} from "./alarm-notification";

function alarmEvent(
  alarmId: string,
  description: string,
): CloudWatchAlarmEvent {
  return {
    version: "0",
    id: "event-id",
    "detail-type": "CloudWatch Alarm State Change",
    source: "aws.cloudwatch",
    account: "123456789012",
    time: "2026-11-03T03:41:04Z",
    region: "ap-northeast-2",
    resources: [
      `arn:aws:cloudwatch:ap-northeast-2:123456789012:alarm:BaradunV2-${alarmId}`,
    ],
    detail: {
      alarmName: `BaradunV2-${alarmId}`,
      configuration: { description },
      state: {
        value: "ALARM",
        reason: "Threshold Crossed: 1 datapoint was less than threshold.",
        timestamp: "2026-11-03T03:41:04Z",
      },
    },
  };
}

describe("운영 경보 한국어 알림", () => {
  it.each([
    ["WarningsErrors", "특보 수집 실패"],
    ["OceanErrors", "바다 관측 수집 실패"],
    ["CatalogErrors", "사진 확인 수집 실패"],
    ["RipErrors", "이안류 수집 실패"],
    ["PublishErrors", "데이터 게시 실패"],
    ["WarningsStopped", "특보 수집 중단"],
    ["OceanStopped", "바다 관측 수집 중단"],
    ["RipStopped", "이안류 수집 중단"],
    ["PublishStopped", "데이터 게시 중단"],
    ["NotificationFailed", "운영 알림 발송 실패"],
    ["LoginAbuse", "운영자 로그인 반복 요청"],
  ])("%s 경보를 %s 제목으로 보낸다", (alarmId, label) => {
    const result = formatAlarmNotification(
      alarmEvent(alarmId, `${label}. 운영 설명`),
    );
    expect(result.subject).toBe(`[바라던 바다] ${label} · 경보 발생`);
    expect(result.message).toContain(`경보: ${label}`);
  });

  it("영문 판정 원문 대신 한국어 판정·KST 시각·콘솔 링크를 넣는다", () => {
    const result = formatAlarmNotification(
      alarmEvent(
        "OceanStopped",
        "바다 관측 수집이 돌지 않음. 90분 뒤 관측 지연이 됨",
      ),
    );

    expect(result.message).toContain("발생 시각: 2026-11-03 12:41:04 KST");
    expect(result.message).toContain(
      "판정: 정해진 평가 구간 동안 실행 기록이 확인되지 않았습니다.",
    );
    expect(result.message).toContain(
      "CloudWatch에서 확인: https://ap-northeast-2.console.aws.amazon.com/",
    );
    expect(result.message).not.toContain("Threshold Crossed");
  });

  it("새 운영 경보도 설명의 첫 문장을 한국어 제목으로 사용한다", () => {
    const result = formatAlarmNotification(
      alarmEvent(
        "FutureAlarm",
        "새 운영 항목 확인 필요. 담당자가 원인을 확인해야 함",
      ),
    );

    expect(result.subject).toBe(
      "[바라던 바다] 새 운영 항목 확인 필요 · 경보 발생",
    );
    expect(result.message).toContain(
      "판정: 설정된 운영 경보 조건을 충족했습니다.",
    );
  });

  it("알림 발송 실패 경보는 실패 대기열에 기록됐다고 알린다", () => {
    const result = formatAlarmNotification(
      alarmEvent("NotificationFailed", "운영 알림 메일 발송 실패"),
    );
    expect(result.message).toContain(
      "판정: 재시도 뒤에도 알림을 보내지 못해 실패 대기열에 기록되었습니다.",
    );
  });

  // 결정 기록 D17-4: 차단하지 않고 알기만 함. 막는 것은 Cognito 잠금·요청 제한
  it("로그인 반복 요청 경보는 기준을 넘었고 Cognito가 막고 있다고 알린다", () => {
    const result = formatAlarmNotification(
      alarmEvent("LoginAbuse", "로그인 반복 요청"),
    );
    expect(result.message).toContain(
      "판정: 5분 동안 로그인 실패 또는 비밀번호 찾기·변경 요청이 기준을 넘었습니다.",
    );
  });

  it("경보 ID가 이름 끝에 정확히 있을 때만 알려진 제목을 쓴다", () => {
    const result = formatAlarmNotification(
      alarmEvent("WarningsErrorsBackup", "백업 특보 확인 실패. 운영 설명"),
    );
    expect(result.subject).toBe(
      "[바라던 바다] 백업 특보 확인 실패 · 경보 발생",
    );
    expect(result.message).toContain(
      "판정: 설정된 운영 경보 조건을 충족했습니다.",
    );
  });

  it("기존 이메일 SNS 주제로 한국어 제목과 본문을 게시한다", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const sns = {
      send: async (command: { input: Record<string, unknown> }) => {
        commands.push(command);
        return {};
      },
    } as unknown as SNSClient;

    await sendAlarmNotification(
      alarmEvent("OceanErrors", "바다 관측 수집 실패"),
      sns,
      "arn:aws:sns:ap-northeast-2:123456789012:ops",
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]?.input).toMatchObject({
      TopicArn: "arn:aws:sns:ap-northeast-2:123456789012:ops",
      Subject: "[바라던 바다] 바다 관측 수집 실패 · 경보 발생",
    });
    expect(String(commands[0]?.input.Message)).toContain(
      "판정: 최근 실행에서 오류가 1회 이상 감지되었습니다.",
    );
  });
});
