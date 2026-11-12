import { describe, expect, it } from "vitest";
import { createLogger } from "../core/collect/log";
import { MemorySnapshotStore } from "../core/snapshots/memory";
import { MemoryOpsStore, MemoryStateStore } from "../core/store/memory";
import {
  BEACHES,
  HEAVY_RAIN_ROW,
  NOW,
  SEASONS,
  WEATHER_AREAS,
  WIND_WAVE_ROW,
  ZONES,
  seedReadings,
  seedWarnings,
} from "./fixtures";
import { previewSnapshot } from "./preview";
import { publishSnapshot } from "./publish";

// 게시 변경 미리보기 (#331, 캔버스 N2). 쓰지 않고 '지금 게시'의 분류 변화를 publisher 코드로 계산

const NOW_MS = Date.parse(NOW);

async function setup() {
  const state = new MemoryStateStore();
  const ops = new MemoryOpsStore();
  const snapshots = new MemorySnapshotStore();
  await seedWarnings(state, [HEAVY_RAIN_ROW]);
  await seedReadings(state);
  let nowMs = NOW_MS;
  const deps = () => ({
    state,
    ops,
    snapshots,
    beaches: BEACHES,
    beachIds: BEACHES.map((b) => b.id),
    zones: ZONES,
    seasons: SEASONS,
    weatherAreas: WEATHER_AREAS,
    notices: async () => [],
    log: createLogger(() => []),
    clock: () => nowMs,
    owner: "run-1",
  });
  return {
    state,
    ops,
    snapshots,
    deps,
    advance: (ms: number) => (nowMs += ms),
  };
}

describe("previewSnapshot", () => {
  it("게시본이 없으면 지금 쪽은 '확인 못 함'이고 다음 분류 수만 준다", async () => {
    const { deps } = await setup();
    const preview = await previewSnapshot(deps());
    expect(preview).toMatchObject({
      status: "ready",
      current: { version: null, counts: null, readable: false, missing: true },
      changed: [],
      changedCount: 0,
      checks: { beachIds: null, expected: BEACHES.length, contractErrors: 0 },
    });
    if (preview.status !== "ready") throw new Error("ready");
    const counts = preview.next.counts!;
    expect(counts.clear + counts.unavailable + counts.undetermined).toBe(
      BEACHES.length,
    );
  });

  it("새 특보가 들어오면 바뀌는 해변을 지금·게시 뒤 분류·사유로 주고, 아무것도 쓰지 않는다", async () => {
    const { state, ops, snapshots, deps, advance } = await setup();
    await publishSnapshot(deps());
    const filesBefore = [...snapshots.files.keys()].sort();
    advance(60_000);
    await seedWarnings(state, [HEAVY_RAIN_ROW, WIND_WAVE_ROW], {
      confirmedAt: new Date(NOW_MS + 60_000).toISOString(),
    });
    const preview = await previewSnapshot(deps());
    if (preview.status !== "ready") throw new Error(preview.status);
    expect(preview.current.readable).toBe(true);
    expect(preview.changedCount).toBeGreaterThan(0);
    for (const change of preview.changed) {
      expect(change.after.category).toBe("unavailable");
      expect(change.after.reasons[0]).toMatchObject({
        code: "warning",
        type: "wind_wave",
        level: "advisory",
      });
      expect(change.before?.category).not.toBe("unavailable");
    }
    expect(preview.next.counts!.unavailable).toBe(
      preview.current.counts!.unavailable + preview.changedCount,
    );
    // 게시 파일·실행 기록을 바꾸지 않고 게시 잠금도 잡지 않음
    expect([...snapshots.files.keys()].sort()).toEqual(filesBefore);
    expect(ops.lastRun).toMatchObject({ result: "published", at: NOW });
    expect(
      await ops.acquireLock("publish-snapshot", "other", NOW_MS + 60_000, 1),
    ).toBe(true);
  });

  it("게시본은 있는데 해변 상태 파일을 읽지 못하면 '없음'이 아니라 '읽지 못함'(missing false)", async () => {
    const { snapshots, deps } = await setup();
    await publishSnapshot(deps());
    for (const path of [...snapshots.files.keys()]) {
      if (path.endsWith("/status.json")) snapshots.files.delete(path);
    }
    const preview = await previewSnapshot(deps());
    expect(preview).toMatchObject({
      status: "ready",
      current: { counts: null, readable: false, missing: false },
      changed: [],
    });
  });

  it("해변 ID가 원본 목록과 다르면 '이대로면 게시 안 함'(blocked)과 대조 결과를 준다", async () => {
    const { deps } = await setup();
    const preview = await previewSnapshot({
      ...deps(),
      beachIds: [...BEACHES.map((b) => b.id), "b9999"],
    });
    expect(preview).toMatchObject({
      status: "blocked",
      reason: "beach_ids",
      checks: {
        beachIds: { where: "source", missing: 1, extra: 0, duplicate: 0 },
        expected: BEACHES.length + 1,
      },
    });
  });
});
