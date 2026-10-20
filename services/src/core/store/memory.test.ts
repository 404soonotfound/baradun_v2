import { describe, expect, it } from "vitest";
import { MemoryOpsStore, MemoryStateStore } from "./memory";
import { SLOT_RECORD_RETENTION_MS } from "./types";

// 저장소 규칙 검사 (BRD-55 T03 슬롯 멱등·T04 실행 겹침)

const NOW = Date.UTC(2026, 9, 20, 5, 30); // 2026-10-20T05:30:00Z
const MINUTE = 60 * 1000;
const LEASE = 5 * MINUTE;

describe("T03 슬롯 멱등", () => {
  it("같은 슬롯을 두 번 실행하면 두 번째는 done, 결과는 한 번만 남는다", async () => {
    const ops = new MemoryOpsStore();
    const results: string[] = [];

    // 같은 슬롯을 두 번 부름 (Scheduler 재시도 흉내)
    for (const run of ["run-a", "run-b"]) {
      const claim = await ops.claimSlot(
        "warnings",
        "20261020T0530Z",
        run,
        NOW,
        LEASE,
      );
      if (claim !== "claimed") continue;
      results.push(run);
      expect(await ops.completeSlot("warnings", "20261020T0530Z", run)).toBe(
        true,
      );
    }

    expect(results).toEqual(["run-a"]);
    expect(
      await ops.claimSlot(
        "warnings",
        "20261020T0530Z",
        "run-c",
        NOW + MINUTE,
        LEASE,
      ),
    ).toBe("done");
  });

  it("끝나지 않고 lease가 지난 슬롯은 다른 실행이 다시 맡는다", async () => {
    const ops = new MemoryOpsStore();
    expect(await ops.claimSlot("warnings", "s1", "run-a", NOW, LEASE)).toBe(
      "claimed",
    );

    // lease 끝 시각까지는 아직 맡은 상태
    expect(
      await ops.claimSlot("warnings", "s1", "run-b", NOW + LEASE, LEASE),
    ).toBe("busy");
    expect(
      await ops.claimSlot("warnings", "s1", "run-b", NOW + LEASE + 1, LEASE),
    ).toBe("claimed");

    // 앞선 실행이 늦게 끝내려 해도 owner가 달라 실패, 새 실행은 끝낼 수 있음
    expect(await ops.completeSlot("warnings", "s1", "run-a")).toBe(false);
    expect(await ops.completeSlot("warnings", "s1", "run-b")).toBe(true);
    expect(
      await ops.claimSlot("warnings", "s1", "run-a", NOW + 2 * LEASE, LEASE),
    ).toBe("done");
  });

  it("맡은 적 없는 슬롯은 끝낼 수 없다", async () => {
    const ops = new MemoryOpsStore();
    expect(await ops.completeSlot("warnings", "s1", "run-a")).toBe(false);
  });

  it("작업이 다르면 같은 슬롯 ID라도 따로 센다", async () => {
    const ops = new MemoryOpsStore();
    await ops.claimSlot("warnings", "s1", "run-a", NOW, LEASE);
    await ops.completeSlot("warnings", "s1", "run-a");
    expect(await ops.claimSlot("waves", "s1", "run-b", NOW, LEASE)).toBe(
      "claimed",
    );
  });

  it("슬롯 기록은 7일 뒤 정리되게 ttl(epoch 초)을 남긴다", async () => {
    const ops = new MemoryOpsStore();
    await ops.claimSlot("warnings", "s1", "run-a", NOW, LEASE);
    expect(SLOT_RECORD_RETENTION_MS).toBe(7 * 24 * 60 * MINUTE);
    expect(ops.slotRecord("warnings", "s1")?.ttl).toBe(
      (NOW + SLOT_RECORD_RETENTION_MS) / 1000,
    );
  });

  it("오래된 State 쓰기는 stale로 거부되고 값은 그대로다", async () => {
    const state = new MemoryStateStore();
    expect(await state.putState("wave#1", "latest", { height: 1.2 }, NOW)).toBe(
      "written",
    );
    expect(
      await state.putState("wave#1", "latest", { height: 0.4 }, NOW - MINUTE),
    ).toBe("stale");
    expect(await state.getState("wave#1", "latest")).toEqual({
      pk: "wave#1",
      sk: "latest",
      value: { height: 1.2 },
      orderAt: NOW,
      recordVersion: 1,
    });
  });

  it("같은 orderAt·같은 값은 unchanged, recordVersion 그대로다 (key 순서 무관)", async () => {
    const state = new MemoryStateStore();
    await state.putState("wave#1", "latest", { height: 1.2, unit: "m" }, NOW);
    expect(
      await state.putState("wave#1", "latest", { unit: "m", height: 1.2 }, NOW),
    ).toBe("unchanged");
    expect((await state.getState("wave#1", "latest"))?.recordVersion).toBe(1);
  });

  it("쓰기 뒤 원본의 중첩 객체·배열을 바꿔도 저장값과 recordVersion은 그대로다", async () => {
    const state = new MemoryStateStore();
    const value = { wave: { height: 1.2 }, samples: [{ height: 1.1 }] };
    expect(await state.putState("wave#1", "latest", value, NOW)).toBe(
      "written",
    );

    value.wave.height = 9;
    value.samples[0]!.height = 8;
    value.samples.push({ height: 7 });

    expect(await state.getState("wave#1", "latest")).toEqual({
      pk: "wave#1",
      sk: "latest",
      value: { wave: { height: 1.2 }, samples: [{ height: 1.1 }] },
      orderAt: NOW,
      recordVersion: 1,
    });
  });

  it("읽은 값의 중첩 객체·배열을 바꿔도 다시 읽은 저장값은 그대로다", async () => {
    const state = new MemoryStateStore();
    const value = { wave: { height: 1.2 }, samples: [{ height: 1.1 }] };
    await state.putState("wave#1", "latest", value, NOW);

    const record = await state.getState("wave#1", "latest");
    expect(record).not.toBeNull();
    // 읽기 전용 타입을 해제하여 호출자의 런타임 변경 재현
    const received = record!.value as typeof value;
    received.wave.height = 9;
    received.samples[0]!.height = 8;
    received.samples.push({ height: 7 });

    expect(await state.getState("wave#1", "latest")).toEqual({
      pk: "wave#1",
      sk: "latest",
      value: { wave: { height: 1.2 }, samples: [{ height: 1.1 }] },
      orderAt: NOW,
      recordVersion: 1,
    });
  });

  it("값이나 orderAt이 바뀌면 written, recordVersion +1", async () => {
    const state = new MemoryStateStore();
    await state.putState("wave#1", "latest", { height: 1.2 }, NOW);
    // 같은 시각인데 값이 다름 → 정정
    expect(await state.putState("wave#1", "latest", { height: 1.3 }, NOW)).toBe(
      "written",
    );
    // 값은 같고 더 새 시각 → 신선도가 바뀜
    expect(
      await state.putState("wave#1", "latest", { height: 1.3 }, NOW + MINUTE),
    ).toBe("written");
    const record = await state.getState("wave#1", "latest");
    expect(record?.recordVersion).toBe(3);
    expect(record?.orderAt).toBe(NOW + MINUTE);
  });

  it("두 실행이 같은 기록을 동시에 쓰면 하나만 written, 나머지는 conflict", async () => {
    const state = new MemoryStateStore();
    await state.putState("wave#1", "latest", { height: 1.0 }, NOW);
    const results = await Promise.all([
      state.putState("wave#1", "latest", { height: 1.1 }, NOW + MINUTE),
      state.putState("wave#1", "latest", { height: 1.2 }, NOW + MINUTE),
    ]);
    expect([...results].sort()).toEqual(["conflict", "written"]);
    expect((await state.getState("wave#1", "latest"))?.recordVersion).toBe(2);
  });

  it("게시 버전은 앞으로만 간다 (역행·같은 값 거부)", async () => {
    const ops = new MemoryOpsStore();
    expect(await ops.getPublishedVersion()).toBeNull();
    expect(await ops.setPublishedVersion("20261017T053000Z")).toBe(true);
    expect(await ops.setPublishedVersion("20261017T051500Z")).toBe(false);
    expect(await ops.setPublishedVersion("20261017T053000Z")).toBe(false);
    expect(await ops.getPublishedVersion()).toBe("20261017T053000Z");
    expect(await ops.setPublishedVersion("20261017T054500Z")).toBe(true);
    expect(await ops.getPublishedVersion()).toBe("20261017T054500Z");
  });

  it("형식이 다른 게시 버전은 오류다 (글자 비교가 시각 순서와 어긋나지 않게)", async () => {
    const ops = new MemoryOpsStore();
    await expect(
      ops.setPublishedVersion("2026-10-17T05:30:00Z"),
    ).rejects.toThrow("invalid snapshotVersion");
  });
});

describe("T04 실행 겹침", () => {
  it("두 실행이 동시에 잠그면 하나만 성공한다", async () => {
    const ops = new MemoryOpsStore();
    const results = await Promise.all([
      ops.acquireLock("publish", "run-a", NOW, LEASE),
      ops.acquireLock("publish", "run-b", NOW, LEASE),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("만료된 잠금은 다른 실행이 가져간다", async () => {
    const ops = new MemoryOpsStore();
    expect(await ops.acquireLock("publish", "run-a", NOW, LEASE)).toBe(true);
    expect(await ops.acquireLock("publish", "run-b", NOW + LEASE, LEASE)).toBe(
      false,
    );
    expect(
      await ops.acquireLock("publish", "run-b", NOW + LEASE + 1, LEASE),
    ).toBe(true);
    // 가져간 뒤에는 앞선 실행이 해제할 수 없음
    expect(await ops.releaseLock("publish", "run-a")).toBe(false);
  });

  it("남의 잠금은 해제할 수 없다", async () => {
    const ops = new MemoryOpsStore();
    await ops.acquireLock("publish", "run-a", NOW, LEASE);
    expect(await ops.releaseLock("publish", "run-b")).toBe(false);
    expect(await ops.acquireLock("publish", "run-b", NOW + MINUTE, LEASE)).toBe(
      false,
    );
  });

  it("해제한 뒤에는 다시 잠글 수 있다", async () => {
    const ops = new MemoryOpsStore();
    await ops.acquireLock("publish", "run-a", NOW, LEASE);
    expect(await ops.releaseLock("publish", "run-a")).toBe(true);
    expect(await ops.acquireLock("publish", "run-b", NOW + MINUTE, LEASE)).toBe(
      true,
    );
  });

  it("같은 슬롯을 두 실행이 동시에 맡으면 하나만 claimed", async () => {
    const ops = new MemoryOpsStore();
    const results = await Promise.all([
      ops.claimSlot("warnings", "s1", "run-a", NOW, LEASE),
      ops.claimSlot("warnings", "s1", "run-b", NOW, LEASE),
    ]);
    expect([...results].sort()).toEqual(["busy", "claimed"]);
  });
});
