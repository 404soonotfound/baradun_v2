import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "../core/store/memory";
import { WARNINGS_STATE } from "../collectors/warnings";
import {
  BEACHES,
  CONFIRMED,
  HEAVY_RAIN_ROW,
  NOW,
  WIND_WAVE_ROW,
  ZONES,
  seedReadings,
  seedWarnings,
} from "./fixtures";
import { readPublishInputs, type PublishInputs } from "./inputs";
import { BeachSnapshotError, buildSnapshot, type Snapshot } from "./snapshot";
import { contractErrors } from "./validate";

// 게시 파일 조립 (BRD-61). 수집기가 남긴 State → 해변 분류·전국 특보·이력, 계약 통과
// 실패 경로: 없거나 깨진 기록이 '특보 없음'·빈 목록으로 바뀌지 않는지

async function snapshotFrom(state: MemoryStateStore): Promise<Snapshot> {
  return buildSnapshot({
    beaches: BEACHES,
    zones: ZONES,
    inputs: await readPublishInputs(state),
    now: NOW,
  });
}

function expectContract(snapshot: Snapshot) {
  expect(contractErrors("BeachesFile", snapshot.beaches)).toEqual([]);
  expect(contractErrors("StatusFile", snapshot.status)).toEqual([]);
  expect(contractErrors("HistoryFile", snapshot.history)).toEqual([]);
  expect(
    contractErrors("NationwideWarningsFile", snapshot.nationwideWarnings),
  ).toEqual([]);
}

describe("buildSnapshot", () => {
  it("풍랑주의보 → 그 앞바다 해변은 이용불가, 주변 특보는 정보로만, 계약 통과", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [WIND_WAVE_ROW, HEAVY_RAIN_ROW]);
    await seedReadings(state);
    const snapshot = await snapshotFrom(state);
    expectContract(snapshot);

    const gangmun = snapshot.status.beaches.b0001!;
    expect(gangmun.category).toBe("unavailable");
    expect(gangmun.reasons[0]).toMatchObject({
      code: "warning",
      type: "wind_wave",
      level: "advisory",
      scope: "강원중부앞바다",
    });
    // 호우는 분류에 쓰지 않고 nearbyWarnings로만
    expect(gangmun.info.nearbyWarnings).toEqual([
      expect.objectContaining({ type: "heavy_rain", zoneCode: "L1022510" }),
    ]);
    expect(gangmun.warning.lastConfirmedAt).toBe(CONFIRMED);
    expect(gangmun.info.season).toBeNull();
    expect(gangmun.info.ripCurrent).toBeNull();

    expect(snapshot.nationwideWarnings).toEqual({
      lastConfirmedAt: CONFIRMED,
      items: [
        expect.objectContaining({
          type: "wind_wave",
          zoneCode: "S1151200",
          zoneName: "강원중부앞바다",
        }),
      ],
    });
  });

  it("특보·관측 모두 정상이고 발효 없음 → 특보 없음, validUntil은 파고 90분과 특보 45분 중 이른 시각", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    await seedReadings(state);
    const snapshot = await snapshotFrom(state);
    expectContract(snapshot);
    const gangmun = snapshot.status.beaches.b0001!;
    expect(gangmun.category).toBe("clear");
    expect(gangmun.reasons).toEqual([]);
    // 확인 02:20 + 45분 = 03:05, 관측 02:00 + 90분 = 03:30 → 03:05
    expect(gangmun.validUntil).toBe("2026-10-23T03:05:00Z");
    expect(snapshot.nationwideWarnings).toEqual({
      lastConfirmedAt: CONFIRMED,
      items: [],
    });
  });

  it("특보 기록이 없으면 모든 해변 판단불가, 전국 확인 시각 null (빈 목록을 '없음'으로 보지 않음)", async () => {
    const state = new MemoryStateStore();
    await seedReadings(state);
    const snapshot = await snapshotFrom(state);
    expectContract(snapshot);
    for (const status of Object.values(snapshot.status.beaches)) {
      expect(status.category).toBe("undetermined");
      expect(status.reasons[0]!.code).toBe("warning_unknown");
      expect(status.warning.state).toBe("unknown");
    }
    expect(snapshot.nationwideWarnings).toEqual({
      lastConfirmedAt: null,
      items: [],
    });
  });

  it("압축 원본이 깨지면 확인 시각을 믿지 않음 → 판단불가, 전국 확인 시각 null", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    await seedReadings(state);
    const { pk, sk } = WARNINGS_STATE.pwncd;
    await state.putState(
      pk,
      sk,
      { archive: "not-gzip", rowCount: 1, lastConfirmedAt: CONFIRMED },
      Date.parse(CONFIRMED) + 1,
    );

    const inputs = await readPublishInputs(state);
    expect(inputs.pwncd).toEqual({
      result: { status: "failed", reason: "archive:corrupt" },
      lastConfirmedAt: null,
    });
    const snapshot = await snapshotFrom(state);
    expect(snapshot.status.beaches.b0001!.category).toBe("undetermined");
    expect(snapshot.nationwideWarnings.lastConfirmedAt).toBeNull();
  });

  it("지진해일 기록만 없어도 전국 확인 시각 null, 해변은 판단불가", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    await seedReadings(state);
    const { pk, sk } = WARNINGS_STATE.tsunami;
    await state.putState(pk, sk, { archive: 1 }, Date.parse(CONFIRMED) + 1);
    const snapshot = await snapshotFrom(state);
    expect(snapshot.status.beaches.b0001!.category).toBe("undetermined");
    expect(snapshot.nationwideWarnings.lastConfirmedAt).toBeNull();
  });

  it("관측 기록이 없으면 배정된 파고 측정소는 관측 지연(값을 지어내지 않음)", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    const snapshot = await snapshotFrom(state);
    expectContract(snapshot);
    const gangmun = snapshot.status.beaches.b0001!;
    expect(gangmun.category).toBe("undetermined");
    expect(gangmun.reasons.map((r) => r.code)).toEqual(["observation_delayed"]);
    expect(gangmun.observation.metrics.waveHeight).toMatchObject({
      value: null,
      state: "delayed",
    });
  });

  it("숨긴 해변도 beaches·status에 넣음(숨기는 일은 화면)", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    await seedReadings(state);
    const snapshot = await snapshotFrom(state);
    expect(snapshot.beaches.beaches.map((b) => [b.id, b.hidden])).toEqual([
      ["b0001", false],
      ["b0002", false],
      ["b0003", true],
    ]);
    expect(Object.keys(snapshot.status.beaches)).toEqual([
      "b0001",
      "b0002",
      "b0003",
    ]);
  });

  it("이력은 파고 측정소마다 1시간 간격 25개 점, 모두 측정값 없음(v: null)", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    await seedReadings(state);
    const { history } = await snapshotFrom(state);
    const ids = [
      ...new Set(BEACHES.map((b) => b.stations.waveHeight?.id).filter(Boolean)),
    ].sort();
    expect(Object.keys(history.stations)).toEqual(ids);
    const points = history.stations[ids[0]!]!.points;
    expect(points).toHaveLength(25);
    expect(points[0]).toEqual({ t: "2026-10-22T02:00:00Z", v: null });
    expect(points.at(-1)).toEqual({ t: "2026-10-23T02:00:00Z", v: null });
    expect(points.every((p) => p.v === null)).toBe(true);
  });

  it("해변 id가 겹치면 덮어쓰지 않고 멈춤", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    const inputs = await readPublishInputs(state);
    expect(() =>
      buildSnapshot({
        beaches: [...BEACHES, BEACHES[0]!],
        zones: ZONES,
        inputs,
        now: NOW,
      }),
    ).toThrow("해변 id 중복: b0001");
  });

  it("해변 하나의 입력이 어긋나 분류가 멈추면 해변 id와 slug를 담아 멈춤", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [WIND_WAVE_ROW]);
    const inputs = await readPublishInputs(state);
    // 발효 특보는 있는데 두 출처 모두 확인 시각이 없음 → 분류가 멈춰야 함(BRD-21 ⑥)
    const broken: PublishInputs = {
      ...inputs,
      pwncd: { ...inputs.pwncd, lastConfirmedAt: null },
      tsunami: { ...inputs.tsunami, lastConfirmedAt: null },
    };
    let caught: unknown;
    try {
      buildSnapshot({
        beaches: BEACHES,
        zones: ZONES,
        inputs: broken,
        now: NOW,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BeachSnapshotError);
    expect(caught).toMatchObject({ beachId: "b0001", slug: "gangmun" });
  });
});
