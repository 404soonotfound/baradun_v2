import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { beachZonesText, zoneNameText, zoneScopeText } from "./zone-name";
import { ZONE_NAMES_EN } from "./zone-names-en";
import { ZONE_NAMES_KO } from "./zone-names-ko";

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

  it("한국어 이름이 겹치지 않음(사유 범위는 이름으로만 찾음)", () => {
    const names = Object.values(ZONE_NAMES_EN).map((zone) => zone.ko);
    expect(new Set(names).size).toBe(names.length);
  });

  it("영어 이름은 비어 있지 않고 한글을 담지 않음", () => {
    for (const [code, { en }] of Object.entries(ZONE_NAMES_EN)) {
      expect(en.trim(), code).not.toBe("");
      expect(/[가-힣]/.test(en), code).toBe(false);
    }
  });
});

// 해변 특보구역 이름 (BRD-182 · 결정 기록 18장 D18-11): 근거 줄 '강원중부앞바다, 강릉평지'
describe("beachZonesText", () => {
  const zones = { sea: "S1151200", land: "L1022510" };
  const ko = { S1151200: "강원중부앞바다", L1022510: "강릉평지" };

  it("한국어 화면: 바다 → 육상 순으로 별표 이름", () => {
    expect(beachZonesText(zones, "ko", ko, {})).toBe(
      "강원중부앞바다, 강릉평지",
    );
  });

  it("영어 화면: 두 이름 모두 번역표에 있으면 영어 이름", () => {
    expect(
      beachZonesText(zones, "en", ko, {
        ...TABLE,
        L1022510: { ko: "강릉평지", en: "Flatland of Gangneung" },
      }),
    ).toBe("Nearshore waters of central Gangwon, Flatland of Gangneung");
  });

  it("영어 화면: 하나라도 번역표에 없으면 null(일반 이름을 씀)", () => {
    expect(beachZonesText(zones, "en", ko, TABLE)).toBeNull();
  });

  it("이름표에 없는 코드가 있으면 null(구역 이름을 지어내지 않음)", () => {
    expect(
      beachZonesText({ sea: "S1151200", land: "L9999999" }, "ko", ko, {}),
    ).toBeNull();
  });

  it("육상 구역이 없는 장소는 바다 구역만", () => {
    expect(beachZonesText({ sea: "S1151200" }, "ko", ko, {})).toBe(
      "강원중부앞바다",
    );
  });
});

describe("ZONE_NAMES_KO", () => {
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

  it("공식 구역표(별표5·9)와 코드·이름이 모두 같음", () => {
    expect(ZONE_NAMES_KO).toEqual(official);
  });

  it("data/beaches의 모든 해변 구역 코드에 이름이 있음", () => {
    const dir = new URL("../../../../data/beaches/", import.meta.url);
    const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const beach = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as {
        warningZones: { sea: string; land?: string };
      };
      expect(beachZonesText(beach.warningZones, "ko"), file).not.toBeNull();
    }
  });
});
