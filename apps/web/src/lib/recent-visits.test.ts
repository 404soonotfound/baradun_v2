import { describe, expect, it } from "vitest";

import { parseVisits, viewedTime, withVisit } from "@/lib/recent-visits";

describe("parseVisits", () => {
  it("저장값이 없거나 읽을 수 없으면 빈 기록(예전 기기와 호환)", () => {
    expect(parseVisits(null)).toEqual({});
    expect(parseVisits("{")).toEqual({});
    expect(parseVisits('["b0001"]')).toEqual({});
  });

  it("시각을 읽을 수 없는 칸은 버리고, 모르는 활동은 null", () => {
    expect(
      parseVisits(
        JSON.stringify({
          b1: { at: "2026-10-28T09:40:00Z", activity: "surfing" },
          b2: { at: "어제", activity: "swimming" },
          b3: { at: "2026-10-28T09:40:00Z", activity: "kayak" },
        }),
      ),
    ).toEqual({
      b1: { at: "2026-10-28T09:40:00Z", activity: "surfing" },
      b3: { at: "2026-10-28T09:40:00Z", activity: null },
    });
  });
});

describe("withVisit", () => {
  it("같은 해변은 새 기록으로 덮음", () => {
    const next = withVisit(
      { b1: { at: "2026-10-27T00:00:00Z", activity: "swimming" } },
      "b1",
      { at: "2026-10-28T00:00:00Z", activity: "scuba" },
    );
    expect(next).toEqual({
      b1: { at: "2026-10-28T00:00:00Z", activity: "scuba" },
    });
  });
});

describe("viewedTime (한국 시각)", () => {
  // 2026-10-29 15:00 KST = 06:00 UTC
  const now = Date.parse("2026-10-29T06:00:00Z");

  it("오늘·어제·그 전을 KST 날짜로 나눔", () => {
    // 10-29 00:10 KST = 10-28 15:10 UTC → 오늘
    expect(viewedTime("2026-10-28T15:10:00Z", now)).toEqual({
      day: "today",
      time: "00:10",
      month: 10,
      date: 29,
    });
    // 10-28 18:40 KST
    expect(viewedTime("2026-10-28T09:40:00Z", now)).toMatchObject({
      day: "yesterday",
      time: "18:40",
    });
    expect(viewedTime("2026-10-26T09:40:00Z", now)).toMatchObject({
      day: "earlier",
      month: 10,
      date: 26,
    });
  });

  it("읽을 수 없는 시각·2분 넘는 미래·지금 모름이면 null(시각 줄을 뺌)", () => {
    expect(viewedTime("어제", now)).toBeNull();
    expect(viewedTime("2026-10-29T06:05:00Z", now)).toBeNull();
    expect(viewedTime("2026-10-29T05:00:00Z", NaN)).toBeNull();
  });
});
