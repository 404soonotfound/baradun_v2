import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { InquiryType } from "@baradun/contracts";
import { INQUIRY_SUMMARY_MAX_LENGTH } from "./policy";
import { InquiryStore } from "./store";

const TYPE_LABEL: Record<InquiryType, string> = {
  data_error: "데이터 오류",
  data_question: "데이터 질문",
  other: "기타",
};

export interface InquiryNotification {
  readonly inquiryId: string;
  readonly type: InquiryType;
  readonly message: string;
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
