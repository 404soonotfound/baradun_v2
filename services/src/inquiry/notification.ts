import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { Activity, BeachId, InquiryType } from "@baradun/contracts";
import { INQUIRY_SUMMARY_MAX_LENGTH } from "./policy";
import { InquiryStore } from "./store";

const TYPE_LABEL: Record<InquiryType, string> = {
  data_error: "정보가 실제와 다름",
  data_question: "판단 기준 질문",
  beach_request: "해변 추가 요청",
  data_suggestion: "새 데이터 제안",
};

const ACTIVITY_LABEL: Record<Activity, string> = {
  swimming: "수영",
  surfing: "서핑",
  scuba: "스쿠버다이빙",
};

export interface InquiryNotification {
  readonly inquiryId: string;
  readonly type: InquiryType;
  readonly message: string;
  readonly beachId?: BeachId;
  readonly activity?: Activity;
  readonly hasEmail: boolean;
  readonly receivedAt: Date;
}

export type NotificationResult = "sent" | "daily_limit" | "failed";

export class InquiryNotifier {
  constructor(
    private readonly sns: SNSClient,
    private readonly topicArn: string,
    private readonly store: InquiryStore,
  ) {}

  async notify(value: InquiryNotification): Promise<NotificationResult> {
    if (!(await this.store.allowNotification(value.receivedAt))) {
      return "daily_limit";
    }

    const summary = value.message
      .replace(/\s+/g, " ")
      .trim()
      .replace(
        /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
        "[이메일 생략]",
      )
      .slice(0, INQUIRY_SUMMARY_MAX_LENGTH);
    try {
      await this.sns.send(
        new PublishCommand({
          TopicArn: this.topicArn,
          Subject: "바라던 바다 데이터 문의 접수",
          Message: [
            `문의 ID: ${value.inquiryId}`,
            `유형: ${TYPE_LABEL[value.type]}`,
            ...(value.beachId ? [`해변: ${value.beachId}`] : []),
            ...(value.activity ? [`활동: ${ACTIVITY_LABEL[value.activity]}`] : []),
            `짧은 요약: ${summary}`,
            `이메일 제공 여부: ${value.hasEmail ? "예" : "아니오"}`,
          ].join("\n"),
        }),
      );
      return "sent";
    } catch {
      return "failed";
    }
  }
}
