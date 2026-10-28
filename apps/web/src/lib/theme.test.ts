import { describe, expect, it } from "vitest";

import { resolveTheme } from "./theme";

// 지금 그려지는 테마 (BRD-44): 토큰 CSS(data-theme · prefers-color-scheme)와 같은 규칙이어야 지도 색이 화면과 맞음

describe("resolveTheme", () => {
  it("설정에서 고른 밝게·어둡게는 기기 설정보다 앞선다", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("고른 값이 없으면(기기 설정 따르기) 기기 설정을 따른다", () => {
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
  });

  it("모르는 값·빈 값은 고른 값이 없는 것으로 보고 기기 설정을 따른다(토큰 CSS도 같은 규칙)", () => {
    expect(resolveTheme("", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("DARK", false)).toBe("light");
  });
});
