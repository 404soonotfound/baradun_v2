import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sampleInquiryPage, sampleStats } from "./sample-data";
import { statsDates } from "./stats-trends";

// 데모 계정 예시 응답(#483). 실제 응답과 같은 모양·실제로 있는 해변 slug인지 확인함
const NOW = new Date("2026-11-14T05:30:00.000Z"); // KST 14:30

const realSlugs = new Set(
  readdirSync(new URL("../../../data/beaches/", import.meta.url))
    .filter((name) => /^b\d+\.json$/.test(name))
    .map(
      (name) =>
        JSON.parse(
          readFileSync(
            new URL(`../../../data/beaches/${name}`, import.meta.url),
            "utf8",
          ),
        ).slug as string,
    ),
);

describe("데모 이용 통계 예시", () => {
  it("많이 본 해변·화면의 해변 slug가 실제 데이터에 있음", () => {
    const stats = sampleStats("7d", NOW);
    const slugs = [
      ...(stats.period.status === "ok"
        ? (stats.period.topBeaches ?? []).map((row) => row.slug)
        : []),
      ...(stats.trends?.topScreens?.rows ?? []).flatMap((row) => {
        const match = /^(?:\/en)?\/spots\/([^/]+)\/?$/.exec(row.path);
        return match ? [match[1]!] : [];
      }),
    ];
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) expect(realSlugs).toContain(slug);
  });

  it("기간 추이는 범위의 KST 날짜를 모두 채우고 시간대는 24칸", () => {
    for (const range of ["today", "7d", "28d", "60d"] as const) {
      const trends = sampleStats(range, NOW).trends!;
      const dates = statsDates(range, NOW);
      expect(trends.startDate).toBe(dates.current.startDate);
      expect(trends.endDate).toBe(dates.current.endDate);
      expect(trends.daily?.rows.at(0)?.date).toBe(dates.current.startDate);
      expect(trends.daily?.rows.at(-1)?.date).toBe(dates.current.endDate);
      expect(trends.hourly?.rows).toHaveLength(24);
      expect(trends.timeZoneMismatch).toBe(false);
    }
  });

  it("오늘 범위는 앞 기간 비교가 없고, 아직 지나지 않은 시간대는 값이 없음", () => {
    const trends = sampleStats("today", NOW).trends!;
    expect(trends.previous).toBeNull();
    const hours = trends.hourly!.rows;
    expect(hours[13]?.averageActiveUsers).not.toBeNull();
    expect(hours[14]?.averageActiveUsers).toBeNull();
    expect(hours[14]?.reportedDays).toBe(0);
  });

  it("7일 범위는 앞 기간 7일을 비교로 줌", () => {
    const trends = sampleStats("7d", NOW).trends!;
    const dates = statsDates("7d", NOW);
    expect(trends.previous).toMatchObject(dates.previous!);
  });
});

describe("데모 문의 예시 지표", () => {
  it("최근 7일 접수·완료와 가장 오래된 미처리 접수 시각을 줌", () => {
    const page = sampleInquiryPage(undefined, NOW);
    expect(page.counts).toMatchObject({
      receivedLast7d: 3,
      resolvedLast7d: 0,
      oldestUnprocessedAt: new Date(
        NOW.getTime() - 30 * 3_600_000,
      ).toISOString(),
    });
  });
});
