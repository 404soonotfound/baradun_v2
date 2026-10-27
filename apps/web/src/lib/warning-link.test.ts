import { describe, expect, it } from "vitest";

import { WARNING_TYPES } from "./snapshot/view";
import {
  KMA_TSUNAMI_URL,
  KMA_WARNING_TEXT_URL,
  kmaOriginalUrl,
} from "./warning-link";

// '기상청 원문 보기' 주소 (BRD-33 · 10/27 ④)
describe("kmaOriginalUrl", () => {
  it("지진해일은 지진·지진해일 최근 발표", () => {
    expect(kmaOriginalUrl("tsunami")).toBe(KMA_TSUNAMI_URL);
  });

  it("나머지 4종은 특보 통보문", () => {
    for (const type of WARNING_TYPES.filter((item) => item !== "tsunami")) {
      expect(kmaOriginalUrl(type)).toBe(KMA_WARNING_TEXT_URL);
    }
  });

  it("기상청 공식 주소(https, weather.go.kr)만 씀", () => {
    for (const type of WARNING_TYPES) {
      expect(new URL(kmaOriginalUrl(type)).origin).toBe(
        "https://www.weather.go.kr",
      );
    }
  });
});
