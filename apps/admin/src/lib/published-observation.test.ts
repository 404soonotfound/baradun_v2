import { describe, expect, it } from "vitest";
import { localPublishedView } from "./auth/local-beaches";
import { parsePublished } from "./beaches";

// 해변 게시 상태의 파고·파주기 (#502, 서버 #499)
const wave = (over: Record<string, unknown> = {}) => ({
  value: 0.6,
  unit: "m",
  observedAt: "2026-11-15T08:00:00Z",
  state: "fresh",
  ...over,
});
const period = (over: Record<string, unknown> = {}) =>
  wave({ value: 8, unit: "s", ...over });

function view(observation?: unknown) {
  return {
    available: true,
    snapshotVersion: "20261115T083000Z",
    generatedAt: "2026-11-15T08:30:00Z",
    maintenance: { active: false, until: null },
    beaches: {
      b0001: {
        category: "clear",
        reasons: [],
        validUntil: "2026-11-15T09:15:00Z",
        ...(observation !== undefined ? { observation } : {}),
      },
    },
  };
}

function entry(observation?: unknown) {
  const parsed = parsePublished(view(observation));
  if (!parsed || !parsed.available) throw new Error("파싱 실패");
  return parsed.beaches.b0001!;
}

describe("parsePublished 관측값", () => {
  it("게시값을 그대로 옮김(지연·가까운 관측 없음 포함)", () => {
    const e = entry({
      metrics: {
        waveHeight: wave({
          state: "delayed",
          observedAt: "2026-11-15T05:00:00Z",
        }),
        wavePeriod: period({ value: null, observedAt: null, state: "none" }),
      },
    });
    expect(e.waveHeight).toEqual({
      value: 0.6,
      unit: "m",
      observedAt: "2026-11-15T05:00:00Z",
      state: "delayed",
    });
    expect(e.wavePeriod).toEqual({
      value: null,
      unit: "s",
      observedAt: null,
      state: "none",
    });
  });

  it("서버가 관측을 주지 않으면 필드 없음(예전 서버), '가까운 관측 없음'으로 바꾸지 않음", () => {
    const e = entry();
    expect(e).not.toHaveProperty("waveHeight");
    expect(e).not.toHaveProperty("wavePeriod");
    expect(e.category).toBe("clear");
  });

  it.each([
    ["fresh인데 값 없음", wave({ value: null })],
    ["fresh인데 시각 없음", wave({ observedAt: null })],
    ["none인데 값 있음", wave({ state: "none", observedAt: null })],
    ["값이 글자", wave({ value: "0.6" })],
    ["단위가 다름", wave({ unit: "s" })],
    ["모르는 상태", wave({ state: "stale" })],
    ["시각 형식이 틀림", wave({ observedAt: "어제" })],
  ])("모양이 틀리면 그 칸만 확인 못 함(null): %s", (_, bad) => {
    const parsed = parsePublished(
      view({ metrics: { waveHeight: bad, wavePeriod: period() } }),
    );
    // 관측 칸 하나 때문에 목록 전체를 막지 않음(분류는 그대로)
    if (!parsed || !parsed.available) throw new Error("파싱 실패");
    expect(parsed.beaches.b0001!.waveHeight).toBeNull();
    expect(parsed.beaches.b0001!.wavePeriod).toMatchObject({ value: 8 });
  });

  it("observation은 있는데 metrics가 없으면 두 칸 모두 확인 못 함", () => {
    const e = entry({});
    expect(e.waveHeight).toBeNull();
    expect(e.wavePeriod).toBeNull();
  });

  it("로컬 예시도 모든 해변의 관측을 읽을 수 있음", () => {
    const parsed = parsePublished(localPublishedView());
    if (!parsed || !parsed.available) throw new Error("파싱 실패");
    for (const e of Object.values(parsed.beaches)) {
      expect(e.waveHeight).not.toBeNull();
      expect(e.wavePeriod).not.toBeNull();
      expect(e.waveHeight).toBeDefined();
    }
  });
});
