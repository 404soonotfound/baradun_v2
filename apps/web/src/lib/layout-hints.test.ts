import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { DEVICE_KEYS } from "./device-keys";
import {
  isOnboardingReferencePath,
  LANGUAGE_STORAGE_KEY,
  LAYOUT_HINT_SCRIPT,
  LOCATION_HINT_KEY,
  LOCATION_SWITCH_KEY,
  ONBOARDING_STORAGE_KEY,
  REGION_STORAGE_KEY,
} from "./layout-hints";
import { NOTICE_VERSION } from "./notice-version";
import { onboardingStep, parseRecord } from "./onboarding";

// 그리기 전 자리 잡기 힌트 스크립트를 가짜 document·localStorage·navigator 위에서 돌려 봄 (BRD-39)

function run({
  lang = "ko",
  pathname = "/",
  search = "",
  storage = {},
  languages = ["ko-KR"],
  blocked = false,
}: {
  lang?: string;
  pathname?: string;
  search?: string;
  storage?: Record<string, string>;
  languages?: string[];
  blocked?: boolean; // localStorage 접근이 오류(사생활 보호 모드 등)
}) {
  const attributes = new Map<string, string>([["lang", lang]]);
  const html = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
  const context: Record<string, unknown> = {
    document: { documentElement: html },
    location: { pathname, search },
    navigator: { languages, language: languages[0] },
  };
  Object.defineProperty(context, "localStorage", {
    get() {
      if (blocked) throw new Error("blocked");
      return { getItem: (key: string) => storage[key] ?? null };
    },
  });
  vm.runInNewContext(LAYOUT_HINT_SCRIPT, context);
  attributes.delete("lang");
  return Object.fromEntries(attributes);
}

describe("LAYOUT_HINT_SCRIPT", () => {
  // GH-218 CLS: 즐겨찾기 목록 자리 · 검색 결과 자리
  it("즐겨찾기 해변 수(문자열 id만, 4곳 이상은 4)", () => {
    const fav = (value: unknown) =>
      run({ storage: { [DEVICE_KEYS.favorites]: JSON.stringify(value) } })[
        "data-favorites"
      ];
    expect(fav(["b0001"])).toBe("1");
    expect(fav(["b0001", "b0002", "b0003"])).toBe("3");
    expect(fav(["a", "b", "c", "d", "e", "f"])).toBe("4");
    expect(fav(["b0001", 3, null])).toBe("1");
    expect(fav([])).toBeUndefined();
    expect(fav({ not: "list" })).toBeUndefined();
    expect(
      run({ storage: { [DEVICE_KEYS.favorites]: "{broken" } })[
        "data-favorites"
      ],
    ).toBeUndefined();
    // 최근 본 칸으로 열면 즐겨찾기 수로 자리를 잡지 않음
    const withTab = (pathname: string, search: string) =>
      run({
        pathname,
        search,
        storage: { [DEVICE_KEYS.favorites]: JSON.stringify(["b0001"]) },
      })["data-favorites"];
    expect(withTab("/favorites/", "?tab=recent")).toBeUndefined();
    expect(withTab("/en/favorites", "?x=1&tab=recent")).toBeUndefined();
    expect(withTab("/favorites/", "")).toBe("1");
    expect(withTab("/favorites/", "?tab=recently")).toBe("1");
  });

  it("탐색 보기를 '목록'으로 저장했을 때만 data-explore-view", () => {
    const view = (value: string | undefined) =>
      run({
        storage:
          value === undefined ? {} : { [DEVICE_KEYS.exploreView]: value },
      })["data-explore-view"];
    expect(view("list")).toBe("list");
    expect(view("map")).toBeUndefined();
    expect(view("<x>")).toBeUndefined();
    expect(view(undefined)).toBeUndefined();
  });

  it("검색 화면 주소에 검색어가 있을 때만 data-search-query", () => {
    const q = (pathname: string, search: string) =>
      "data-search-query" in run({ pathname, search });
    expect(q("/search/", "?q=%EC%96%91%EC%96%91")).toBe(true);
    expect(q("/en/search", "?tab=x&q=yang")).toBe(true);
    expect(q("/search/", "")).toBe(false);
    expect(q("/search/", "?q=")).toBe(false);
    // 공백만인 검색어는 화면이 입력 전으로 보므로 결과 자리를 잡지 않음
    expect(q("/search/", "?q=+")).toBe(false);
    expect(q("/search/", "?q=%20%20")).toBe(false);
    expect(q("/search/", "?q=%E0%A4%A")).toBe(false);
    expect(q("/explore/", "?q=yang")).toBe(false);
  });

  it("첫 방문은 위치를 못 쓴 것으로(off) 보고 다른 힌트는 붙이지 않음", () => {
    expect(run({})).toEqual({ "data-location-hint": "off" });
  });

  it("지난 방문에 위치를 썼으면 on, 스위치를 꺼 두었으면 off", () => {
    expect(run({ storage: { [LOCATION_HINT_KEY]: "on" } })).toMatchObject({
      "data-location-hint": "on",
    });
    expect(
      run({
        storage: { [LOCATION_HINT_KEY]: "on", [LOCATION_SWITCH_KEY]: "off" },
      }),
    ).toMatchObject({ "data-location-hint": "off" });
  });

  it("최근 본 해변 수는 1곳·2곳 이상으로만 나누고, 깨진 값은 없는 것으로 봄", () => {
    const recent = (raw: string) =>
      run({ storage: { [DEVICE_KEYS.recent]: raw } })["data-recent"];
    expect(recent('["b0001"]')).toBe("1");
    expect(recent('["b0001","b0002","b0003"]')).toBe("2");
    expect(recent("[]")).toBeUndefined();
    expect(recent("[1,2]")).toBeUndefined();
    // 깨진 JSON은 최근 본 힌트만 건너뜀
    expect(run({ storage: { [DEVICE_KEYS.recent]: "{" } })).toEqual({
      "data-location-hint": "off",
    });
  });

  it("기본 지역(전국 포함)을 고르면 표시", () => {
    expect(
      run({ storage: { [REGION_STORAGE_KEY]: '{"kind":"nationwide"}' } }),
    ).toHaveProperty("data-region-chosen", "");
  });

  it("언어 안내는 noticeTarget과 같은 규칙: 기기 첫 언어가 주소 언어와 다르고 고른 언어가 없을 때만", () => {
    expect(run({ lang: "en", languages: ["ko-KR", "en"] })).toHaveProperty(
      "data-language-notice",
      "ko",
    );
    expect(run({ lang: "ko", languages: ["en-US"] })).toHaveProperty(
      "data-language-notice",
      "en",
    );
    expect(run({ lang: "ko", languages: ["ko-KR"] })).not.toHaveProperty(
      "data-language-notice",
    );
    expect(run({ lang: "ko", languages: ["ja-JP", "en"] })).not.toHaveProperty(
      "data-language-notice",
    );
    expect(
      run({
        lang: "en",
        languages: ["ko-KR"],
        storage: { [LANGUAGE_STORAGE_KEY]: "en" },
      }),
    ).not.toHaveProperty("data-language-notice");
  });

  it("저장소를 못 읽어도 오류 없이 언어 안내만 판단", () => {
    expect(run({ lang: "en", languages: ["ko"], blocked: true })).toEqual({
      "data-language-notice": "ko",
    });
  });

  it("현재 고지 버전을 확인한 기기와 /guide·/terms 경로 판정이 onboarding 모듈과 같다", () => {
    const valid = JSON.stringify({
      noticeVersion: NOTICE_VERSION,
      acknowledgedAt: "2026-11-16T00:00:00Z",
      locationStepDone: true,
    });
    expect(
      run({ storage: { [ONBOARDING_STORAGE_KEY]: valid } }),
    ).toHaveProperty("data-onboarded", "");

    // parseRecord(isTime·버전·타입) 결과와 LAYOUT_HINT_SCRIPT 판정이 모든 경계 입력에서 일치해야 함
    const storageCases = [
      valid,
      JSON.stringify({
        noticeVersion: NOTICE_VERSION,
        acknowledgedAt: "2026-11-16T09:00:00+09:00",
        locationStepDone: false,
      }),
      JSON.stringify({
        noticeVersion: NOTICE_VERSION,
        acknowledgedAt: "not-a-time",
        locationStepDone: true,
      }),
      JSON.stringify({
        noticeVersion: NOTICE_VERSION,
        acknowledgedAt: "2026-02-30T00:00:00Z",
        locationStepDone: true,
      }),
      JSON.stringify({
        noticeVersion: NOTICE_VERSION,
        acknowledgedAt: "2026-11-16T00:00:00",
        locationStepDone: true,
      }),
      JSON.stringify({
        noticeVersion: NOTICE_VERSION,
        acknowledgedAt: "2026-11-16T00:00:00Z",
        locationStepDone: "yes",
      }),
      JSON.stringify({
        noticeVersion: NOTICE_VERSION - 1,
        acknowledgedAt: "2026-11-16T00:00:00Z",
        locationStepDone: true,
      }),
      "{",
    ];
    for (const raw of storageCases) {
      const expectedHidden =
        onboardingStep(parseRecord(raw), "idle") !== "notice";
      const attrs = run({ storage: { [ONBOARDING_STORAGE_KEY]: raw } });
      expect("data-onboarded" in attrs).toBe(expectedHidden);
    }

    // 안내 경로 판정도 React(isOnboardingReferencePath)와 정확히 같아야 함
    for (const pathname of [
      "/guide/",
      "/guide",
      "/terms/",
      "/en/guide/",
      "/en/terms/",
      "/other/guide/",
      "/guide/sub/",
      "/spots/gangmun/",
      "/",
    ]) {
      const attrs = run({ pathname });
      expect("data-onboarded" in attrs).toBe(
        isOnboardingReferencePath(pathname),
      );
    }
  });
});
