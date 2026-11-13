import { describe, expect, it } from "vitest";
import {
  beachLabel,
  metadataReasons,
  sharePercent,
  sumMetric,
} from "./stats";

describe("이용 통계 계산 도우미 (#333)", () => {
  it("빈 값(null)과 합계 0은 0%로 추정하지 않고 null을 유지함", () => {
    expect(sharePercent(null, 100)).toBeNull();
    expect(sharePercent(10, null)).toBeNull();
    expect(sharePercent(10, 0)).toBeNull();
    expect(sharePercent(25, 100)).toBe(25);
    expect(sumMetric([null, null])).toBeNull();
    expect(sumMetric([10, null, 20])).toBe(30);
  });

  it("GA4 metadata 제한 플래그는 true인 항목만 반환함(E8)", () => {
    expect(
      metadataReasons({
        thresholding: false,
        sampling: false,
        otherRowLoss: false,
      }),
    ).toEqual([]);
    expect(
      metadataReasons({
        thresholding: true,
        sampling: false,
        otherRowLoss: true,
      }),
    ).toEqual(["thresholding", "otherRowLoss"]);
  });

  it("해변 slug로 이름·지역을 찾고 없으면 slug/path를 그대로 씀", () => {
    const bySlug = {
      haeundae: {
        id: "b0091",
        name: "해운대해수욕장",
        region: "부산 해운대구",
        hidden: false,
      },
    };
    expect(
      beachLabel(
        { path: "/spots/haeundae", slug: "haeundae", pageViews: 10 },
        bySlug,
      ),
    ).toEqual({ title: "해운대해수욕장", region: "부산 해운대구" });
    expect(
      beachLabel(
        { path: "/spots/unknown", slug: "unknown", pageViews: 3 },
        bySlug,
      ),
    ).toEqual({ title: "unknown", region: null });
  });
});
