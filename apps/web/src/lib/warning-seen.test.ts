import type { WarningItem } from "@baradun/contracts";
import { describe, expect, it } from "vitest";

import { rememberSeen } from "./warning-seen";

// 특보 상세 시트의 확인 시각 (BRD-33 · B5, Codex P2)
const WIND: WarningItem = {
  zoneCode: "S1151200",
  zoneName: "강원중부앞바다",
  type: "wind_wave",
  level: "advisory",
  publishedAt: "2026-10-17T05:00:00Z",
  effectiveFrom: "2026-10-17T06:00:00Z",
} as WarningItem;
const AT_1430 = "2026-10-17T05:30:00Z";
const AT_1435 = "2026-10-17T05:35:00Z";

describe("rememberSeen", () => {
  it("목록에 있으면 지금 확인 시각", () => {
    expect(rememberSeen(null, WIND, [WIND], AT_1430)).toEqual({
      item: WIND,
      confirmedAt: AT_1430,
    });
  });

  it("다음 조회에서 목록에서 빠지면 마지막으로 있던 확인 시각 유지", () => {
    const seen = rememberSeen(null, WIND, [WIND], AT_1430);
    expect(rememberSeen(seen, WIND, [], AT_1435)?.confirmedAt).toBe(AT_1430);
  });

  it("단계가 바뀌어 같은 특보가 아니면 빠진 것으로 봄", () => {
    const seen = rememberSeen(null, WIND, [WIND], AT_1430);
    const warning = { ...WIND, level: "warning" } as WarningItem;
    expect(rememberSeen(seen, WIND, [warning], AT_1435)?.confirmedAt).toBe(
      AT_1430,
    );
  });

  it("조회마다 새 객체여도 값이 같으면 같은 특보로 갱신", () => {
    const seen = rememberSeen(null, WIND, [WIND], AT_1430);
    expect(rememberSeen(seen, WIND, [{ ...WIND }], AT_1435)?.confirmedAt).toBe(
      AT_1435,
    );
  });

  it("바뀐 것이 없으면 이전 값 그대로(렌더 중 갱신 반복 방지)", () => {
    const seen = rememberSeen(null, WIND, [WIND], AT_1430);
    expect(rememberSeen(seen, WIND, [WIND], AT_1430)).toBe(seen);
  });

  it("목록에 있던 적이 없거나 다른 특보의 기억이면 확인 시각 모름", () => {
    expect(rememberSeen(null, WIND, [], AT_1435)).toBeNull();
    const other = { ...WIND, zoneCode: "S1131100" } as WarningItem;
    const seenOther = rememberSeen(null, other, [other], AT_1430);
    expect(rememberSeen(seenOther, WIND, [], AT_1435)).toBeNull();
  });

  it("특보를 고르지 않았으면 null", () => {
    expect(rememberSeen(null, null, [WIND], AT_1430)).toBeNull();
  });
});
