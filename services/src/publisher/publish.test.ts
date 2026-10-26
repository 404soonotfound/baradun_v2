import type { ManifestFile } from "@baradun/contracts";
import { describe, expect, it } from "vitest";
import { createLogger } from "../core/collect/log";
import { MemorySnapshotStore } from "../core/snapshots/memory";
import { MemoryOpsStore, MemoryStateStore } from "../core/store/memory";
import {
  BEACHES,
  HEAVY_RAIN_ROW,
  NOW,
  SEASONS,
  WIND_WAVE_ROW,
  ZONES,
  seedReadings,
  seedWarnings,
} from "./fixtures";
import { MANIFEST_SETTINGS, PUBLISH_POLICY } from "./policy";
import {
  MANIFEST_PATH,
  publishSnapshot,
  rollbackManifest,
  snapshotVersion,
} from "./publish";

// publish-snapshot (BRD-61). T01 게시 원자성: 실패하면 manifest 그대로, T06 manifest 교체·롤백
// 버전 경로 파일 → manifest 순서, Cache-Control, 게시 잠금, 48개 보존

const NOW_MS = Date.parse(NOW);
const V1 = snapshotVersion(NOW_MS); // 20261023T023000Z

async function setup(
  options: {
    failOn?: (path: string) => boolean;
    beforeConditionalPut?: (path: string) => Promise<void> | void;
    seed?: boolean;
  } = {},
) {
  const state = new MemoryStateStore();
  const ops = new MemoryOpsStore();
  const snapshots = new MemorySnapshotStore({
    failOn: options.failOn,
    // 아래 deps·advance가 만들어진 뒤에 부르므로 hooks에서 꺼내 씀
    beforeConditionalPut: (path) => options.beforeConditionalPut?.(path),
  });
  const lines: string[] = [];
  if (options.seed !== false) {
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    await seedReadings(state);
  }
  let nowMs = NOW_MS;
  const deps = (owner = "run-1") => ({
    state,
    ops,
    snapshots,
    beaches: BEACHES,
    zones: ZONES,
    seasons: SEASONS,
    log: createLogger(
      () => [],
      (line) => lines.push(line),
    ),
    clock: () => nowMs,
    owner,
  });
  const advance = (ms: number) => {
    nowMs += ms;
    return snapshotVersion(nowMs);
  };
  const manifest = () => {
    const body = snapshots.files.get(MANIFEST_PATH)?.body;
    return body ? (JSON.parse(body) as ManifestFile) : null;
  };
  const events = () =>
    lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { state, ops, snapshots, deps, advance, manifest, events };
}

describe("publishSnapshot", () => {
  it("버전 경로 파일을 먼저 쓰고 manifest를 바꾼 뒤 게시 버전을 기록함", async () => {
    const { ops, snapshots, deps, manifest } = await setup();
    const order: string[] = [];
    const put = snapshots.putFile.bind(snapshots);
    snapshots.putFile = async (path, body, cacheControl) => {
      order.push(path);
      await put(path, body, cacheControl);
    };
    const putIf = snapshots.putFileIf.bind(snapshots);
    snapshots.putFileIf = async (path, body, cacheControl, etag) => {
      order.push(path);
      return putIf(path, body, cacheControl, etag);
    };

    expect(await publishSnapshot(deps())).toEqual({
      status: "published",
      version: V1,
      removed: [],
    });
    expect(order.at(-1)).toBe(MANIFEST_PATH);
    expect(order.slice(0, -1).sort()).toEqual(
      [
        "beaches.json",
        "history.json",
        "manifest.json",
        "nationwide-warnings.json",
        "status.json",
      ].map((name) => `data/${V1}/${name}`),
    );
    expect(manifest()).toMatchObject({
      schemaVersion: 1,
      snapshotVersion: V1,
      policyVersion: PUBLISH_POLICY.policyVersion,
      generatedAt: NOW,
      files: { status: `/data/${V1}/status.json` },
    });
    expect(await ops.getPublishedVersion()).toBe(V1);
    // 잠금을 풀어 다음 실행이 바로 맡을 수 있음
    expect(
      await ops.acquireLock(PUBLISH_POLICY.lockName, "next", NOW_MS, 1),
    ).toBe(true);
  });

  it("모든 파일에 Cache-Control: manifest 60초, 버전 경로 1년 immutable", async () => {
    const { snapshots, deps } = await setup();
    await publishSnapshot(deps());
    for (const [path, file] of snapshots.files) {
      expect(file.cacheControl, path).toBe(
        path === MANIFEST_PATH
          ? "public, max-age=60"
          : "public, max-age=31536000, immutable",
      );
    }
  });

  it("내용이 같으면 게시하지 않음(새 버전 경로 없음)", async () => {
    const { snapshots, deps, advance } = await setup();
    await publishSnapshot(deps());
    advance(60_000);
    expect(await publishSnapshot(deps())).toEqual({
      status: "unchanged",
      version: V1,
    });
    expect(await snapshots.listVersions()).toEqual([V1]);
  });

  // 운영 절차(infra/README '점검·강제 업데이트'): policy.ts의 MANIFEST_SETTINGS를 바꿔 배포하면 다음 게시에 반영
  // 데이터가 그대로여도 manifest 설정이 다르면 새로 게시해야 함 → 지금 manifest에 이전 설정이 남은 경우로 확인(BRD-43)
  it.each([
    ["점검", { maintenance: { active: true, until: null } }],
    ["최소 화면 버전", { minWebBuild: 99 }],
  ] as const)(
    "데이터가 같아도 지금 manifest의 %s 설정이 다르면 새 버전으로 게시해 설정을 반영함",
    async (_, previous) => {
      const { snapshots, deps, advance, manifest } = await setup();
      await publishSnapshot(deps());
      const file = snapshots.files.get(MANIFEST_PATH)!;
      snapshots.files.set(MANIFEST_PATH, {
        ...file,
        body: JSON.stringify({ ...manifest()!, ...previous }),
      });
      const v2 = advance(60_000);
      expect(await publishSnapshot(deps())).toMatchObject({
        status: "published",
        version: v2,
      });
      expect(manifest()).toMatchObject({
        snapshotVersion: v2,
        maintenance: MANIFEST_SETTINGS.maintenance,
        minWebBuild: MANIFEST_SETTINGS.minWebBuild,
      });
    },
  );

  it("내용이 바뀌면 새 버전으로 게시하고 이전 버전 경로는 남김", async () => {
    const { state, snapshots, deps, advance, manifest } = await setup();
    await publishSnapshot(deps());
    const v2 = advance(60_000);
    await seedWarnings(state, [WIND_WAVE_ROW], {
      confirmedAt: "2026-10-23T02:25:00Z",
    });
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
      version: v2,
    });
    expect(manifest()!.snapshotVersion).toBe(v2);
    expect(await snapshots.listVersions()).toEqual([V1, v2]);
  });

  it("T01: 버전 경로 업로드가 실패하면 manifest는 이전 버전 그대로, 올리다 만 파일은 지움", async () => {
    let failing = false;
    const { state, snapshots, deps, advance, manifest, events } = await setup({
      failOn: (path) => failing && path.endsWith("/status.json"),
    });
    await publishSnapshot(deps());
    const before = snapshots.files.get(MANIFEST_PATH);

    failing = true;
    const v2 = advance(60_000);
    await seedWarnings(state, [WIND_WAVE_ROW], {
      confirmedAt: "2026-10-23T02:25:00Z",
    });
    expect(await publishSnapshot(deps())).toEqual({
      status: "failed",
      version: v2,
      reason: "exception:Error",
    });
    expect(snapshots.files.get(MANIFEST_PATH)).toBe(before);
    expect(manifest()!.snapshotVersion).toBe(V1);
    expect(await snapshots.listVersions()).toEqual([V1]);
    expect(events().at(-1)).toMatchObject({
      level: "error",
      event: "publish_failed",
    });
  });

  it("T01: manifest 쓰기가 실패해도 이전 manifest 그대로, 게시 버전도 그대로", async () => {
    let failing = false;
    const { state, ops, deps, advance, manifest } = await setup({
      failOn: (path) => failing && path === MANIFEST_PATH,
    });
    await publishSnapshot(deps());
    failing = true;
    advance(60_000);
    await seedWarnings(state, [WIND_WAVE_ROW], {
      confirmedAt: "2026-10-23T02:25:00Z",
    });
    expect((await publishSnapshot(deps())).status).toBe("failed");
    expect(manifest()!.snapshotVersion).toBe(V1);
    expect(await ops.getPublishedVersion()).toBe(V1);
  });

  it("manifest 쓰기가 실제로 된 뒤 응답만 실패하면 그 버전 경로를 지우지 않음", async () => {
    const { snapshots, deps, manifest } = await setup();
    const putIf = snapshots.putFileIf.bind(snapshots);
    snapshots.putFileIf = async (path, body, cacheControl, etag) => {
      const written = await putIf(path, body, cacheControl, etag);
      if (path === MANIFEST_PATH) throw new Error("timeout");
      return written;
    };
    expect((await publishSnapshot(deps())).status).toBe("failed");
    expect(manifest()!.snapshotVersion).toBe(V1);
    expect(snapshots.files.has(`data/${V1}/status.json`)).toBe(true);
  });

  it("업로드 중 다른 실행이 더 새 버전을 게시했으면 manifest를 바꾸지 않음", async () => {
    const { ops, snapshots, deps, manifest } = await setup();
    const newer = "20261023T023001Z";
    const put = snapshots.putFile.bind(snapshots);
    snapshots.putFile = async (path, body, cacheControl) => {
      await put(path, body, cacheControl);
      if (path === `data/${V1}/manifest.json`) {
        await ops.setPublishedVersion(newer);
      }
    };
    expect(await publishSnapshot(deps())).toEqual({
      status: "failed",
      version: V1,
      reason: "version_not_newer",
    });
    expect(manifest()).toBeNull();
    expect(await snapshots.listVersions()).toEqual([]);
  });

  it("계약을 통과하지 못하면 아무 파일도 쓰지 않음", async () => {
    const { state, snapshots, deps, events } = await setup({ seed: false });
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    await seedReadings(state, "0.5"); // 측정값이 글자 → 계약 위반
    expect(await publishSnapshot(deps())).toEqual({
      status: "failed",
      version: V1,
      reason: "contract",
    });
    expect(snapshots.files.size).toBe(0);
    expect(events().at(-1)).toMatchObject({ reason: "contract" });
  });

  it("해변 분류가 멈추면 게시하지 않고 로그에 해변 id와 slug를 함께 남김", async () => {
    const { state, snapshots, deps, events } = await setup({ seed: false });
    await seedReadings(state);
    // 발효 특보는 있는데 두 출처의 확인 시각이 모두 깨짐 → 분류가 멈춰야 하는 입력(BRD-21 ⑥)
    await seedWarnings(state, [WIND_WAVE_ROW]);
    for (const sk of ["pwncd", "tsunami"]) {
      const record = await state.getState("warnings", sk);
      await state.putState(
        "warnings",
        sk,
        { ...(record!.value as object), lastConfirmedAt: "bad-time" },
        record!.orderAt + 1,
      );
    }
    expect(await publishSnapshot(deps())).toMatchObject({ status: "failed" });
    expect(snapshots.files.size).toBe(0);
    expect(events().at(-1)).toMatchObject({
      event: "publish_failed",
      reason: "classify",
      beachId: "b0001",
      slug: "gangmun",
    });
  });

  it("다른 실행이 게시 중이면(잠금) 아무것도 하지 않음", async () => {
    const { ops, snapshots, deps } = await setup();
    await ops.acquireLock(PUBLISH_POLICY.lockName, "other", NOW_MS, 60_000);
    expect(await publishSnapshot(deps())).toEqual({ status: "busy" });
    expect(snapshots.files.size).toBe(0);
    // 남의 잠금을 풀지 않음
    expect(await ops.acquireLock(PUBLISH_POLICY.lockName, "x", NOW_MS, 1)).toBe(
      false,
    );
  });

  it("두 실행이 겹치면 하나만 게시함", async () => {
    const { snapshots, deps } = await setup();
    const results = await Promise.all([
      publishSnapshot(deps("a")),
      publishSnapshot(deps("b")),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["busy", "published"]);
    expect(await snapshots.listVersions()).toEqual([V1]);
  });

  it("같은 초에 다시 돌거나 시계가 뒤로 가면 이미 쓴 버전을 덮지 않음", async () => {
    const { ops, snapshots, deps } = await setup();
    await ops.setPublishedVersion("20261023T023001Z");
    expect(await publishSnapshot(deps())).toEqual({
      status: "failed",
      version: V1,
      reason: "version_not_newer",
    });
    expect(snapshots.files.size).toBe(0);
  });

  it("Ops 게시 버전 기록이 사라져도 manifest가 가리키는 버전 경로를 다시 쓰지 않음", async () => {
    const { state, ops, snapshots, deps } = await setup();
    await publishSnapshot(deps());
    const before = snapshots.files.get(`data/${V1}/status.json`);
    // manifest 교체 뒤 게시 버전 기록이 실패한 상황: Ops 기록만 비어 있음
    ops.getPublishedVersion = async () => null;
    // 같은 초에 입력이 바뀌어 다시 실행됨
    await seedWarnings(state, [WIND_WAVE_ROW], {
      confirmedAt: "2026-10-23T02:25:00Z",
    });
    expect(await publishSnapshot(deps())).toEqual({
      status: "failed",
      version: V1,
      reason: "version_not_newer",
    });
    // immutable로 캐시되는 버전 경로 파일이 다른 내용으로 덮이지 않음
    expect(snapshots.files.get(`data/${V1}/status.json`)).toBe(before);
  });

  it("업로드 하나가 실패해도 시작한 쓰기를 모두 기다린 뒤 정리함(늦은 쓰기가 남지 않음)", async () => {
    const { snapshots, deps } = await setup();
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const put = snapshots.putFile.bind(snapshots);
    snapshots.putFile = async (path, body, cacheControl) => {
      if (path.endsWith("/status.json")) throw new Error("boom");
      if (path.endsWith("/beaches.json")) await slow; // 다른 쓰기 하나는 늦게 끝남
      await put(path, body, cacheControl);
    };
    const pending = publishSnapshot(deps());
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseSlow();
    expect((await pending).status).toBe("failed");
    // 늦게 끝난 beaches.json도 버전 경로 삭제 뒤에 되살아나지 않음
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await snapshots.listVersions()).toEqual([]);
    expect(snapshots.files.size).toBe(0);
  });

  it("동시 실행: 잠금이 풀린 사이 더 새 버전이 먼저 manifest를 바꾸면 옛 버전으로 덮지 않음", async () => {
    // 실행 A가 잠금 시간을 넘겨 늦어진 사이, 실행 B가 잠금을 새로 맡아 더 새 버전을 게시함
    // A는 manifest를 확인한 뒤 쓰기 직전에 B가 끼어듦 → 조건부 쓰기가 거절되고, 다시 읽어 더 새 버전을 보고 멈춤
    let interleaved = false;
    let newer = "";
    const ctx: { run?: () => Promise<void> } = {};
    const { state, snapshots, deps, advance, manifest } = await setup({
      beforeConditionalPut: async () => {
        if (interleaved) return;
        interleaved = true;
        await ctx.run!();
      },
    });
    ctx.run = async () => {
      newer = advance(PUBLISH_POLICY.lockTtlMs + 1_000);
      await seedWarnings(state, [WIND_WAVE_ROW], {
        confirmedAt: "2026-10-23T02:25:00Z",
      });
      expect(await publishSnapshot(deps("b"))).toMatchObject({
        status: "published",
        version: newer,
      });
    };

    expect(await publishSnapshot(deps("a"))).toEqual({
      status: "failed",
      version: V1,
      reason: "version_not_newer",
    });
    expect(manifest()!.snapshotVersion).toBe(newer);
    // A가 올린 버전 경로는 manifest가 가리키지 않으므로 정리됨
    expect(await snapshots.listVersions()).toEqual([newer]);
  });

  it("동시 실행: 확인과 쓰기 사이에 옛 버전 쓰기가 끼어들어도 다시 읽고 새 버전으로 바꿈", async () => {
    let inject = false;
    let staleManifest = "";
    const { state, snapshots, deps, advance, manifest, events } = await setup({
      beforeConditionalPut: async (path) => {
        if (!inject || path !== MANIFEST_PATH) return;
        inject = false;
        // 늦게 끝난 다른 실행이 V1 manifest를 다시 씀(조건 없이 쓰는 옛 코드·수동 복구 등)
        await snapshots.putFile(MANIFEST_PATH, staleManifest, "x");
      },
    });
    await publishSnapshot(deps());
    staleManifest = snapshots.files.get(MANIFEST_PATH)!.body;
    const v2 = advance(60_000);
    await seedWarnings(state, [WIND_WAVE_ROW], {
      confirmedAt: "2026-10-23T02:25:00Z",
    });
    inject = true;

    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
      version: v2,
    });
    expect(manifest()!.snapshotVersion).toBe(v2);
    expect(events()).toContainEqual(
      expect.objectContaining({
        event: "publish_manifest_conflict",
        version: v2,
        attempt: 1,
      }),
    );
  });

  it("조건부 쓰기가 계속 거절되면 manifest를 바꾸지 않고 실패로 남김", async () => {
    const { snapshots, deps, manifest } = await setup();
    snapshots.putFileIf = async () => false;
    expect(await publishSnapshot(deps())).toEqual({
      status: "failed",
      version: V1,
      reason: "manifest_conflict",
    });
    expect(manifest()).toBeNull();
    expect(await snapshots.listVersions()).toEqual([]);
  });

  it("manifest를 바꾼 뒤 게시 버전 기록이 예외를 던져도 게시 성공으로 보고하고 오류 로그만 남김", async () => {
    const { ops, deps, manifest, events } = await setup();
    ops.setPublishedVersion = async () => {
      throw new Error("throttled");
    };
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
      version: V1,
    });
    expect(manifest()!.snapshotVersion).toBe(V1);
    expect(events()).toContainEqual(
      expect.objectContaining({
        level: "error",
        event: "publish_version_not_recorded",
        version: V1,
      }),
    );
  });

  it("State 읽기가 예외를 던져도 manifest 그대로, 잠금은 풂", async () => {
    const { state, ops, snapshots, deps } = await setup();
    state.getState = async () => {
      throw new Error("down");
    };
    expect((await publishSnapshot(deps())).status).toBe("failed");
    expect(snapshots.files.size).toBe(0);
    expect(await ops.acquireLock(PUBLISH_POLICY.lockName, "x", NOW_MS, 1)).toBe(
      true,
    );
  });

  it("최근 48개 버전만 남기고 오래된 버전 경로를 지움", async () => {
    const { snapshots, deps } = await setup();
    const old = Array.from({ length: 50 }, (_, i) =>
      snapshotVersion(NOW_MS - (50 - i) * 60_000),
    );
    for (const v of old) {
      await snapshots.putFile(`data/${v}/status.json`, "{}", "x");
    }
    const result = await publishSnapshot(deps());
    expect(result).toMatchObject({
      status: "published",
      removed: old.slice(0, 3),
    });
    const versions = await snapshots.listVersions();
    expect(versions).toHaveLength(48);
    expect(versions.at(-1)).toBe(V1);
  });
});

describe("rollbackManifest (T06)", () => {
  it("이전 버전으로 manifest를 되돌림 — 파일 경로는 사본 그대로, 점검·최소 화면 버전은 지금 설정", async () => {
    const { state, snapshots, deps, advance, manifest } = await setup();
    await publishSnapshot(deps());
    const copyPath = `data/${V1}/manifest.json`;
    // 사본에 지금과 다른 운영 설정이 남아 있던 경우(그때 점검 중이었거나 minWebBuild가 달랐음)
    const copy = snapshots.files.get(copyPath)!;
    const v1Manifest = JSON.parse(copy.body) as ManifestFile;
    snapshots.files.set(copyPath, {
      ...copy,
      body: JSON.stringify({
        ...v1Manifest,
        maintenance: {
          ...MANIFEST_SETTINGS.maintenance,
          active: !MANIFEST_SETTINGS.maintenance.active,
        },
        minWebBuild: MANIFEST_SETTINGS.minWebBuild + 1,
      }),
    });
    advance(60_000);
    await seedWarnings(state, [WIND_WAVE_ROW], {
      confirmedAt: "2026-10-23T02:25:00Z",
    });
    await publishSnapshot(deps());

    expect(await rollbackManifest(snapshots, V1)).toEqual({
      status: "rolled_back",
    });
    expect(snapshots.files.get(MANIFEST_PATH)!.cacheControl).toBe(
      "public, max-age=60",
    );
    expect(manifest()).toEqual({
      ...v1Manifest,
      maintenance: MANIFEST_SETTINGS.maintenance,
      minWebBuild: MANIFEST_SETTINGS.minWebBuild,
    });
  });

  it("없는 버전이나 파일이 빠진 버전으로는 되돌리지 않음(manifest 그대로)", async () => {
    const { snapshots, deps } = await setup();
    await publishSnapshot(deps());
    const before = snapshots.files.get(MANIFEST_PATH);

    expect(await rollbackManifest(snapshots, "20261001T000000Z")).toEqual({
      status: "failed",
      reason: "manifest_missing",
    });
    snapshots.files.delete(`data/${V1}/history.json`);
    expect(await rollbackManifest(snapshots, V1)).toEqual({
      status: "failed",
      reason: "files_missing",
    });
    expect(snapshots.files.get(MANIFEST_PATH)).toBe(before);
  });
});
