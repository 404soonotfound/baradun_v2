import { describe, expect, it } from "vitest";

import { cardMetric, timeGroups } from "@/lib/near-metric";

describe("cardMetric", () => {
  const value = {
    kind: "value",
    value: 21,
    unit: "°C",
    observedAt: "2026-10-29T05:00:00Z",
  } as const;

  it("측정소가 있는 값은 값과 단위", () => {
    expect(cardMetric(value, true)).toEqual(value);
  });

  it("측정소 정보가 없는 값은 결측(–)으로, 0이나 정상으로 바꾸지 않음", () => {
    expect(cardMetric(value, false)).toEqual({ kind: "missing" });
  });

  it("가까운 관측 없음·늦어짐·읽을 수 없음을 서로 구분해 남김", () => {
    expect(cardMetric({ kind: "none" }, true)).toEqual({ kind: "none" });
    expect(cardMetric({ kind: "delayed" }, true)).toEqual({ kind: "delayed" });
    expect(cardMetric({ kind: "hidden" }, true)).toEqual({ kind: "missing" });
  });

  it("아직 받지 못했으면 loading", () => {
    expect(cardMetric(null, true)).toEqual({ kind: "loading" });
  });
});

describe("timeGroups (지표별 관측 시각, Codex P1)", () => {
  const now = Date.parse("2026-10-29T06:00:00Z");

  it("모두 같은 시각이면 한 묶음(한 번만 'n분 전 측정')", () => {
    expect(
      timeGroups(
        [
          { key: "waveHeight", observedAt: "2026-10-29T05:40:00Z" },
          { key: "waterTemp", observedAt: "2026-10-29T05:40:00Z" },
          { key: "wind", observedAt: "2026-10-29T05:40:00Z" },
        ],
        now,
      ),
    ).toEqual([{ keys: ["waveHeight", "waterTemp", "wind"], minutes: 20 }]);
  });

  it("시각이 다르면 처음 나온 순으로 나누고, 같은 시각끼리 묶음", () => {
    expect(
      timeGroups(
        [
          { key: "waveHeight", observedAt: "2026-10-29T05:50:00Z" },
          { key: "waterTemp", observedAt: "2026-10-29T05:00:00Z" },
          { key: "wind", observedAt: "2026-10-29T05:00:00Z" },
        ],
        now,
      ),
    ).toEqual([
      { keys: ["waveHeight"], minutes: 10 },
      { keys: ["waterTemp", "wind"], minutes: 60 },
    ]);
  });

  it("값이 없는 지표는 부르는 쪽이 빼고 넘김(결측이 섞여도 남은 값의 시각만), 읽을 수 없는 시각은 null 묶음", () => {
    // 파고 결측 → 수온만 넘어옴
    expect(
      timeGroups(
        [{ key: "waterTemp", observedAt: "2026-10-29T05:30:00Z" }],
        now,
      ),
    ).toEqual([{ keys: ["waterTemp"], minutes: 30 }]);
    expect(
      timeGroups(
        [
          { key: "waveHeight", observedAt: "2026-10-29T05:50:00Z" },
          { key: "wind", observedAt: "모름" },
        ],
        now,
      ),
    ).toEqual([
      { keys: ["waveHeight"], minutes: 10 },
      { keys: ["wind"], minutes: null },
    ]);
    expect(timeGroups([], now)).toEqual([]);
  });
});
