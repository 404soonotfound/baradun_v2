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
  WEATHER_AREAS,
  WIND_WAVE_ROW,
  ZONES,
  seedReadings,
  seedWarnings,
} from "./fixtures";
import { MANIFEST_SETTINGS, PUBLISH_POLICY } from "./policy";
import { snapshotVersion } from "../core/snapshots/version";
import { MANIFEST_PATH, publishSnapshot } from "./publish";

// publish-snapshot (BRD-61). T01 게시 원자성: 실패하면 manifest 그대로, T06 manifest 교체
// 버전 경로 파일 → manifest 순서, Cache-Control, 게시 잠금, 48개 보존

const NOW_MS = Date.parse(NOW);
const V1 = snapshotVersion(NOW_MS); // 20261023T023000Z

async function setup(
  options: {
    failOn?: (path: string) => boolean;
    beforeConditionalPut?: (path: string) => Promise<void> | void;
    seed?: boolean;
    notices?: () => Promise<readonly unknown[]>;
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
    // 저장소 원본 해변 ID 목록(해변 파일과 따로 들어오는 목록, D16-C1)
    beachIds: BEACHES.map((beach) => beach.id),
    zones: ZONES,
    seasons: SEASONS,
    weatherAreas: WEATHER_AREAS,
    notices: options.notices ?? (async () => []),
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
        "weather.json",
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
  // 이전 값은 지금 설정의 반대로 둠 → README 절차대로 설정을 바꿔도 이 테스트가 깨지지 않음
  it.each([
    [
      "점검",
      {
        maintenance: {
          ...MANIFEST_SETTINGS.maintenance,
          active: !MANIFEST_SETTINGS.maintenance.active,
        },
      },
    ],
    ["최소 화면 버전", { minWebBuild: MANIFEST_SETTINGS.minWebBuild + 1 }],
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

describe("공지 싣기 (BRD-151, D16-B3·D4, 아키텍처 18.4)", () => {
  const notice = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    kind: "general",
    title: { ko: "공지", en: "Notice" },
    body: { ko: "본문", en: "Body" },
    startsAt: "2026-10-23T02:00:00Z",
    endsAt: null,
    ...overrides,
  });

  it("시작한 공지만 ID 순으로 싣고, 예약 전·끝난 공지는 넣지 않는다", async () => {
    const { deps, manifest } = await setup({
      notices: async () => [
        notice("n-b"),
        notice("n-a", {
          kind: "maintenance_notice",
          endsAt: "2026-10-23T03:00:00Z",
        }),
        notice("n-later", { startsAt: "2026-10-23T03:00:00Z" }),
        notice("n-ended", { endsAt: "2026-10-23T02:30:00Z" }),
      ],
    });
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
    });
    expect(manifest()!.notices!.map((n) => n.id)).toEqual(["n-a", "n-b"]);
    expect(JSON.stringify(manifest())).not.toContain("n-later");
  });

  it("공지가 없으면 notices 칸을 두지 않는다", async () => {
    const { deps, manifest } = await setup();
    await publishSnapshot(deps());
    expect(manifest()).not.toHaveProperty("notices");
  });

  it("계약에 맞지 않거나 끝이 시작보다 이른 공지는 그것만 빼고 게시를 이어 간다", async () => {
    const { deps, manifest, events } = await setup({
      notices: async () => [
        notice("n-ok"),
        notice("n-no-en", { title: { ko: "공지" } }),
        notice("n-kst", { startsAt: "2026-10-23T11:00:00+09:00" }),
        notice("n-order", { endsAt: "2026-10-23T01:00:00Z" }),
      ],
    });
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
    });
    expect(manifest()!.notices!.map((n) => n.id)).toEqual(["n-ok"]);
    expect(
      events()
        .filter((e) => e.event === "publish_notice_invalid")
        .map((e) => e.noticeId),
    ).toEqual(["n-no-en", "n-kst", "n-order"]);
  });

  it("차단 표현이 든 노출본은 그것만 빼고 알린다(D16-D1·D17-8)", async () => {
    const { deps, manifest, events } = await setup({
      notices: async () => [
        notice("n-ok", {
          body: { ko: "안전요원 안내를 따라 주세요", en: "Body" },
        }),
        notice("n-safe", { body: { ko: "오늘은 안전해요", en: "Body" } }),
        notice("n-top", { title: { ko: "공지", en: "Top 3 beaches" } }),
      ],
    });
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
    });
    expect(manifest()!.notices!.map((n) => n.id)).toEqual(["n-ok"]);
    expect(
      events()
        .filter((e) => e.event === "publish_notice_blocked_phrase")
        .map((e) => e.noticeId),
    ).toEqual(["n-safe", "n-top"]);
  });

  it("데이터가 같아도 공지가 바뀌면 새 버전으로 게시하고, 같으면 생략한다", async () => {
    let candidates: unknown[] = [];
    const { deps, advance, manifest } = await setup({
      notices: async () => candidates,
    });
    await publishSnapshot(deps());
    candidates = [notice("n-1")];
    const v2 = advance(60_000);
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
      version: v2,
    });
    expect(manifest()!.notices).toEqual([notice("n-1")]);
    advance(60_000);
    expect(await publishSnapshot(deps())).toEqual({
      status: "unchanged",
      version: v2,
    });
    // 노출을 끝내면(다음 게시에서 빠짐) 다시 게시
    candidates = [];
    const v4 = advance(60_000);
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
      version: v4,
    });
    expect(manifest()).not.toHaveProperty("notices");
  });

  it("운영 DB를 읽지 못하면 지금 manifest의 공지를 이어서 싣고 특보·관측 게시는 멈추지 않는다", async () => {
    let failing = false;
    const { state, deps, advance, manifest, events } = await setup({
      notices: async () => {
        if (failing) throw new Error("AccessDenied");
        return [
          notice("n-keep"),
          notice("n-ending", { endsAt: "2026-10-23T02:31:00Z" }),
        ];
      },
    });
    await publishSnapshot(deps());
    failing = true;
    const v2 = advance(60_000);
    await seedWarnings(state, [WIND_WAVE_ROW], {
      confirmedAt: "2026-10-23T02:25:00Z",
    });
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
      version: v2,
    });
    // 끝난 공지는 이어 싣지 않음
    expect(manifest()!.notices!.map((n) => n.id)).toEqual(["n-keep"]);
    expect(events().some((e) => e.event === "publish_notices_unread")).toBe(
      true,
    );
  });

  it("운영 DB가 칸 순서를 다르게 돌려줘도 같은 공지면 게시를 생략한다", async () => {
    let candidates: unknown[] = [notice("n-1")];
    const { deps, advance } = await setup({
      notices: async () => candidates,
    });
    await publishSnapshot(deps());
    const { endsAt, startsAt, body, title, kind, id } = notice("n-1");
    candidates = [
      {
        endsAt,
        startsAt,
        body: { en: body.en, ko: body.ko },
        title: { en: title.en, ko: title.ko },
        kind,
        id,
      },
    ];
    advance(60_000);
    expect(await publishSnapshot(deps())).toEqual({
      status: "unchanged",
      version: V1,
    });
  });

  it("공지는 maintenance를 바꾸지 않는다(D16-B3)", async () => {
    const { deps, manifest } = await setup({
      notices: async () => [notice("n-m", { kind: "maintenance_notice" })],
    });
    await publishSnapshot(deps());
    expect(manifest()!.maintenance).toEqual(MANIFEST_SETTINGS.maintenance);
  });

  it("공지는 해변 판단 상태·사유(배지)를 바꾸지 않는다(D15-6)", async () => {
    const judged = async (notices: readonly unknown[]) => {
      const { snapshots, deps, manifest } = await setup({
        notices: async () => notices,
      });
      await publishSnapshot(deps());
      const read = (path: string) => snapshots.files.get(path.slice(1))!.body;
      return {
        status: read(manifest()!.files.status),
        beaches: read(manifest()!.files.beaches),
        notices: manifest()!.notices?.length ?? 0,
      };
    };
    const without = await judged([]);
    const withNotices = await judged([
      notice("n-m", { kind: "maintenance_notice" }),
      notice("n-g"),
    ]);
    expect(withNotices.notices).toBe(2);
    expect(withNotices.status).toBe(without.status);
    expect(withNotices.beaches).toBe(without.beaches);
  });
});

describe("weather.json (BRD-181)", () => {
  it("날씨를 받지 못했어도 모든 칸이 null인 weather.json을 게시하고 manifest에 싣는다", async () => {
    const { snapshots, deps, manifest } = await setup();
    await publishSnapshot(deps());
    const path = manifest()!.files.weather!;
    expect(path).toBe(`/data/${V1}/weather.json`);
    const weather = JSON.parse(snapshots.files.get(path.slice(1))!.body);
    expect(weather.beaches.b0001).toEqual(WEATHER_AREAS.beaches.b0001);
    // b0003은 숨긴 해변 → 날씨에도 없음
    expect(weather.beaches.b0003).toBeUndefined();
    const grid = weather.grids[WEATHER_AREAS.beaches.b0001!.grid];
    expect(grid.short).toBeNull();
    expect(grid.now).toBeNull();
    expect(grid.today).toMatchObject({ min: null, max: null });
  });

  it("날씨가 계약을 통과하지 못하면 날씨만 빼고 판단 파일은 게시한다(G1)", async () => {
    const { snapshots, deps, manifest, events } = await setup();
    const result = await publishSnapshot({
      ...deps(),
      weatherAreas: {
        beaches: {
          b0001: { grid: "bad", midLand: "11D20000", midTa: "11D20501" },
        },
        landNames: { "11D20000": "강원영동" },
        taNames: { "11D20501": "강릉" },
      },
    });
    expect(result).toMatchObject({ status: "published", version: V1 });
    expect(manifest()!.files.weather).toBeUndefined();
    expect(snapshots.files.has(`data/${V1}/weather.json`)).toBe(false);
    expect(snapshots.files.has(`data/${V1}/status.json`)).toBe(true);
    expect(events().some((e) => e.event === "publish_weather_contract")).toBe(
      true,
    );
  });

  it("날씨 파일 유무가 바뀌면 판단 파일이 같아도 새로 게시한다", async () => {
    const { deps, advance, manifest } = await setup();
    await publishSnapshot({
      ...deps(),
      weatherAreas: { beaches: {}, landNames: {}, taNames: {} },
    });
    expect(manifest()!.files.weather).toBeDefined();
    const v2 = advance(60_000);
    await publishSnapshot({
      ...deps(),
      weatherAreas: {
        beaches: { b0001: { grid: "bad", midLand: "11D20000", midTa: "x" } },
        landNames: { "11D20000": "강원영동" },
        taNames: { x: "강릉" },
      },
    });
    expect(manifest()).toMatchObject({ snapshotVersion: v2 });
    expect(manifest()!.files.weather).toBeUndefined();
  });
});

describe("publishSnapshot 게시 요약", () => {
  it("게시하면 해변 수·관측 지연 해변·관측소별 사용 해변을 남기고, 다음 게시는 앞 버전을 previous로 둔다", async () => {
    const { ops, snapshots, deps, advance } = await setup();
    await publishSnapshot(deps());
    const first = ops.summaries.get(V1)!;
    const status = JSON.parse(
      snapshots.files.get(`data/${V1}/status.json`)!.body,
    ) as { beaches: Record<string, { reasons: { code: string }[] }> };
    expect(first).toMatchObject({
      version: V1,
      previous: null,
      publishedAt: NOW,
      beachCount: BEACHES.length,
      delayedBeachIds: Object.entries(status.beaches)
        .filter(([, s]) =>
          s.reasons.some((r) => r.code === "observation_delayed"),
        )
        .map(([id]) => id)
        .sort(),
    });
    // 버전별 요약에는 관측소 표를 싣지 않음(Ops 고정 용량). 표는 한 곳에 따로
    expect(first).not.toHaveProperty("stations");
    const wave = BEACHES[0]!.stations.waveHeight!;
    expect(ops.stationTable?.table[wave.id]).toMatchObject({
      name: wave.name.ko,
      waveBeachIds: expect.arrayContaining([BEACHES[0]!.id]),
    });

    // 파고 90분이 지나 분류가 바뀌는 시각으로 다시 게시 → 새 버전, previous는 앞 버전
    const v2 = advance(2 * 60 * 60 * 1000);
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
      version: v2,
    });
    expect(ops.summaries.get(v2)).toMatchObject({ previous: V1 });
    expect(ops.summaries.get(v2)!.delayedBeachIds.length).toBeGreaterThan(0);
    // 해변 파일이 같으면 관측소 표는 다시 쓰지 않음
    expect(ops.stationTableWrites).toBe(1);
  });

  it("요약을 남기지 못해도 게시는 끝난 것으로 두고 경고만 남긴다", async () => {
    const { ops, deps, events } = await setup();
    ops.putPublishSummary = async () => {
      throw new Error("ProvisionedThroughputExceededException");
    };
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
      version: V1,
    });
    expect(await ops.getPublishedVersion()).toBe(V1);
    expect(events()).toContainEqual(
      expect.objectContaining({
        event: "publish_summary_not_recorded",
        version: V1,
      }),
    );
  });
});
