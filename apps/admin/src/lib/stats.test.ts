import { describe, expect, it } from "vitest";
import { localStatsView } from "./auth/local-stats";
import {
  beachLabel,
  metadataReasons,
  perUser,
  sharePercent,
  sumMetric,
  validStats,
} from "./stats";

describe("이용 통계 계산 도우미 (#333)", () => {
  it("빈 값(null)과 합계 0은 0%로 추정하지 않고 null을 유지함", () => {
    expect(sharePercent(null, 100)).toBeNull();
    expect(sharePercent(10, null)).toBeNull();
    expect(sharePercent(10, 0)).toBeNull();
    expect(sharePercent(25, 100)).toBe(25);
    expect(sumMetric([])).toBeNull();
    expect(sumMetric([null, null])).toBeNull();
    expect(sumMetric([10, null, 20])).toBeNull();
    expect(sumMetric([10, 20])).toBe(30);
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

  it("해변 slug로 이름·지역을 찾고, 못 찾으면 slug·경로가 아니라 이름 없음(null)", () => {
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
    ).toEqual({ name: "해운대해수욕장", region: "부산 해운대구" });
    // 이름표에 없는 slug: slug를 이름처럼 쓰지 않음
    expect(
      beachLabel(
        { path: "/spots/gwangalli", slug: "gwangalli", pageViews: 3 },
        bySlug,
      ),
    ).toEqual({ name: null, region: null });
    // slug를 못 읽은 경로
    expect(
      beachLabel({ path: "/spots/", slug: null, pageViews: 3 }, bySlug),
    ).toEqual({ name: null, region: null });
    // 객체 기본 속성 이름은 이름표가 아님
    expect(
      beachLabel(
        { path: "/spots/constructor", slug: "constructor", pageViews: 1 },
        bySlug,
      ),
    ).toEqual({ name: null, region: null });
  });

  it("사용자당 화면은 받은 두 값으로만 계산하고, 하나라도 없거나 사용자 0이면 null", () => {
    expect(perUser(22580, 4910)).toBe(4.6);
    expect(perUser(null, 4910)).toBeNull();
    expect(perUser(100, null)).toBeNull();
    expect(perUser(100, 0)).toBeNull();
  });

  it("응답 모양 검사: 정상 응답과 세부 리포트 null은 통과, 칸이 빠지거나 숫자가 아니면 실패", () => {
    const good = localStatsView("28d", Date.parse("2026-11-13T05:00:00Z"));
    expect(validStats(good)).toBe(true);
    expect(
      validStats({ ...good, period: { ...good.period, topBeaches: null } }),
    ).toBe(true);
    expect(validStats(null)).toBe(false);
    expect(validStats({ ...good, realtime: undefined })).toBe(false);
    expect(
      validStats({
        ...good,
        period: { ...good.period, activeUsers: "180" },
      }),
    ).toBe(false);
    expect(
      validStats({
        ...good,
        period: {
          ...good.period,
          devices: [{ category: "mobile", activeUsers: "1" }],
        },
      }),
    ).toBe(false);
    expect(
      validStats({ ...good, period: { ...good.period, metadata: {} } }),
    ).toBe(false);
    expect(validStats({ ...good, range: "90d" })).toBe(false);
  });
});
