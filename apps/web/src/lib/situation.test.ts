import { describe, expect, it } from "vitest";

import { isDelayedView, pickSituation, shownDataTime } from "./situation";
import type { BeachView } from "./snapshot/view";

// 상황 배너 (BRD-28)

// 기본: 정상 수신, 온라인, 지연 해변 없음, 위치 있음
const base = {
  phase: "ready" as const,
  live: true,
  failedOnline: false,
  online: true,
  delayed: [] as string[],
  locationOff: false,
};

describe("pickSituation", () => {
  it("문제가 없으면 배너 없음", () => {
    expect(pickSituation(base)).toBeNull();
  });

  it("오프라인이 먼저(첫 응답 전이어도)", () => {
    expect(
      pickSituation({
        ...base,
        online: false,
        live: false,
        failedOnline: true,
        delayed: ["경포"],
        locationOff: true,
      }),
    ).toEqual({ kind: "offline" });
    expect(pickSituation({ ...base, phase: "loading", online: false })).toEqual(
      { kind: "offline" },
    );
  });

  it("지원 밖 형식은 불러오기 실패·지연·위치 배너보다 먼저", () => {
    expect(
      pickSituation({
        ...base,
        phase: "schema_unsupported",
        live: false,
        failedOnline: true,
        delayed: ["사근진"],
        locationOff: true,
      }),
    ).toEqual({ kind: "unsupported" });
  });

  it("연결된 채로 시작한 조회가 실패했으면 불러오기 실패(지연·위치 배너보다 먼저)", () => {
    expect(
      pickSituation({
        ...base,
        live: false,
        failedOnline: true,
        delayed: ["사근진"],
        locationOff: true,
      }),
    ).toEqual({ kind: "failed" });
  });

  it("첫 응답 전·연결이 돌아온 뒤 다시 받는 중(failedOnline false)에는 실패로 보지 않음", () => {
    expect(pickSituation({ ...base, live: false })).toBeNull();
    expect(
      pickSituation({ ...base, phase: "loading", live: false }),
    ).toBeNull();
    expect(pickSituation({ ...base, live: false, locationOff: true })).toEqual({
      kind: "noLocation",
    });
  });

  it("관측 지연은 첫 해변과 나머지 수", () => {
    expect(
      pickSituation({ ...base, delayed: ["사근진"], locationOff: true }),
    ).toEqual({ kind: "delayed", first: "사근진", more: 0 });
    expect(
      pickSituation({ ...base, delayed: ["사근진", "경포", "강문"] }),
    ).toEqual({ kind: "delayed", first: "사근진", more: 2 });
  });

  it("다른 문제가 없을 때만 위치 없이 보는 중", () => {
    expect(pickSituation({ ...base, locationOff: true })).toEqual({
      kind: "noLocation",
    });
  });

  it("점검·강제 업데이트 중에는 배너 없음(전체를 덮는 화면이 알림)", () => {
    for (const phase of ["maintenance", "update_required"] as const) {
      expect(
        pickSituation({
          ...base,
          phase,
          online: false,
          live: false,
          failedOnline: true,
        }),
      ).toBeNull();
    }
  });
});

describe("isDelayedView", () => {
  const ready = (
    badge: Extract<BeachView, { kind: "ready" }>["badge"],
    stale = false,
  ): BeachView => ({
    kind: "ready",
    category: "undetermined",
    badge,
    reasons: [badge],
    stale,
    confirmedAt: null,
    metrics: {
      waveHeight: { kind: "hidden" },
      wavePeriod: { kind: "hidden" },
      waveDirection: { kind: "hidden" },
      waterTemp: { kind: "hidden" },
      wind: { kind: "hidden" },
    },
  });

  it("지금 받은 정보에서 배지가 관측 지연일 때만", () => {
    expect(isDelayedView(ready({ kind: "observation_delayed" }))).toBe(true);
  });

  it("B5(stale)·다른 사유·아직 못 받음·노출 끔은 아님", () => {
    expect(isDelayedView(ready({ kind: "observation_delayed" }, true))).toBe(
      false,
    );
    expect(isDelayedView(ready({ kind: "warning_unknown" }))).toBe(false);
    expect(isDelayedView({ kind: "loading" })).toBe(false);
    expect(isDelayedView({ kind: "hidden" })).toBe(false);
  });
});

describe("shownDataTime", () => {
  const now = Date.parse("2026-10-27T05:40:00Z"); // 한국 14:40

  it("게시 시각을 한국 시각으로. 날짜가 다르면 날짜도", () => {
    expect(shownDataTime("2026-10-27T05:30:00Z", now)).toBe("14:30");
    expect(shownDataTime("2026-10-26T05:30:00Z", now)).toBe("10/26 14:30");
  });

  it("2분 안의 미래는 기기 시계 차이로 보고 그대로, 그보다 미래는 믿지 않음", () => {
    expect(shownDataTime("2026-10-27T05:42:00Z", now)).toBe("14:42");
    expect(shownDataTime("2026-10-27T05:42:01Z", now)).toBeNull();
  });

  it("읽을 수 없거나 없거나 지금 시각을 모르면 null", () => {
    expect(shownDataTime(undefined, now)).toBeNull();
    expect(shownDataTime(null, now)).toBeNull();
    expect(shownDataTime("2026-10-27 05:30", now)).toBeNull();
    expect(shownDataTime("2026-10-27T05:30:00Z", NaN)).toBeNull();
  });
});
