import type { SNSClient } from "@aws-sdk/client-sns";
import { describe, expect, it } from "vitest";
import { InquiryNotifier } from "./notification";
import type { InquiryStore } from "./store";

describe("문의 메일 알림", () => {
  it("짧은 요약과 이메일 제공 여부만 보낸다", async () => {
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
    const longMessage = `앞부분 secret@example.com ${"가".repeat(200)} 뒷부분`;

    expect(
      await notifier.notify({
        inquiryId: "123e4567-e89b-42d3-a456-426614174000",
        type: "data_question",
        message: longMessage,
        beachId: "b0001",
        activity: "surfing",
        hasEmail: true,
        receivedAt: new Date("2026-10-26T00:00:00.000Z"),
      }),
    ).toBe("sent");

    const message = String(commands[0]?.input.Message);
    expect(message).toContain("유형: 판단 기준 질문");
    expect(message).toContain("해변: b0001");
    expect(message).toContain("활동: 서핑");
    expect(message).toContain("이메일 제공 여부: 예");
    expect(message).toContain("문의 ID: 123e4567-e89b-42d3-a456-426614174000");
    expect(message).not.toContain("뒷부분");
    expect(message).not.toContain("@");
    expect(message).toContain("[이메일 생략]");
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
        message: "문의",
        hasEmail: false,
        receivedAt: new Date(),
      }),
    ).toBe("daily_limit");
  });
});
