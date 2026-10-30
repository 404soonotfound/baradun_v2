import type { SNSClient } from "@aws-sdk/client-sns";
import { describe, expect, it } from "vitest";
import { InquiryNotifier } from "./notification";
import type { InquiryStore } from "./store";

describe("문의 메일 알림", () => {
  it("문의 ID·유형·접수 시각·이메일 제공 여부만 보내고 본문·이메일·사진은 제외함 (BRD-120)", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const sns = {
      send: async (command: { input: Record<string, unknown> }) => {
        commands.push(command);
        return {};
      },
    } as unknown as SNSClient;
    const store = {
      allowNotification: async () => true,
    } as unknown as InquiryStore;
    const notifier = new InquiryNotifier(sns, "topic", store);

    // 이메일 제공 시 (hasEmail: true)
    expect(
      await notifier.notify({
        inquiryId: "123e4567-e89b-42d3-a456-426614174000",
        type: "data_question",
        hasEmail: true,
        receivedAt: new Date("2026-10-26T00:00:00.000Z"),
      }),
    ).toBe("sent");

    const message = String(commands[0]?.input.Message);
    expect(message).toBe(
      [
        "문의 ID: 123e4567-e89b-42d3-a456-426614174000",
        "유형: 판단 기준 질문",
        "접수 시각(UTC): 2026-10-26T00:00:00.000Z",
        "이메일 제공 여부: 있음",
      ].join("\n"),
    );

    // 이메일 미제공 시 (hasEmail: false)
    expect(
      await notifier.notify({
        inquiryId: "987e6543-e21b-42d3-a456-426614174999",
        type: "data_error",
        hasEmail: false,
        receivedAt: new Date("2026-10-26T12:34:56.000Z"),
      }),
    ).toBe("sent");

    const secondMessage = String(commands[1]?.input.Message);
    expect(secondMessage).toBe(
      [
        "문의 ID: 987e6543-e21b-42d3-a456-426614174999",
        "유형: 정보가 실제와 다름",
        "접수 시각(UTC): 2026-10-26T12:34:56.000Z",
        "이메일 제공 여부: 없음",
      ].join("\n"),
    );
  });

  it("하루 상한이면 SNS를 호출하지 않는다", async () => {
    const sns = {
      send: async () => {
        throw new Error("호출되면 안 됨");
      },
    } as unknown as SNSClient;
    const store = {
      allowNotification: async () => false,
    } as unknown as InquiryStore;
    const notifier = new InquiryNotifier(sns, "topic", store);
    expect(
      await notifier.notify({
        inquiryId: "123e4567-e89b-42d3-a456-426614174000",
        type: "data_suggestion",
        hasEmail: false,
        receivedAt: new Date(),
      }),
    ).toBe("daily_limit");
  });
});
