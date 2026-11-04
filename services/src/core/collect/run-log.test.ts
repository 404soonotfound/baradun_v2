import { describe, expect, it } from "vitest";
import {
  collapseFailures,
  RUN_FAILURES_MAX,
  RUN_RECORD_RETENTION_MS,
  runLogPk,
  runLogSk,
  runRecordTtl,
} from "./run-log";

// 수집 실행 기록 (BRD-149)

describe("실행 기록 키", () => {
  it("수집기별 파티션, 시작 시각 순 정렬 키", () => {
    expect(runLogPk("collect-ocean")).toBe("collect#run#collect-ocean");
    expect(runLogSk("2026-11-04T05:10:00.000Z", "req-1")).toBe(
      "2026-11-04T05:10:00.000Z#req-1",
    );
  });

  it("8일 뒤 TTL(epoch 초)", () => {
    const now = Date.UTC(2026, 10, 4);
    expect(runRecordTtl(now)).toBe((now + RUN_RECORD_RETENTION_MS) / 1000);
    expect(RUN_RECORD_RETENTION_MS).toBe(8 * 24 * 60 * 60 * 1000);
  });
});

describe("collapseFailures", () => {
  it("같은 출처·사유·code는 해변 수로 묶고 처음 나온 순서를 지킨다", () => {
    expect(
      collapseFailures([
        { source: "rip", reason: "timeout" },
        { source: "rip", reason: "result:22", code: "22" },
        { source: "rip", reason: "timeout" },
        { source: "photo", reason: "unchecked", count: 3 },
        { source: "photo", reason: "unchecked", count: 2 },
      ]),
    ).toEqual([
      { source: "rip", reason: "timeout", count: 2 },
      { source: "rip", reason: "result:22", code: "22" },
      { source: "photo", reason: "unchecked", count: 5 },
    ]);
  });

  it("상한까지만 남기고 앞에 둔 사유(저장 실패 등)는 지킨다", () => {
    const many = Array.from({ length: RUN_FAILURES_MAX + 5 }, (_, i) => ({
      source: "rip",
      reason: `r${i}`,
    }));
    const kept = collapseFailures([
      { source: "storage", reason: "readings_not_saved" },
      ...many,
    ]);
    expect(kept).toHaveLength(RUN_FAILURES_MAX);
    expect(kept[0]).toEqual({
      source: "storage",
      reason: "readings_not_saved",
    });
  });
});
