import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import en from "../../messages/en.json";

// 특보 영어 이름표는 기상청 영문 특보 전문(CAP) 표기를 따름(결정 37, BRD-125)
// 예: KR.W2607180_202607121000_HWU_180_EN.xml의 'Heat Emergency Warning'. 'severe warning'으로 되돌리지 않음
describe("특보 영어 이름표", () => {
  const t = createTranslator({ locale: "en", messages: en });
  const title = (type: string, level: string) =>
    t("verdict.warning.title", { type, level });

  it("중대경보는 emergency warning", () => {
    expect(
      title(t("warning.type.tsunami"), t("warning.level.severe_warning")),
    ).toBe("Tsunami emergency warning");
  });

  it("주변 특보 폭염은 기상청 표기(Heat)를 따름", () => {
    expect(
      title(
        t("warning.nearbyType.heat_wave"),
        t("warning.level.severe_warning"),
      ),
    ).toBe("Heat emergency warning");
    expect(
      title(t("warning.nearbyType.heat_wave"), t("warning.level.advisory")),
    ).toBe("Heat advisory");
  });
});
