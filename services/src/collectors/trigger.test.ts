import { describe, expect, it } from "vitest";
import { createLogger } from "../core/collect/log";
import { finishRun, triggerPublish } from "./trigger";

// 수집 뒤 publish-snapshot 깨우기 (BRD-61 PR ②)

function deps(invoke: () => Promise<void>) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      invoke,
      log: createLogger(
        () => [],
        (line) => lines.push(line),
      ),
    },
  };
}

describe("triggerPublish", () => {
  it.each(["complete", "partial", "failed"] as const)(
    "이번 실행이 슬롯을 맡았으면(%s) 깨움",
    async (status) => {
      let calls = 0;
      const { deps: d } = deps(async () => {
        calls += 1;
      });
      expect(await triggerPublish({ status, slotId: "s1" }, d)).toBe(true);
      expect(calls).toBe(1);
    },
  );

  it.each(["done", "busy"] as const)(
    "다른 실행이 맡은 슬롯(%s)은 깨우지 않음",
    async (claim) => {
      let calls = 0;
      const { deps: d } = deps(async () => {
        calls += 1;
      });
      expect(
        await triggerPublish({ status: "skipped", slotId: "s1", claim }, d),
      ).toBe(false);
      expect(calls).toBe(0);
    },
  );

  it("깨우기 실패는 오류 로그를 남기고 던짐(조용히 넘어가지 않음)", async () => {
    const { deps: d, lines } = deps(async () => {
      throw Object.assign(new Error("denied"), {
        name: "AccessDeniedException",
      });
    });
    await expect(
      triggerPublish({ status: "complete", slotId: "s1" }, d),
    ).rejects.toThrow("denied");
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "error",
      event: "publish_trigger_failed",
      slotId: "s1",
      error: "AccessDeniedException",
    });
  });
});

describe("finishRun", () => {
  it.each(["partial", "failed"] as const)(
    "다 저장하지 못한 실행(%s)도 먼저 깨우고 그 뒤에 던짐",
    async (status) => {
      let calls = 0;
      const { deps: d } = deps(async () => {
        calls += 1;
      });
      await expect(finishRun({ status, slotId: "s1" }, d)).rejects.toThrow(
        `수집 ${status}: s1`,
      );
      expect(calls).toBe(1);
    },
  );

  it("complete는 깨우고 결과를 돌려줌", async () => {
    let calls = 0;
    const { deps: d } = deps(async () => {
      calls += 1;
    });
    const result = { status: "complete", slotId: "s1" } as const;
    expect(await finishRun(result, d)).toEqual(result);
    expect(calls).toBe(1);
  });
});
