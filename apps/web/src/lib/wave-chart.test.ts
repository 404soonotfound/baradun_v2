import { describe, expect, it } from "vitest";

import { waveChart } from "./wave-chart";

// 24시간 파고 차트 계산 (BRD-32 · 10/27 결정: 간격 90분 초과는 끊긴 구간, 값을 지어내지 않음)
const NOW = Date.parse("2026-10-17T12:00:00Z");
const hour = (h: number) =>
  new Date(NOW - (24 - h) * 60 * 60_000).toISOString();

describe("waveChart", () => {
  it("모든 점이 null이면 그리지 않음(지금 history.json 상태)", () => {
    const points = Array.from({ length: 25 }, (_, h) => ({
      t: hour(h),
      v: null,
    }));
    expect(waveChart(points, NOW, null)).toEqual({ kind: "empty" });
  });

  it("점이 없으면 그리지 않음", () => {
    expect(waveChart([], NOW, null)).toEqual({ kind: "empty" });
  });

  it("1시간 간격 점은 한 선으로 잇고 빗금 없음", () => {
    const points = Array.from({ length: 25 }, (_, h) => ({
      t: hour(h),
      v: 0.5,
    }));
    const chart = waveChart(points, NOW, null);
    expect(chart).toMatchObject({ kind: "ready", gaps: [] });
    if (chart.kind === "ready") expect(chart.runs).toHaveLength(1);
  });

  it("null 한 점(간격 2시간)은 선을 끊고 그 사이를 빗금으로", () => {
    const points = [
      { t: hour(20), v: 0.4 },
      { t: hour(21), v: null },
      { t: hour(22), v: 0.6 },
      { t: hour(23), v: 0.7 },
      { t: hour(24), v: 0.7 },
    ];
    const chart = waveChart(points, NOW, null);
    if (chart.kind !== "ready") throw new Error("ready여야 함");
    expect(chart.runs.map((run) => run.length)).toEqual([1, 3]);
    expect(chart.gaps).toContainEqual({
      from: Date.parse(hour(20)),
      to: Date.parse(hour(22)),
    });
  });

  it("간격이 정확히 90분이면 잇고, 90분 1초면 끊음", () => {
    const base = Date.parse(hour(20));
    const iso = (ms: number) => new Date(ms).toISOString();
    const joined = waveChart(
      [
        { t: iso(base), v: 1 },
        { t: iso(base + 90 * 60_000), v: 1 },
      ],
      NOW,
      null,
    );
    const split = waveChart(
      [
        { t: iso(base), v: 1 },
        { t: iso(base + 90 * 60_000 + 1000), v: 1 },
      ],
      NOW,
      null,
    );
    expect(joined.kind === "ready" && joined.runs.length).toBe(1);
    expect(split.kind === "ready" && split.runs.length).toBe(2);
  });

  it("마지막 값이 90분보다 오래됐으면 지금까지 빗금", () => {
    const chart = waveChart([{ t: hour(20), v: 1 }], NOW, null);
    if (chart.kind !== "ready") throw new Error("ready여야 함");
    expect(chart.gaps.at(-1)).toEqual({ from: Date.parse(hour(20)), to: NOW });
  });

  it("읽을 수 없는 시각·미래 점·24시간 밖 점·음수 값은 버림", () => {
    const chart = waveChart(
      [
        { t: "not-a-time", v: 1 },
        { t: new Date(NOW + 60 * 60_000).toISOString(), v: 1 },
        { t: new Date(NOW - 25 * 60 * 60_000).toISOString(), v: 1 },
        { t: hour(23), v: -1 },
      ],
      NOW,
      null,
    );
    expect(chart).toEqual({ kind: "empty" });
  });

  it("지금 시각을 모르면 그리지 않음", () => {
    expect(waveChart([{ t: hour(23), v: 1 }], NaN, null)).toEqual({
      kind: "empty",
    });
  });

  it("가장 최근 점이 null이면 직전 값이 90분 안이어도 끝을 빗금으로, 현재값 없음(Codex P1)", () => {
    // 지금 12:00, 11:00은 0.5m, 12:00은 null
    const chart = waveChart(
      [
        { t: hour(23), v: 0.5 },
        { t: hour(24), v: null },
      ],
      NOW,
      null,
    );
    if (chart.kind !== "ready") throw new Error("ready여야 함");
    expect(chart.current).toBeNull();
    expect(chart.gaps.at(-1)).toEqual({ from: Date.parse(hour(23)), to: NOW });
  });

  it("검증된 지금 파고가 있으면 현재값", () => {
    const chart = waveChart(
      [
        { t: hour(23), v: 0.5 },
        { t: hour(24), v: 0.6 },
      ],
      NOW,
      { t: NOW, v: 0.6 },
    );
    expect(chart.kind === "ready" && chart.current).toEqual({
      t: NOW,
      v: 0.6,
    });
  });

  it("명시된 null은 간격이 짧아도 선을 끊음", () => {
    const base = Date.parse(hour(22));
    const iso = (ms: number) => new Date(ms).toISOString();
    const chart = waveChart(
      [
        { t: iso(base), v: 0.5 },
        { t: iso(base + 20 * 60_000), v: null },
        { t: iso(base + 40 * 60_000), v: 0.6 },
      ],
      NOW,
      null,
    );
    if (chart.kind !== "ready") throw new Error("ready여야 함");
    expect(chart.runs).toHaveLength(2);
    expect(chart.gaps).toContainEqual({
      from: base,
      to: base + 40 * 60_000,
    });
  });

  it("첫 값 앞의 null은 24시간 시작부터 빗금", () => {
    const chart = waveChart(
      [
        { t: hour(0), v: null },
        { t: hour(1), v: 0.5 },
      ],
      NOW,
      null,
    );
    if (chart.kind !== "ready") throw new Error("ready여야 함");
    expect(chart.gaps[0]).toEqual({
      from: NOW - 24 * 60 * 60_000,
      to: Date.parse(hour(1)),
    });
  });
});
