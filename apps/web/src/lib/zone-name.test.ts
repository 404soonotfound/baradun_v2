import { describe, expect, it } from "vitest";

import { zoneNameText } from "./zone-name";

// 특보 구역 이름 (BRD-33): 번역표 조회, 표가 없으면 원문(번역표 자체는 BRD-48)
const zone = { zoneCode: "S1151200", zoneName: "강원중부앞바다" };
const TABLE = { S1151200: "Gangwon Central Coastal Waters" };

describe("zoneNameText", () => {
  it("한국어 화면은 원문 그대로", () => {
    expect(zoneNameText(zone, "ko", TABLE)).toEqual({
      text: "강원중부앞바다",
      untranslated: false,
    });
  });

  it("영어 화면: 번역표에 있으면 영어 이름", () => {
    expect(zoneNameText(zone, "en", TABLE)).toEqual({
      text: "Gangwon Central Coastal Waters",
      untranslated: false,
    });
  });

  it("영어 화면: 번역표에 없으면 원문 + 원문 표시", () => {
    expect(zoneNameText(zone, "en", {})).toEqual({
      text: "강원중부앞바다",
      untranslated: true,
    });
  });

  it("지진해일(구역 코드 없음)은 표를 찾지 않고 원문", () => {
    expect(
      zoneNameText({ zoneCode: null, zoneName: "동해안" }, "en", TABLE),
    ).toEqual({ text: "동해안", untranslated: true });
  });

  it("지금 기본 번역표는 비어 있어 영어 화면도 원문", () => {
    expect(zoneNameText(zone, "en").untranslated).toBe(true);
  });
});
