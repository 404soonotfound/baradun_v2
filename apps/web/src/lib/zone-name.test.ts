import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { zoneNameText, zoneScopeText } from "./zone-name";
import { ZONE_NAMES_EN } from "./zone-names-en";

// 특보 구역 이름 (BRD-33·48): 번역표 조회, 표에 없거나 이름이 어긋나면 원문
const zone = { zoneCode: "S1151200", zoneName: "강원중부앞바다" };
const TABLE = {
  S1151200: { ko: "강원중부앞바다", en: "Nearshore waters of central Gangwon" },
};

describe("zoneNameText", () => {
  it("한국어 화면은 원문 그대로", () => {
    expect(zoneNameText(zone, "ko", TABLE)).toEqual({
      text: "강원중부앞바다",
      untranslated: false,
    });
  });

  it("영어 화면: 번역표에 있으면 영어 이름", () => {
    expect(zoneNameText(zone, "en", TABLE)).toEqual({
      text: "Nearshore waters of central Gangwon",
      untranslated: false,
    });
  });

  it("영어 화면: 번역표에 없으면 원문 + 원문 표시", () => {
    expect(zoneNameText(zone, "en", {})).toEqual({
      text: "강원중부앞바다",
      untranslated: true,
    });
  });

  it("게시된 이름이 표의 한국어 이름과 다르면 영어로 바꾸지 않음", () => {
    expect(
      zoneNameText(
        { zoneCode: "S1151200", zoneName: "강원중부먼바다" },
        "en",
        TABLE,
      ),
    ).toEqual({ text: "강원중부먼바다", untranslated: true });
  });

  it("지진해일(구역 코드 없음)은 표를 찾지 않고 원문", () => {
    expect(
      zoneNameText({ zoneCode: null, zoneName: "동해안" }, "en", TABLE),
    ).toEqual({ text: "동해안", untranslated: true });
  });

  it("기본 번역표: 기상청 영어 이름이 있는 구역은 영어", () => {
    expect(zoneNameText(zone, "en")).toEqual({
      text: "Nearshore waters of central Gangwon",
      untranslated: false,
    });
  });

  it("기본 번역표: 영어 이름을 아직 못 찾은 구역(부산앞바다)은 원문", () => {
    expect(
      zoneNameText({ zoneCode: "S1311100", zoneName: "부산앞바다" }, "en"),
    ).toEqual({ text: "부산앞바다", untranslated: true });
  });
});

describe("zoneScopeText", () => {
  it("한국어 화면은 원문 그대로", () => {
    expect(zoneScopeText("강원중부앞바다", "ko", TABLE)).toEqual({
      text: "강원중부앞바다",
      untranslated: false,
    });
  });

  it("영어 화면: 표의 한국어 이름과 정확히 같으면 영어 이름", () => {
    expect(zoneScopeText("강원중부앞바다", "en", TABLE)).toEqual({
      text: "Nearshore waters of central Gangwon",
      untranslated: false,
    });
  });

  it("영어 화면: 표에 없거나 글자가 조금이라도 다르면 원문 + 원문 표시", () => {
    expect(zoneScopeText("강원중부 앞바다", "en", TABLE)).toEqual({
      text: "강원중부 앞바다",
      untranslated: true,
    });
    expect(zoneScopeText("", "en", TABLE)).toEqual({
      text: "",
      untranslated: true,
    });
  });
});

// 번역표가 게시에 쓰는 공식 구역표(예보업무규정 별표5·9)와 어긋나지 않는지
describe("ZONE_NAMES_EN", () => {
  const annex = JSON.parse(
    readFileSync(
      new URL("../../../../tools/beaches/annex-tables.json", import.meta.url),
      "utf8",
    ),
  ) as {
    annex5: { zones: Record<string, { name: string }> };
    annex9: {
      sigungu: Record<string, { rows: { code: string; name: string }[] }>;
    };
  };
  const official: Record<string, string> = {};
  for (const [code, { name }] of Object.entries(annex.annex5.zones)) {
    official[code] = name;
  }
  for (const { rows } of Object.values(annex.annex9.sigungu)) {
    for (const { code, name } of rows) official[code] = name;
  }

  it("모든 코드가 공식 구역표에 있고 한국어 이름이 같음", () => {
    for (const [code, { ko }] of Object.entries(ZONE_NAMES_EN)) {
      expect(official[code], code).toBe(ko);
    }
  });

  it("영어 이름은 비어 있지 않고 한글을 담지 않음", () => {
    for (const [code, { en }] of Object.entries(ZONE_NAMES_EN)) {
      expect(en.trim(), code).not.toBe("");
      expect(/[가-힣]/.test(en), code).toBe(false);
    }
  });
});
