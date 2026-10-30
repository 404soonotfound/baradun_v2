import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { InquiryType } from "@baradun/contracts";
import { InquiryStore } from "./store";

const TYPE_LABEL: Record<InquiryType, string> = {
  data_error: "정보가 실제와 다름",
  data_question: "판단 기준 질문",
  beach_request: "해변 추가 요청",
  data_suggestion: "새 데이터 제안",
};

export interface InquiryNotification {
  readonly inquiryId: string;
  readonly type: InquiryType;
  readonly receivedAt: Date;
  readonly hasEmail: boolean;
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

    try {
      await this.sns.send(
        new PublishCommand({
          TopicArn: this.topicArn,
          Subject: "바라던 바다 데이터 문의 접수",
          Message: [
            `문의 ID: ${value.inquiryId}`,
            `유형: ${TYPE_LABEL[value.type]}`,
            `접수 시각: ${value.receivedAt.toISOString()}`,
            `이메일 제공 여부: ${value.hasEmail ? "있음" : "없음"}`,
          ].join("\n"),
        }),
      );
      return "sent";
    } catch {
      return "failed";
    }
  }
}
