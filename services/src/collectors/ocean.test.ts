import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HttpResult } from "../core/collect/http";
import { createLogger } from "../core/collect/log";
import { MemoryOpsStore, MemoryStateStore } from "../core/store/memory";
import type { StateValue } from "../core/store/types";
import { collectOcean, OCEAN_JOB, OCEAN_STATE } from "./ocean";
import { finishRun } from "./trigger";

// collect-ocean (BRD-56). HTTP·키·저장소를 가짜로 바꿔 실패 경로를 확인
// 응답 본문은 BRD-19 실응답 픽스처(관측 2026-10-20T14:10~15:00Z)
const read = (name: string) =>
  readFileSync(
    new URL(`../core/observations/fixtures/${name}`, import.meta.url),
    "utf8",
  );
const SEA_OBS = read("sea-obs-2026102100.txt");
const KMA_BUOY = read("kma-buoy-2026102100.txt");
const NOW = "2026-10-20T15:42:00Z"; // KST 00:42 → 슬롯 202610210040
const KEY = "APIKEY-SECRET";

type Reply = string | HttpResult;
const ok = (body: string): HttpResult => ({
  status: "ok",
  body,
  httpStatus: 200,
  attempts: 1,
});

function setup(replies: { sea_obs: Reply; kma_buoy: Reply }) {
  const state = new MemoryStateStore();
  const ops = new MemoryOpsStore();
  const urls: string[] = [];
  const lines: string[] = [];
  const deps = {
    state,
    ops,
    keys: { get: async () => KEY },
    get: async (url: string) => {
      urls.push(url);
      const reply = url.includes("/sea_obs.php")
        ? replies.sea_obs
        : replies.kma_buoy;
      return typeof reply === "string" ? ok(reply) : reply;
    },
    log: createLogger(
      () => [KEY],
      (line) => lines.push(line),
    ),
    clock: () => Date.parse(NOW),
    owner: "run-1",
  };
  return { deps, state, ops, urls, lines };
}

const readings = async (state: MemoryStateStore) =>
  ((await state.getState(OCEAN_STATE.readings.pk, OCEAN_STATE.readings.sk))
    ?.value ?? null) as {
    readings: Record<
      string,
      Record<string, { value: number; observedAt: string }>
    >;
    receivedAt: Record<string, string>;
  } | null;
const history = async (state: MemoryStateStore) =>
  ((await state.getState(OCEAN_STATE.history.pk, OCEAN_STATE.history.sk))
    ?.value ?? null) as { stations: Record<string, [number, number][]> } | null;
const sec = (iso: string) => Date.parse(iso) / 1000;
const attempt = async (state: MemoryStateStore) =>
  (await state.getState(OCEAN_STATE.attempt.pk, OCEAN_STATE.attempt.sk))
    ?.value as Record<string, StateValue>;

describe("collectOcean", () => {
  it("두 출처 모두 정상 → 마지막 정상값·출처별 수신 시각 저장, 슬롯 끝냄", async () => {
    const { deps, state, ops, urls, lines } = setup({
      sea_obs: SEA_OBS,
      kma_buoy: KMA_BUOY,
    });
    expect(await collectOcean(deps)).toEqual({
      status: "complete",
      slotId: "202610210040",
    });
    const saved = await readings(state);
    expect(saved?.readings["22520"]?.waveHeight).toEqual({
      value: 0.7,
      observedAt: "2026-10-20T15:00:00Z",
    });
    // kma_buoy는 같은 측정기의 여러 시각 중 가장 늦은 값
    expect(saved?.readings["22523"]?.wavePeriod).toEqual({
      value: 8.2,
      observedAt: "2026-10-20T15:00:00Z",
    });
    // 측정 시각(observedAt)과 수신 시각(receivedAt)을 따로 둠
    expect(saved?.receivedAt).toEqual({ sea_obs: NOW, kma_buoy: NOW });
    expect(urls.every((url) => url.includes("tm=202610210040"))).toBe(true);
    expect(
      await ops.claimSlot(
        OCEAN_JOB,
        "202610210040",
        "run-2",
        Date.parse(NOW),
        1,
      ),
    ).toBe("done");
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("한 출처만 실패 → 다른 출처는 저장, 실패한 출처의 이전 값·수신 시각은 그대로", async () => {
    const { deps, state, ops } = setup({
      sea_obs: SEA_OBS,
      kma_buoy: { status: "failed", reason: "timeout", attempts: 2 },
    });
    await state.putState(
      OCEAN_STATE.readings.pk,
      OCEAN_STATE.readings.sk,
      {
        readings: {
          "22523": {
            wavePeriod: { value: 9.9, observedAt: "2026-10-20T13:00:00Z" },
          },
        },
        receivedAt: { kma_buoy: "2026-10-20T13:05:00Z" },
      },
      Date.parse("2026-10-20T13:00:00Z"),
    );
    expect((await collectOcean(deps)).status).toBe("partial");
    const saved = await readings(state);
    expect(saved?.readings["22523"]?.wavePeriod).toEqual({
      value: 9.9,
      observedAt: "2026-10-20T13:00:00Z",
    });
    expect(saved?.receivedAt).toEqual({
      kma_buoy: "2026-10-20T13:05:00Z",
      sea_obs: NOW,
    });
    expect((await attempt(state)).sources).toMatchObject({
      sea_obs: { status: "ok" },
      kma_buoy: { status: "failed", reason: "timeout", attempts: 2 },
    });
    // 슬롯은 끝내지 않음 → lease가 지나면 다시 맡을 수 있음
    expect(
      await ops.claimSlot(
        OCEAN_JOB,
        "202610210040",
        "run-2",
        Date.parse(NOW),
        1,
      ),
    ).toBe("busy");
  });

  it("두 출처 모두 실패 → 정상값은 만들지 않고 시도만 기록", async () => {
    const { deps, state } = setup({
      sea_obs: { status: "failed", reason: "http:503", attempts: 2 },
      kma_buoy: "<html>error</html>",
    });
    expect((await collectOcean(deps)).status).toBe("failed");
    expect(await readings(state)).toBeNull();
    expect((await attempt(state)).sources).toMatchObject({
      sea_obs: { status: "failed", reason: "http:503" },
      kma_buoy: { status: "failed", reason: "시작 표시 없음" },
    });
  });

  it("자료 줄이 모두 건너뛰어져 쓸 행이 없으면 그 출처는 실패", async () => {
    const lines = SEA_OBS.split("\n");
    // 시작·끝 표시와 머리글은 두고 자료 줄만 깨뜨림
    const broken = lines
      .map((line) => (line.startsWith("#") || line.trim() === "" ? line : "x"))
      .join("\n");
    const { deps, state } = setup({ sea_obs: broken, kma_buoy: KMA_BUOY });
    expect((await collectOcean(deps)).status).toBe("partial");
    expect((await attempt(state)).sources).toMatchObject({
      sea_obs: { status: "failed" },
      kma_buoy: { status: "ok" },
    });
  });

  it("읽은 뒤 다른 실행이 쓰면 다시 읽어 합쳐 그 값을 덮지 않음", async () => {
    const { deps, state } = setup({ sea_obs: SEA_OBS, kma_buoy: KMA_BUOY });
    const other = {
      readings: {
        "99999": {
          waveHeight: { value: 0.7, observedAt: "2026-10-20T15:00:00Z" },
        },
      },
      receivedAt: {},
    };
    // 첫 읽기 직후 다른 실행이 끼어들어 씀
    const getState = state.getState.bind(state);
    let injected = false;
    state.getState = async (pk, sk) => {
      const record = await getState(pk, sk);
      if (!injected && sk === OCEAN_STATE.readings.sk) {
        injected = true;
        await state.putState(pk, sk, other, Date.parse("2026-10-20T15:00:00Z"));
      }
      return record;
    };
    await collectOcean(deps);
    expect((await readings(state))?.readings["99999"]?.waveHeight).toEqual(
      other.readings["99999"].waveHeight,
    );
  });

  it("오래된 응답이 더 늦은 정상값을 덮지 않음", async () => {
    const { deps, state } = setup({ sea_obs: SEA_OBS, kma_buoy: KMA_BUOY });
    await state.putState(
      OCEAN_STATE.readings.pk,
      OCEAN_STATE.readings.sk,
      {
        readings: {
          "22520": {
            waveHeight: { value: 1.5, observedAt: "2026-10-20T15:30:00Z" },
          },
        },
        receivedAt: {},
      },
      Date.parse("2026-10-20T15:30:00Z"),
    );
    await collectOcean(deps);
    expect((await readings(state))?.readings["22520"]?.waveHeight).toEqual({
      value: 1.5,
      observedAt: "2026-10-20T15:30:00Z",
    });
  });

  it("다른 실행이 슬롯을 맡았으면 호출하지 않고 건너뜀", async () => {
    const { deps, ops, urls } = setup({ sea_obs: SEA_OBS, kma_buoy: KMA_BUOY });
    await ops.claimSlot(
      OCEAN_JOB,
      "202610210040",
      "run-0",
      Date.parse(NOW),
      60_000,
    );
    expect(await collectOcean(deps)).toEqual({
      status: "skipped",
      slotId: "202610210040",
      claim: "busy",
    });
    expect(urls).toEqual([]);
  });

  it("API 키를 읽지 못하면 호출하지 않고 출처마다 실패로 기록", async () => {
    const { deps, state, urls } = setup({
      sea_obs: SEA_OBS,
      kma_buoy: KMA_BUOY,
    });
    const result = await collectOcean({
      ...deps,
      keys: { get: async () => Promise.reject(new Error("throttled")) },
    });
    expect(result.status).toBe("failed");
    expect(urls).toEqual([]);
    expect((await attempt(state)).sources).toEqual({
      sea_obs: { status: "failed", reason: "api_key", attempts: 0 },
      kma_buoy: { status: "failed", reason: "api_key", attempts: 0 },
    });
  });

  it("sea_obs 정상 → 측정기별 파고 원래 측정값을 이력에 저장하고 크기를 로그로 남김", async () => {
    const { deps, state, lines } = setup({
      sea_obs: SEA_OBS,
      kma_buoy: KMA_BUOY,
    });
    expect((await collectOcean(deps)).status).toBe("complete");
    const saved = await history(state);
    expect(saved?.stations["22520"]).toEqual([
      [sec("2026-10-20T15:00:00Z"), 0.7],
    ]);
    // kma_buoy 줄(파고 없음)은 이력에 넣지 않음
    expect(saved?.stations["22523"]).toBeUndefined();
    expect((await attempt(state)).historySaved).toBe(true);
    const log = lines.find((line) => line.includes("ocean_history_saved"));
    expect(JSON.parse(log!)).toMatchObject({
      stations: Object.keys(saved!.stations).length,
      bytes: expect.any(Number),
    });
  });

  it("이전 이력과 합치고 24시간 범위 밖 값은 버림", async () => {
    const { deps, state } = setup({ sea_obs: SEA_OBS, kma_buoy: KMA_BUOY });
    await state.putState(
      OCEAN_STATE.history.pk,
      OCEAN_STATE.history.sk,
      {
        stations: {
          "22520": [
            [sec("2026-10-19T13:00:00Z"), 0.2], // 범위 밖
            [sec("2026-10-20T14:00:00Z"), 0.6],
          ],
        },
      },
      Date.parse("2026-10-20T14:00:00Z"),
    );
    await collectOcean(deps);
    expect((await history(state))?.stations["22520"]).toEqual([
      [sec("2026-10-20T14:00:00Z"), 0.6],
      [sec("2026-10-20T15:00:00Z"), 0.7],
    ]);
  });

  it("sea_obs 실패 → 이전 이력은 그대로, 값을 만들지 않음", async () => {
    const { deps, state } = setup({
      sea_obs: { status: "failed", reason: "timeout", attempts: 2 },
      kma_buoy: KMA_BUOY,
    });
    const previous = {
      stations: { "22520": [[sec("2026-10-20T14:00:00Z"), 0.6]] },
    };
    await state.putState(
      OCEAN_STATE.history.pk,
      OCEAN_STATE.history.sk,
      previous,
      Date.parse("2026-10-20T14:00:00Z"),
    );
    expect((await collectOcean(deps)).status).toBe("partial");
    expect(await history(state)).toEqual(previous);
    expect((await attempt(state)).historySaved).toBe(false);
  });

  it("깨진 이력 기록은 경고를 남기고 새 값으로 덮음", async () => {
    const { deps, state, lines } = setup({
      sea_obs: SEA_OBS,
      kma_buoy: KMA_BUOY,
    });
    await state.putState(
      OCEAN_STATE.history.pk,
      OCEAN_STATE.history.sk,
      "broken",
      Date.parse("2026-10-20T14:00:00Z"),
    );
    expect((await collectOcean(deps)).status).toBe("complete");
    expect((await history(state))?.stations["22520"]).toEqual([
      [sec("2026-10-20T15:00:00Z"), 0.7],
    ]);
    const log = lines.find((line) => line.includes("ocean_history_invalid"));
    expect(JSON.parse(log!)).toMatchObject({ dropped: 1 });
  });

  it("읽은 뒤 다른 실행이 이력을 쓰면 다시 읽어 합침", async () => {
    const { deps, state } = setup({ sea_obs: SEA_OBS, kma_buoy: KMA_BUOY });
    const getState = state.getState.bind(state);
    let injected = false;
    state.getState = async (pk, sk) => {
      const record = await getState(pk, sk);
      if (!injected && sk === OCEAN_STATE.history.sk) {
        injected = true;
        await state.putState(
          pk,
          sk,
          { stations: { "99999": [[sec("2026-10-20T15:00:00Z"), 1.2]] } },
          Date.parse("2026-10-20T15:00:00Z"),
        );
      }
      return record;
    };
    expect((await collectOcean(deps)).status).toBe("complete");
    const saved = await history(state);
    expect(saved?.stations["99999"]).toEqual([
      [sec("2026-10-20T15:00:00Z"), 1.2],
    ]);
    expect(saved?.stations["22520"]).toEqual([
      [sec("2026-10-20T15:00:00Z"), 0.7],
    ]);
  });

  it("정상값 저장이 예외를 던져도 이력은 저장하고, 시도 기록을 남긴 뒤 publisher를 깨움", async () => {
    const { deps, state, lines } = setup({
      sea_obs: SEA_OBS,
      kma_buoy: KMA_BUOY,
    });
    const putState = state.putState.bind(state);
    state.putState = async (pk, sk, ...rest) => {
      if (sk === OCEAN_STATE.readings.sk) throw new Error("throttled");
      return putState(pk, sk, ...rest);
    };
    const result = await collectOcean(deps);
    expect(result).toEqual({ status: "failed", slotId: "202610210040" });
    expect(await readings(state)).toBeNull();
    expect((await history(state))?.stations["22520"]).toEqual([
      [sec("2026-10-20T15:00:00Z"), 0.7],
    ]);
    expect(await attempt(state)).toMatchObject({
      readingsSaved: false,
      historySaved: true,
    });
    expect(lines.join("\n")).toContain("ocean_readings_failed");
    let invoked = 0;
    await expect(
      finishRun(result, {
        invoke: async () => {
          invoked += 1;
        },
        log: deps.log,
      }),
    ).rejects.toThrow("수집 failed");
    expect(invoked).toBe(1);
  });

  it("이력 저장만 실패 → partial(정상값은 저장, 슬롯은 끝내지 않음)이고 publisher는 깨움", async () => {
    const { deps, state, ops, lines } = setup({
      sea_obs: SEA_OBS,
      kma_buoy: KMA_BUOY,
    });
    const putState = state.putState.bind(state);
    state.putState = async (pk, sk, ...rest) => {
      if (sk === OCEAN_STATE.history.sk) throw new Error("throttled");
      return putState(pk, sk, ...rest);
    };
    const result = await collectOcean(deps);
    expect(result).toEqual({ status: "partial", slotId: "202610210040" });
    expect((await readings(state))?.readings["22520"]?.waveHeight?.value).toBe(
      0.7,
    );
    expect(await history(state)).toBeNull();
    expect(await attempt(state)).toMatchObject({
      readingsSaved: true,
      historySaved: false,
    });
    expect(lines.join("\n")).toContain("ocean_history_failed");
    expect(
      await ops.claimSlot(
        OCEAN_JOB,
        "202610210040",
        "run-2",
        Date.parse(NOW),
        1,
      ),
    ).toBe("busy");
    // 수집 결과가 partial이어도 publish-snapshot을 먼저 깨우고 그 뒤에 던짐(Lambda 마무리와 같은 함수)
    let invoked = 0;
    await expect(
      finishRun(result, {
        invoke: async () => {
          invoked += 1;
        },
        log: deps.log,
      }),
    ).rejects.toThrow("수집 partial");
    expect(invoked).toBe(1);
  });
});
