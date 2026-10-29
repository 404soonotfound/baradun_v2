import { describe, expect, it } from "vitest";

import { photoSourceUrl, TOUR_API_URL } from "./photo-credit";

// 해변 사진 출처 링크 (BRD-113 · 공공누리 제1유형: 링크가 가능하면 출처 링크)
describe("photoSourceUrl", () => {
  it("원본 페이지가 있으면 그 주소", () => {
    expect(
      photoSourceUrl({
        source: "한국관광공사",
        pageUrl: "https://example.test/photo/1",
      }),
    ).toBe("https://example.test/photo/1");
  });

  it("원본 페이지가 없는 한국관광공사 사진은 TourAPI 안내 주소", () => {
    expect(photoSourceUrl({ source: "한국관광공사" })).toBe(TOUR_API_URL);
    expect(TOUR_API_URL).toBe(
      "https://www.data.go.kr/data/15101578/openapi.do",
    );
  });

  it("모르는 출처는 링크를 지어내지 않음", () => {
    expect(photoSourceUrl({ source: "다른 기관" })).toBeNull();
    expect(photoSourceUrl({ source: "" })).toBeNull();
  });

  it("빈 원본 주소는 없는 것으로 봄", () => {
    expect(photoSourceUrl({ source: "다른 기관", pageUrl: "" })).toBeNull();
  });
});
