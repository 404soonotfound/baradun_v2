import { describe, expect, it } from "vitest";
import { BEACHES, ZONES } from "./fixtures";
import { zoneTablesFromAnnex } from "./zones";

// 공식 구역표 (별표5 앞바다·별표9 육상). 코드 → 공식 이름

describe("zoneTablesFromAnnex", () => {
  it("해변의 앞바다·육상 구역이 모두 표에 있음", () => {
    for (const beach of BEACHES) {
      expect(ZONES.sea[beach.warningZones.sea], beach.id).toBeTypeOf("string");
      if (beach.warningZones.land !== undefined) {
        expect(ZONES.land[beach.warningZones.land], beach.id).toBeTypeOf(
          "string",
        );
      }
    }
    expect(ZONES.sea.S1151200).toBe("강원중부앞바다");
    expect(ZONES.land.L1022510).toBe("강릉평지");
  });

  it("같은 육상 코드가 다른 이름으로 두 번 나오면 멈춤(이름을 골라 쓰지 않음)", () => {
    expect(() =>
      zoneTablesFromAnnex({
        annex5: { zones: {} },
        annex9: {
          sigungu: {
            a: { rows: [{ code: "L1000001", name: "가" }] },
            b: { rows: [{ code: "L1000001", name: "나" }] },
          },
        },
      }),
    ).toThrow(RangeError);
  });
});
