import { describe, expect, it } from "vitest";

import { countByStatus } from "@/lib/status-count";
import type { BadgeLabel, BeachView, Category } from "@/lib/snapshot/view";

// 테스트용 화면 상태. 개수 세기에 쓰지 않는 칸은 빈 값
function ready(category: Category, badge: BadgeLabel): BeachView {
  return {
    kind: "ready",
    category,
    badge,
    reasons: [badge],
    stale: false,
    confirmedAt: null,
    metrics: {
      waveHeight: { kind: "hidden" },
      wavePeriod: { kind: "hidden" },
      waveDirection: { kind: "hidden" },
      waterTemp: { kind: "hidden" },
      wind: { kind: "hidden" },
    },
  };
}

const clear = ready("clear", { kind: "clear" });
const strongWind = ready("unavailable", {
  kind: "warning",
  type: "strong_wind",
  level: "advisory",
});
const unknown = ready("undetermined", { kind: "warning_unknown" });
const delayed = ready("undetermined", { kind: "observation_delayed" });

describe("countByStatus", () => {
  it("특보 없음 → 이용불가 → 판단불가 순, 같은 사유는 한 칸", () => {
    const counts = countByStatus([delayed, clear, unknown, strongWind, clear]);
    expect(
      counts?.map((item) => [item.category, item.label.kind, item.count]),
    ).toEqual([
      ["clear", "clear", 2],
      ["unavailable", "warning", 1],
      ["undetermined", "observation_delayed", 1],
      ["undetermined", "warning_unknown", 1],
    ]);
  });

  it("특보는 종류가 다르면 다른 칸", () => {
    const windWave = ready("unavailable", {
      kind: "warning",
      type: "wind_wave",
      level: "advisory",
    });
    expect(countByStatus([strongWind, windWave])).toHaveLength(2);
  });

  it("하나라도 불러오는 중이면 null, 노출 끈 해변은 빼고 셈", () => {
    expect(countByStatus([clear, { kind: "loading" }])).toBeNull();
    expect(countByStatus([clear, { kind: "hidden" }])).toEqual([
      { category: "clear", label: { kind: "clear" }, count: 1 },
    ]);
  });
});
