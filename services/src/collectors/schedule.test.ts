import { describe, expect, it } from "vitest";
import { COLLECT_POLICY } from "./policy";
import { formatKst, kstDaysBefore, slotStart } from "./schedule";

// 슬롯·KST 시각 (N3 실행 분)
const ms = (iso: string) => Date.parse(iso);

describe("slotStart", () => {
  it.each([
    ["2026-10-21T00:12:00Z", "202610210910"], // KST 09:12 → :10 슬롯
    ["2026-10-21T00:09:59Z", "202610210840"], // KST 09:09:59 → 앞 슬롯 :40
    ["2026-10-21T00:40:00Z", "202610210940"], // 경계 정각
  ])("ocean %s → %s", (now, slot) => {
    expect(
      formatKst(slotStart(ms(now), COLLECT_POLICY.oceanSchedule), "minute"),
    ).toBe(slot);
  });

  it.each([
    ["2026-10-21T00:02:00Z", "202610210848"],
    ["2026-10-21T00:03:00Z", "202610210903"],
    ["2026-10-21T00:47:59Z", "202610210933"],
  ])("warnings %s → %s", (now, slot) => {
    expect(
      formatKst(slotStart(ms(now), COLLECT_POLICY.warningsSchedule), "minute"),
    ).toBe(slot);
  });
});

describe("formatKst·kstDaysBefore", () => {
  it("UTC 15:00은 KST 다음 날 00:00", () => {
    expect(formatKst(ms("2026-10-20T15:00:00Z"), "minute")).toBe(
      "202610210000",
    );
    expect(formatKst(ms("2026-10-20T15:00:00Z"), "day")).toBe("20261021");
  });

  it("59일 전은 KST 날짜 기준", () => {
    expect(kstDaysBefore(ms("2026-10-20T15:00:00Z"), 59)).toBe("20260823");
  });
});
