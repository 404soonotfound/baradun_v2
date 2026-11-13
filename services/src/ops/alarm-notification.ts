import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { EventBridgeEvent } from "aws-lambda";
import { KST_OFFSET_MS } from "../core/warnings/time";

// EventBridge 규칙이 ALARM 상태 변경만 보냄(infra/lib/ops/alarms.ts). 복구(OK) 메일은 보내지 않음
interface AlarmState {
  readonly value: string;
  readonly reason?: string;
  readonly timestamp?: string;
}

interface CloudWatchAlarmDetail {
  readonly alarmName: string;
  readonly configuration?: {
    readonly description?: string;
  };
  readonly state: AlarmState;
}

export type CloudWatchAlarmEvent = EventBridgeEvent<
  "CloudWatch Alarm State Change",
  CloudWatchAlarmDetail
>;

// 경보 ID는 infra/lib/ops/alarms.ts와 같아야 함(infra alarms.test.ts가 확인)
export const ALARM_LABELS = [
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
  ["WeatherFailing", "날씨 수집 계속 실패"],
  ["OpsApiErrors", "운영 API 오류 급증"],
  ["InquiryEmailOverdue", "문의 이메일 보관 기한 초과"],
] as const;

export interface AlarmNotification {
  readonly subject: string;
  readonly message: string;
}

// 경보 이름 = 스택 이름-경보 ID(alarms.ts alarmName). 이름 끝의 ID가 정확히 맞을 때만 고름
function alarmId(alarmName: string): string {
  return alarmName.slice(alarmName.lastIndexOf("-") + 1);
}

function knownAlarmLabel(alarmName: string): string | undefined {
  const id = alarmId(alarmName);
  return ALARM_LABELS.find(([known]) => known === id)?.[1];
}

// SNS 제목은 줄바꿈을 허락하지 않으므로 공백 문자를 한 칸으로 합침
function firstSentence(value: string | undefined): string | undefined {
  const sentence = value
    ?.split(/[.!?](?:\s|$)/, 1)[0]
    ?.replace(/\s+/g, " ")
    .trim();
  return sentence || undefined;
}

function formatKst(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시각 확인 필요";

  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  const year = kst.getUTCFullYear();
  const month = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(kst.getUTCDate()).padStart(2, "0");
  const hour = String(kst.getUTCHours()).padStart(2, "0");
  const minute = String(kst.getUTCMinutes()).padStart(2, "0");
  const second = String(kst.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second} KST`;
}

function reasonLabel(alarmName: string): string {
  const id = alarmId(alarmName);
  if (!knownAlarmLabel(alarmName)) {
    return "설정된 운영 경보 조건을 충족했습니다.";
  }
  if (id === "OpsApiErrors") {
    return "운영 API 5xx 오류 또는 권한 거부(401·403) 요청이 기준을 넘었습니다. CloudWatch 로그를 확인해 주세요.";
  }
  if (id.endsWith("Errors")) {
    return "최근 실행에서 오류가 1회 이상 감지되었습니다.";
  }
  if (id.endsWith("Stopped")) {
    return "정해진 평가 구간 동안 실행 기록이 확인되지 않았습니다.";
  }
  if (id === "LoginAbuse") {
    return "5분 동안 로그인 실패 또는 비밀번호 찾기·변경 요청이 기준을 넘었습니다. 차단은 Cognito 잠금·요청 제한이 하고 있습니다.";
  }
  if (id === "WeatherFailing") {
    return "1시간 구간에 오류가 있거나 실행이 없는 구간이 3번 이어졌습니다.";
  }
  if (id === "NotificationFailed") {
    return "재시도 뒤에도 알림을 보내지 못해 실패 대기열에 기록되었습니다.";
  }
  if (id === "InquiryEmailOverdue") {
    return "89일 이상 남은 문의 이메일 항목이 감지되었거나 일일 정리에 실패했습니다. CloudWatch 로그와 InquiryTable을 확인해 주세요.";
  }
  return "설정된 운영 경보 조건을 충족했습니다.";
}

function cloudWatchUrl(region: string, alarmName: string): string {
  return (
    `https://${region}.console.aws.amazon.com/cloudwatch/deeplink.js` +
    `?region=${region}#alarmsV2:alarm/${encodeURIComponent(alarmName)}`
  );
}

export function formatAlarmNotification(
  event: CloudWatchAlarmEvent,
): AlarmNotification {
  const { alarmName, configuration, state } = event.detail;
  const description = configuration?.description?.trim();
  const title =
    knownAlarmLabel(alarmName) ?? firstSentence(description) ?? "운영 경보";
  const subject = `[바라던 바다] ${title} · 경보 발생`.slice(0, 99);

  return {
    subject,
    message: [
      "바라던 바다 운영 경보가 발생했습니다.",
      "",
      `경보: ${title}`,
      "상태: 경보 발생",
      `발생 시각: ${formatKst(state.timestamp ?? event.time)}`,
      `설명: ${description ?? "등록된 설명이 없습니다."}`,
      `판정: ${reasonLabel(alarmName)}`,
      `리전: ${event.region === "ap-northeast-2" ? `서울 (${event.region})` : event.region}`,
      "",
      `CloudWatch에서 확인: ${cloudWatchUrl(event.region, alarmName)}`,
    ].join("\n"),
  };
}

export async function sendAlarmNotification(
  event: CloudWatchAlarmEvent,
  sns: SNSClient,
  topicArn: string,
): Promise<void> {
  const notification = formatAlarmNotification(event);
  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: notification.subject,
      Message: notification.message,
    }),
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경 변수 없음: ${name}`);
  return value;
}

const sns = new SNSClient({});

export async function alarmNotificationHandler(
  event: CloudWatchAlarmEvent,
): Promise<void> {
  await sendAlarmNotification(event, sns, requiredEnv("OPS_TOPIC_ARN"));
}
