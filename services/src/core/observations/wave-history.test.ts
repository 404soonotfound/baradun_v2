import { describe, expect, it } from "vitest";
import {
  historyPoints,
  mergeWaveHistory,
  readWaveHistory,
  type WaveHistory,
} from "./wave-history";

// 파고 24시간 이력 (BRD-94). 결측은 null, 값을 지어내지 않음
// NOW = 02:30Z → 점 25개 = 전날 02:00Z ~ 02:00Z, 버리는 기준 = 전날 01:00Z 이하
const NOW = "2026-10-23T02:30:00Z";
const sec = (iso: string) => Date.parse(iso) / 1000;
const row = (
  stationId: string,
  observedAt: string,
  waveHeight: number | null,
) => ({
  stationId,
  observedAt,
  waveHeight,
});

describe("mergeWaveHistory", () => {
  it("새 파고를 관측 시각 순으로 더하고, 무효 값·파고 없는 줄·미래 관측은 넣지 않음", () => {
    const merged = mergeWaveHistory(
      {},
      [
        row("22520", "2026-10-23T02:00:00Z", 0.7),
        row("22520", "2026-10-23T01:00:00Z", 0.6),
        row("22520", "2026-10-23T00:00:00Z", null), // 무효 값
        row("22520", "2026-10-23T03:00:00Z", 0.9), // 미래 관측
        {
          stationId: "22523",
          observedAt: "2026-10-23T02:00:00Z",
          wavePeriod: 8,
        }, // kma_buoy 줄
      ],
      NOW,
    );
    expect(merged).toEqual({
      "22520": [
        [sec("2026-10-23T01:00:00Z"), 0.6],
        [sec("2026-10-23T02:00:00Z"), 0.7],
      ],
    });
  });

  it("같은 관측 시각은 이전 값 유지", () => {
    const previous: WaveHistory = {
      "22520": [[sec("2026-10-23T02:00:00Z"), 0.7]],
    };
    expect(
      mergeWaveHistory(
        previous,
        [row("22520", "2026-10-23T02:00:00Z", 1.5)],
        NOW,
      ),
    ).toEqual(previous);
  });

  it("24시간 범위 밖 값은 버리고, 모두 버려진 측정기는 칸을 지움", () => {
    const previous: WaveHistory = {
      "22520": [
        [sec("2026-10-22T01:00:00Z"), 0.4], // 첫 점 구간 시작(포함 안 함)
        [sec("2026-10-22T01:30:00Z"), 0.5], // 첫 점(02:00) 구간 안
      ],
      "22188": [[sec("2026-10-21T20:00:00Z"), 0.3]],
    };
    expect(mergeWaveHistory(previous, [], NOW)).toEqual({
      "22520": [[sec("2026-10-22T01:30:00Z"), 0.5]],
    });
  });

  it("기준 시각 형식이 틀리면 멈춤", () => {
    expect(() => mergeWaveHistory({}, [], "bad")).toThrow(RangeError);
  });
});

describe("readWaveHistory", () => {
  it("기록이 없거나 모양이 다르면 빈 값", () => {
    expect(readWaveHistory(null)).toEqual({});
    expect(readWaveHistory({ stations: [] })).toEqual({});
    expect(readWaveHistory("x")).toEqual({});
  });

  it("모양이 틀린 측정은 그 측정만 버림", () => {
    const ok = [sec("2026-10-23T02:00:00Z"), 0.7];
    expect(
      readWaveHistory({
        stations: {
          "22520": [ok, ["x", 1], [1.5, 1], [1, -0.1], [1], [1, null]],
          "22188": "broken",
        },
      }),
    ).toEqual({ "22520": [ok] });
  });

  it("버린 수를 알림. 기록 없음(null)·정상 기록은 알리지 않음", () => {
    const counts: number[] = [];
    const onDropped = (count: number) => counts.push(count);
    readWaveHistory(null, onDropped);
    readWaveHistory({ stations: { "22520": [[1, 0.7]] } }, onDropped);
    expect(counts).toEqual([]);
    readWaveHistory("broken", onDropped);
    readWaveHistory(
      {
        stations: {
          "22520": [
            [1, 0.7],
            ["x", 1],
          ],
          "22188": "broken",
        },
      },
      onDropped,
    );
    expect(counts).toEqual([1, 2]);
  });
});

describe("historyPoints", () => {
  it("점마다 (t − 60분, t] 안의 마지막 측정, 없으면 null(앞 값을 이어 쓰지 않음)", () => {
    const points = historyPoints(
      [
        [sec("2026-10-23T00:30:00Z"), 0.4], // 01:00 점
        [sec("2026-10-23T01:00:00Z"), 0.6], // 01:00 점(더 늦음)
        [sec("2026-10-22T23:00:00Z"), 0.2], // 23:00 점(경계 포함)
      ],
      NOW,
    );
    expect(points).toHaveLength(25);
    expect(points[0]).toEqual({ t: "2026-10-22T02:00:00Z", v: null });
    expect(points.at(-1)).toEqual({ t: "2026-10-23T02:00:00Z", v: null });
    expect(points.at(-2)).toEqual({ t: "2026-10-23T01:00:00Z", v: 0.6 });
    expect(points.at(-3)).toEqual({ t: "2026-10-23T00:00:00Z", v: null });
    expect(points.at(-4)).toEqual({ t: "2026-10-22T23:00:00Z", v: 0.2 });
    expect(points.filter((p) => p.v !== null)).toHaveLength(2);
  });

  it("90분 넘은 값도 그 관측 시각의 점에만 남음", () => {
    const points = historyPoints([[sec("2026-10-22T22:00:00Z"), 1.1]], NOW);
    expect(points.filter((p) => p.v !== null)).toEqual([
      { t: "2026-10-22T22:00:00Z", v: 1.1 },
    ]);
  });

  it("0.0은 정상값(결측 아님)", () => {
    const points = historyPoints([[sec("2026-10-23T02:00:00Z"), 0]], NOW);
    expect(points.at(-1)).toEqual({ t: "2026-10-23T02:00:00Z", v: 0 });
  });
});
