import { describe, expect, it } from "vitest";

import {
  hasUnavailableMark,
  UNAVAILABLE_PARAM,
  withoutUnavailableMark,
} from "./page-unavailable";

// 열지 못한 화면 안내 표식 (BRD-106 결정 29)
describe("hasUnavailableMark", () => {
  it("?unavailable=1일 때만 표식으로 봄", () => {
    expect(UNAVAILABLE_PARAM).toBe("unavailable");
    expect(hasUnavailableMark("?unavailable=1")).toBe(true);
    expect(hasUnavailableMark("?q=a&unavailable=1")).toBe(true);
  });

  it("값이 다르거나 없으면 표식이 아님", () => {
    for (const search of [
      "",
      "?",
      "?unavailable",
      "?unavailable=",
      "?unavailable=0",
      "?unavailable=true",
      "?Unavailable=1",
      "?q=unavailable%3D1",
    ]) {
      expect(hasUnavailableMark(search), search).toBe(false);
    }
  });
});

describe("withoutUnavailableMark", () => {
  it("표식만 지우고 경로·다른 검색어·#은 남김", () => {
    expect(withoutUnavailableMark("https://x.test/?unavailable=1")).toBe("/");
    expect(withoutUnavailableMark("https://x.test/en/?unavailable=1")).toBe(
      "/en/",
    );
    expect(
      withoutUnavailableMark("https://x.test/?a=1&unavailable=1#top"),
    ).toBe("/?a=1#top");
    expect(withoutUnavailableMark("https://x.test/?a=1")).toBe("/?a=1");
  });
});
