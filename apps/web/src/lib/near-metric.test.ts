import { describe, expect, it } from "vitest";

import { cardMetric } from "@/lib/near-metric";

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
