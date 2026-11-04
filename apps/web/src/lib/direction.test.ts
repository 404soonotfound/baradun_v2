import { describe, expect, it } from "vitest";

import { compassPoint } from "./direction";

// 16방위 (BRD-182 · D18-3): 파도 방향 칸 '남남동 쪽에서'
describe("compassPoint", () => {
  it("방위 한가운데 각도", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(90)).toBe("E");
    expect(compassPoint(157.5)).toBe("SSE");
    expect(compassPoint(180)).toBe("S");
    expect(compassPoint(337.5)).toBe("NNW");
  });

  it("칸 경계는 시계 방향 다음 칸, 360은 북", () => {
    expect(compassPoint(11.24)).toBe("N");
    expect(compassPoint(11.25)).toBe("NNE");
    expect(compassPoint(348.75)).toBe("N");
    expect(compassPoint(360)).toBe("N");
  });
});
