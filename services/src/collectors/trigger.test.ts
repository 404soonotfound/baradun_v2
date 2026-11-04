import { describe, expect, it } from "vitest";
import { createLogger } from "../core/collect/log";
import type { CollectRunResult } from "./ocean";
import {
  finishRun,
  runCollector,
  triggerPublish,
  type FinishDeps,
} from "./trigger";

const FAILURES = [{ source: "sea_obs", reason: "timeout" }];

// 수집 뒤 publish-snapshot 깨우기 (BRD-61 PR ②)

function deps(
  invoke: () => Promise<void>,
  record: FinishDeps["record"] = async () => {},
) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      record,
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
      const result: CollectRunResult =
        status === "complete"
          ? { status, slotId: "s1" }
          : { status, slotId: "s1", failures: FAILURES };
      expect(await triggerPublish(result, d)).toBe(true);
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
      await expect(
        finishRun({ status, slotId: "s1", failures: FAILURES }, d),
      ).rejects.toThrow(`수집 ${status}: s1`);
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

// 실행 기록(BRD-149): 깨우기 전에 남기고, 실패해도 깨우기를 막지 않음
describe("finishRun 실행 기록", () => {
  it("슬롯을 맡은 실행은 깨우기 전에 결과를 그대로 기록함", async () => {
    const order: string[] = [];
    const recorded: CollectRunResult[] = [];
    const { deps: d } = deps(
      async () => {
        order.push("invoke");
      },
      async (result) => {
        order.push("record");
        recorded.push(result);
      },
    );
    const result = {
      status: "partial",
      slotId: "s1",
      failures: FAILURES,
    } as const;
    await expect(finishRun(result, d)).rejects.toThrow("수집 partial");
    expect(order).toEqual(["record", "invoke"]);
    expect(recorded).toEqual([result]);
  });

  it.each(["done", "busy", "off_season"] as const)(
    "다른 실행이 맡았거나 호출 없는 슬롯(%s)은 기록하지 않음",
    async (claim) => {
      let records = 0;
      const { deps: d } = deps(
        async () => {},
        async () => {
          records += 1;
        },
      );
      await finishRun({ status: "skipped", slotId: "s1", claim }, d);
      expect(records).toBe(0);
    },
  );

  it("기록 쓰기가 실패해도 오류 로그만 남기고 publisher를 깨움", async () => {
    let calls = 0;
    const { deps: d, lines } = deps(
      async () => {
        calls += 1;
      },
      async () => {
        throw Object.assign(new Error("throttled"), {
          name: "ProvisionedThroughputExceededException",
        });
      },
    );
    const result = { status: "complete", slotId: "s1" } as const;
    expect(await finishRun(result, d)).toEqual(result);
    expect(calls).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: "error",
      event: "run_record_failed",
      slotId: "s1",
      error: "ProvisionedThroughputExceededException",
    });
  });
});

// 수집 함수가 예외로 끝난 실행도 실패로 기록함(기록이 없으면 이전 정상 기록이 계속 '정상'으로 보임)
describe("runCollector", () => {
  it("예외로 끝나면 실패로 기록하고 그대로 던지며 깨우지 않음", async () => {
    let calls = 0;
    const recorded: unknown[] = [];
    const { deps: d } = deps(
      async () => {
        calls += 1;
      },
      async (result) => {
        recorded.push(result);
      },
    );
    const boom = Object.assign(new Error("throttled"), {
      name: "ProvisionedThroughputExceededException",
    });
    await expect(
      runCollector(async () => {
        throw boom;
      }, d),
    ).rejects.toBe(boom);
    expect(calls).toBe(0);
    expect(recorded).toEqual([
      {
        status: "failed",
        slotId: "",
        failures: [
          {
            source: "run",
            reason: "exception:ProvisionedThroughputExceededException",
          },
        ],
      },
    ]);
  });

  it("정상으로 끝나면 finishRun과 같이 기록하고 깨움", async () => {
    let calls = 0;
    let records = 0;
    const { deps: d } = deps(
      async () => {
        calls += 1;
      },
      async () => {
        records += 1;
      },
    );
    const result = { status: "complete", slotId: "s1" } as const;
    expect(await runCollector(async () => result, d)).toEqual(result);
    expect([records, calls]).toEqual([1, 1]);
  });
});
