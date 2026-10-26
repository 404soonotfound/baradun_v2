import { describe, expect, it } from "vitest";
import { MemoryStateStore } from "../core/store/memory";
import { WARNINGS_STATE } from "../collectors/warnings";
import {
  BEACHES,
  CONFIRMED,
  HEAVY_RAIN_ROW,
  NOW,
  SEASONS,
  WIND_WAVE_ROW,
  ZONES,
  seedPhotoChecks,
  seedReadings,
  seedWarnings,
} from "./fixtures";
import { readPublishInputs, type PublishInputs } from "./inputs";
import { BeachSnapshotError, buildSnapshot, type Snapshot } from "./snapshot";
import { contractErrors } from "./validate";
import { OCEAN_STATE } from "../collectors/ocean";
import type { StateStore } from "../core/store/types";

const WAVE_STATIONS = [
  ...new Set(
    BEACHES.map((b) => b.stations.waveHeight?.id).filter(
      (id): id is string => id !== undefined,
    ),
  ),
].sort();
const sec = (iso: string) => Date.parse(iso) / 1000;

async function seedHistory(
  state: StateStore,
  stations: Record<string, [number, number][]>,
) {
  const { pk, sk } = OCEAN_STATE.history;
  await state.putState(pk, sk, { stations }, 1);
}

// 게시 파일 조립 (BRD-61). 수집기가 남긴 State → 해변 분류·전국 특보·이력, 계약 통과
// 실패 경로: 없거나 깨진 기록이 '특보 없음'·빈 목록으로 바뀌지 않는지

async function snapshotFrom(state: MemoryStateStore): Promise<Snapshot> {
  return buildSnapshot({
    beaches: BEACHES,
    zones: ZONES,
    seasons: SEASONS,
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
    // 올해 일정은 있지만 게시 시각(KST 10/23)은 기간 밖 → 정보 배지만, 분류는 그대로
    expect(gangmun.info.season).toEqual({
      openFrom: "2026-07-10",
      openUntil: "2026-08-23",
      inSeason: false,
    });
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

  it("지역은 읽었지만 종류를 못 읽은 지진해일 행 → 해변 판단불가, 전국 확인 시각 null", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW], {
      tsunamiRows: [
        {
          stnId: "108",
          tmFc: "202610231100",
          cnt: "0",
          tmEf: "202610231100",
          fcTp: "99", // 모르는 발표 종류
          reg: "동해안",
          ann: "",
          rem: "",
        },
      ],
    });
    await seedReadings(state);
    const snapshot = await snapshotFrom(state);
    expectContract(snapshot);
    expect(snapshot.status.beaches.b0001!.category).toBe("undetermined");
    expect(snapshot.nationwideWarnings).toEqual({
      lastConfirmedAt: null,
      items: [],
    });
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

  it("사진 확인이 1유형 아님·사진 없음이면 그 해변 사진을 빼고 게시함(BRD-58)", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    await seedReadings(state);
    await seedPhotoChecks(state, {
      b0001: { status: "not_type1" },
      b0002: { status: "missing" },
    });
    const snapshot = await snapshotFrom(state);
    expectContract(snapshot);
    const photo = (id: string) =>
      snapshot.beaches.beaches.find((b) => b.id === id)!.photo;
    expect(photo("b0001")).toBeNull();
    expect(photo("b0002")).toBeNull();
    expect(photo("b0003")).not.toBeNull(); // 기록 없는 해변은 유지(수집 때 사람이 검증)
  });

  it("1유형으로 확인됐거나, 확인한 주소가 지금 사진과 다르면 사진 유지", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    await seedReadings(state);
    await seedPhotoChecks(state, {
      b0001: { status: "type1" },
      // 확인 뒤 저장소 사진이 바뀜 → 옛 사진의 결과라 지금 사진에 적용하지 않음
      b0002: {
        status: "not_type1",
        url: "https://tong.visitkorea.or.kr/old.jpg",
      },
    });
    const snapshot = await snapshotFrom(state);
    const photo = (id: string) =>
      snapshot.beaches.beaches.find((b) => b.id === id)!.photo;
    expect(photo("b0001")).not.toBeNull();
    expect(photo("b0002")).not.toBeNull();
  });

  it("사진 확인 기록이 없거나 모양이 달라도 게시가 멈추지 않음(사진 유지)", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    await seedReadings(state);
    await state.putState("catalog", "photos", { beaches: { b0001: "x" } }, 1);
    const snapshot = await snapshotFrom(state);
    expectContract(snapshot);
    expect(
      snapshot.beaches.beaches.find((b) => b.id === "b0001")!.photo,
    ).not.toBeNull();
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

  it("이력 기록이 없으면 파고 측정소마다 1시간 간격 25개 점, 모두 측정값 없음(v: null)", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    await seedReadings(state);
    const { history } = await snapshotFrom(state);
    expect(Object.keys(history.stations)).toEqual(WAVE_STATIONS);
    const points = history.stations[WAVE_STATIONS[0]!]!.points;
    expect(points).toHaveLength(25);
    expect(points[0]).toEqual({ t: "2026-10-22T02:00:00Z", v: null });
    expect(points.at(-1)).toEqual({ t: "2026-10-23T02:00:00Z", v: null });
    expect(points.every((p) => p.v === null)).toBe(true);
  });

  it("이력 기록으로 점을 채움: 없는 시각은 null, 24시간 밖 값·배정 안 된 측정기는 게시 안 함, 계약 통과", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    await seedReadings(state);
    const [first] = WAVE_STATIONS;
    await seedHistory(state, {
      [first!]: [
        [sec("2026-10-22T00:30:00Z"), 2.0], // 첫 점(02:00) 구간 밖
        [sec("2026-10-22T01:30:00Z"), 0.9], // 첫 점
        [sec("2026-10-23T01:40:00Z"), 0.8], // 마지막 점(02:00)
        [sec("2026-10-23T02:00:00Z"), 0.5], // 마지막 점(더 늦음)
      ],
      "99999": [[sec("2026-10-23T02:00:00Z"), 3.0]], // 해변에 배정 안 된 측정기
    });
    const snapshot = await snapshotFrom(state);
    expectContract(snapshot);
    const points = snapshot.history.stations[first!]!.points;
    expect(points[0]).toEqual({ t: "2026-10-22T02:00:00Z", v: 0.9 });
    expect(points.at(-1)).toEqual({ t: "2026-10-23T02:00:00Z", v: 0.5 });
    expect(points.filter((p) => p.v !== null)).toHaveLength(2);
    expect(snapshot.history.stations["99999"]).toBeUndefined();
  });

  it("해변의 파고 측정소가 바뀌면 새 측정소의 이력만 게시(이전 측정소 값을 옮기지 않음)", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    await seedHistory(state, {
      [WAVE_STATIONS[0]!]: [[sec("2026-10-23T02:00:00Z"), 0.5]],
    });
    const beaches = BEACHES.map((beach) =>
      beach.stations.waveHeight?.id === WAVE_STATIONS[0]
        ? {
            ...beach,
            stations: {
              ...beach.stations,
              waveHeight: { ...beach.stations.waveHeight!, id: "88888" },
            },
          }
        : beach,
    );
    const { history } = buildSnapshot({
      beaches,
      zones: ZONES,
      seasons: SEASONS,
      inputs: await readPublishInputs(state),
      now: NOW,
    });
    expect(history.stations[WAVE_STATIONS[0]!]).toBeUndefined();
    // 새 측정소는 이력이 없으므로 모두 null(이전 측정소 값을 빌려 쓰지 않음)
    expect(history.stations["88888"]!.points.every((p) => p.v === null)).toBe(
      true,
    );
  });

  it("이력 기록이 깨졌으면 모든 점 null로 게시하고 분류는 그대로", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [WIND_WAVE_ROW]);
    await seedReadings(state);
    await state.putState("ocean", "history", "broken", 1);
    const snapshot = await snapshotFrom(state);
    expectContract(snapshot);
    expect(snapshot.status.beaches.b0001!.category).toBe("unavailable");
    for (const station of Object.values(snapshot.history.stations)) {
      expect(station.points.every((p) => p.v === null)).toBe(true);
    }
  });

  // 이안류(BRD-57): 정보로만. 같은 입력에서 이안류 기록이 있든 없든 분류·사유·유효 시각이 같아야 함(G1)
  describe("이안류 info.ripCurrent", () => {
    const IN_SEASON = "2026-08-15T03:30:00Z"; // KST 08-15 12:30
    const seedRip = (state: MemoryStateStore, label: string) =>
      state.putState(
        "rip",
        "readings",
        {
          beaches: {
            b0001: {
              code: "GYEONGPO",
              label,
              observedAt: "2026-08-15T03:00:00Z",
            },
          },
        },
        1,
      );
    const build = async (state: MemoryStateStore, now: string) =>
      buildSnapshot({
        beaches: BEACHES,
        zones: ZONES,
        seasons: SEASONS,
        inputs: await readPublishInputs(state),
        now,
      });

    it("시즌 안 관측 → 문구 원문·관측 시각·기관, 계약 통과, 분류는 이안류가 없을 때와 같음", async () => {
      const without = new MemoryStateStore();
      await seedWarnings(without, [HEAVY_RAIN_ROW]);
      await seedReadings(without);
      const withRip = new MemoryStateStore();
      await seedWarnings(withRip, [HEAVY_RAIN_ROW]);
      await seedReadings(withRip);
      await seedRip(withRip, "위험");

      const base = await build(without, IN_SEASON);
      const snapshot = await build(withRip, IN_SEASON);
      expectContract(snapshot);
      const status = snapshot.status.beaches.b0001!;
      expect(status.info.ripCurrent).toEqual({
        label: "위험",
        publishedAt: "2026-08-15T03:00:00Z",
        source: "국립해양조사원",
      });
      const { info: _a, ...rest } = status;
      const { info: _b, ...baseRest } = base.status.beaches.b0001!;
      expect(rest).toEqual(baseRest);
      // 다른 해변은 이안류 기록이 없어 null
      expect(snapshot.status.beaches.b0002!.info.ripCurrent).toBeNull();
    });

    it("모르는 문구는 null로 게시", async () => {
      const state = new MemoryStateStore();
      await seedWarnings(state, [HEAVY_RAIN_ROW]);
      await seedRip(state, "점검중");
      const snapshot = await build(state, IN_SEASON);
      expect(snapshot.status.beaches.b0001!.info.ripCurrent).toBeNull();
    });

    it("시즌 밖 게시 시각(10/23)에는 지난 시즌 관측을 게시하지 않음", async () => {
      const state = new MemoryStateStore();
      await seedWarnings(state, [HEAVY_RAIN_ROW]);
      await seedRip(state, "관심");
      const snapshot = await snapshotFrom(state);
      expect(snapshot.status.beaches.b0001!.info.ripCurrent).toBeNull();
    });
  });

  it("해변 id가 겹치면 덮어쓰지 않고 멈춤", async () => {
    const state = new MemoryStateStore();
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    const inputs = await readPublishInputs(state);
    expect(() =>
      buildSnapshot({
        beaches: [...BEACHES, BEACHES[0]!],
        zones: ZONES,
        seasons: SEASONS,
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
        seasons: SEASONS,
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
