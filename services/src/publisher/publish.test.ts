import type { Beach, ManifestFile, StatusFile } from "@baradun/contracts";
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
import { MANIFEST_PATH, beachIdProblem, publishSnapshot } from "./publish";

// publish-snapshot (BRD-61). T01 게시 원자성: 실패하면 manifest 그대로, T06 manifest 교체
// 버전 경로 파일 → manifest 순서, Cache-Control, 게시 잠금, 48개 보존
// 되돌리기(D20-1~3)·해변 ID 대조(D16-C1)·게시 실행 결과(D16-C2)는 아래 따로

const NOW_MS = Date.parse(NOW);
const V1 = snapshotVersion(NOW_MS); // 20261023T023000Z
// 게시 시각 글자(UTC ISO, 초 단위). publisher가 남기는 시각과 같은 모양
const formatAt = (ms: number) =>
  new Date(ms).toISOString().replace(".000Z", "Z");

async function setup(
  options: {
    failOn?: (path: string) => boolean;
    beforeConditionalPut?: (path: string) => Promise<void> | void;
    seed?: boolean;
    notices?: () => Promise<readonly unknown[]>;
    beaches?: readonly Beach[];
    beachIds?: readonly string[];
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
    beaches: options.beaches ?? BEACHES,
    // 저장소 원본 해변 ID 목록(해변 파일과 따로 들어오는 목록, D16-C1)
    beachIds: options.beachIds ?? BEACHES.map((beach) => beach.id),
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

// 되돌리기 (결정 기록 D20-1~3, D16-C3, #256·#331)
// 옛 manifest를 되살리지 않고, 같은 게시 잠금으로 지금보다 큰 새 버전을 게시함
// 공지만 고른 게시본 때 상태로 되살리고 특보·관측은 지금 수집 사실을 씀
describe("되돌리기 (D20-1~3)", () => {
  const notice = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    kind: "general",
    title: { ko: "공지", en: "Notice" },
    body: { ko: "본문", en: "Body" },
    startsAt: "2026-10-23T02:00:00Z",
    endsAt: null,
    ...overrides,
  });
  const CHANGED = { title: { ko: "바뀐 공지", en: "Changed" } };

  // V1: n-a(처음 문구) → V2: n-a 문구를 바꾸고 n-new를 더함
  async function twoPublishes(extra: Parameters<typeof setup>[0] = {}) {
    const box = { candidates: [notice("n-a")] as unknown[] };
    const ctx = await setup({ notices: async () => box.candidates, ...extra });
    await publishSnapshot(ctx.deps());
    box.candidates = [notice("n-a", CHANGED), notice("n-new")];
    const v2 = ctx.advance(60_000);
    expect(await publishSnapshot(ctx.deps())).toMatchObject({
      status: "published",
      version: v2,
    });
    return { ...ctx, box, v2 };
  }
  const status = (
    snapshots: Awaited<ReturnType<typeof setup>>["snapshots"],
    version: string,
  ) =>
    JSON.parse(
      snapshots.files.get(`data/${version}/status.json`)!.body,
    ) as StatusFile;

  it("지금보다 큰 새 버전으로 게시하고, 옛 manifest를 되살리지 않는다(D20-1)", async () => {
    const { ops, snapshots, deps, advance, manifest, v2 } =
      await twoPublishes();
    const v3 = advance(60_000);
    expect(await publishSnapshot(deps(), { rollbackTo: V1 })).toEqual({
      status: "published",
      version: v3,
      removed: [],
    });
    expect(v3 > v2 && v2 > V1).toBe(true);
    // 열린 웹은 받은 것보다 작은 버전을 무시하므로 manifest는 새 버전을 가리켜야 함
    expect(manifest()).toMatchObject({
      snapshotVersion: v3,
      files: { status: `/data/${v3}/status.json` },
    });
    expect(await ops.getPublishedVersion()).toBe(v3);
    // 고른 게시본의 파일은 건드리지 않음(그대로 남음)
    expect(await snapshots.listVersions()).toEqual([V1, v2, v3]);
    expect(ops.summaries.get(v3)).toMatchObject({
      source: "rollback",
      target: V1,
      previous: v2,
    });
    // 잠금을 풀어 다음 게시가 바로 맡을 수 있음
    expect(
      await ops.acquireLock(PUBLISH_POLICY.lockName, "next", NOW_MS, 1),
    ).toBe(true);
  });

  it("고른 게시본 때의 공지를 되살리고, 그 뒤에 바뀐 공지는 '되돌림'으로 표시한다(D20-2)", async () => {
    const { ops, deps, advance, manifest } = await twoPublishes();
    expect(manifest()!.notices!.map((n) => n.id)).toEqual(["n-a", "n-new"]);
    advance(60_000);
    await publishSnapshot(deps(), { rollbackTo: V1 });
    // n-a는 그때 문구로, 그 뒤에 생긴 n-new는 빠짐
    expect(manifest()!.notices).toEqual([notice("n-a")]);
    const at = formatAt(NOW_MS + 120_000);
    expect(ops.noticeHold!.notices).toEqual({
      "n-a": { target: V1, at, live: notice("n-a") },
      "n-new": { target: V1, at, live: null },
    });
  });

  it("되돌린 공지는 다음 자동 게시에 실리지 않고, 다시 적용하면 실린다(D16-C3)", async () => {
    const { state, ops, deps, advance, manifest } = await twoPublishes();
    const v3 = advance(60_000);
    await publishSnapshot(deps(), { rollbackTo: V1 });

    // 바뀐 것이 없으면 생략(되돌린 공지를 다시 싣느라 새로 게시하지 않음)
    advance(60_000);
    expect(await publishSnapshot(deps())).toEqual({
      status: "unchanged",
      version: v3,
    });
    // 데이터가 바뀌어 새로 게시해도 공지는 되돌린 그대로
    await seedWarnings(state, [WIND_WAVE_ROW], {
      confirmedAt: "2026-10-23T02:33:00Z",
    });
    advance(60_000);
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
    });
    expect(manifest()!.notices).toEqual([notice("n-a")]);

    // n-new만 다시 적용: 포인터에서 그 공지를 지움 → 다음 자동 게시부터 실림. n-a는 아직 그때 문구
    const hold = ops.noticeHold!;
    await ops.putNoticeHold(
      { "n-a": hold.notices["n-a"]! },
      hold.version,
      "2026-10-23T02:35:00Z",
    );
    advance(60_000);
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
    });
    expect(manifest()!.notices).toEqual([notice("n-a"), notice("n-new")]);

    // n-a도 다시 적용 → 운영 DB의 지금 노출본(바뀐 문구)이 실림
    await ops.putNoticeHold(
      {},
      ops.noticeHold!.version,
      "2026-10-23T02:36:00Z",
    );
    advance(60_000);
    await publishSnapshot(deps());
    expect(manifest()!.notices).toEqual([
      notice("n-a", CHANGED),
      notice("n-new"),
    ]);
  });

  it("특보·관측은 지금 수집 사실을 쓴다: 발효 특보가 되돌리기로 사라지지 않고 관측·확인 시각을 고치지 않는다(D20-3)", async () => {
    const box = { candidates: [notice("n-a")] as unknown[] };
    const { state, snapshots, deps, advance } = await setup({
      notices: async () => box.candidates,
    });
    await publishSnapshot(deps());
    expect(status(snapshots, V1).beaches.b0001!.category).toBe("clear");

    // 그 뒤 공지 문구가 바뀌고, 풍랑주의보가 발효되고 새 관측이 들어옴
    box.candidates = [notice("n-a", CHANGED)];
    const confirmedAt = "2026-10-23T02:31:00Z";
    const observedAt = "2026-10-23T02:30:30Z";
    await seedWarnings(state, [WIND_WAVE_ROW], { confirmedAt });
    await seedReadings(state, 1.2, observedAt);
    const v2 = advance(120_000);
    await publishSnapshot(deps());
    expect(status(snapshots, v2).beaches.b0001!.category).toBe("unavailable");

    const v3 = advance(60_000);
    expect(await publishSnapshot(deps(), { rollbackTo: V1 })).toMatchObject({
      status: "published",
      version: v3,
    });
    const rolled = status(snapshots, v3).beaches.b0001!;
    // 고른 게시본(V1)의 '특보 없음'으로 돌아가지 않음
    expect(rolled.category).toBe("unavailable");
    expect(rolled.reasons.map((r) => r.code)).toEqual(
      status(snapshots, v2).beaches.b0001!.reasons.map((r) => r.code),
    );
    // 시각은 수집한 그대로(되돌린 시각이나 V1 때 시각으로 고치지 않음)
    expect(rolled.warning.lastConfirmedAt).toBe(confirmedAt);
    expect(rolled.observation.metrics.waveHeight).toMatchObject({
      value: 1.2,
      observedAt,
    });
    expect(JSON.stringify(status(snapshots, v3))).not.toContain(
      formatAt(NOW_MS + 180_000),
    );
  });

  it("자동 게시와 되돌리기가 겹치면 한쪽만 게시하고 manifest가 거꾸로 가지 않는다", async () => {
    const { ops, snapshots, deps, advance, manifest, v2 } =
      await twoPublishes();
    const v3 = advance(60_000);
    const results = await Promise.all([
      publishSnapshot(deps("auto")),
      publishSnapshot(deps("rollback"), { rollbackTo: V1 }),
    ]);
    // 같은 잠금 → 먼저 잡은 쪽만 돌고 다른 쪽은 물러남
    expect(results.map((r) => r.status).sort()).toEqual(["busy", "unchanged"]);
    expect(manifest()!.snapshotVersion).toBe(v2);

    // 순서가 반대여도 같음: 되돌리기가 잠금을 잡으면 자동 게시가 물러나고, manifest는 더 큰 버전으로만 감
    const reversed = await Promise.all([
      publishSnapshot(deps("rollback"), { rollbackTo: V1 }),
      publishSnapshot(deps("auto")),
    ]);
    expect(reversed.map((r) => r.status)).toEqual(["published", "busy"]);
    expect(manifest()!.snapshotVersion).toBe(v3);
    expect(await ops.getPublishedVersion()).toBe(v3);
    expect(await snapshots.listVersions()).toEqual([V1, v2, v3]);
  });

  it("잠금 시간을 넘긴 되돌리기보다 새 게시가 먼저 끝나면 manifest를 옛 버전으로 덮지 않고 포인터도 되돌려 놓는다", async () => {
    // 되돌리기 A가 잠금 시간을 넘겨 늦어진 사이, 자동 게시 B가 잠금을 새로 맡아 더 새 버전을 게시함
    // A는 manifest를 확인한 뒤 쓰기 직전에 B가 끼어듦 → 조건부 쓰기가 거절되고, 다시 읽어 더 새 버전을 보고 멈춤
    let interleaved = false;
    let newer = "";
    const ctx: { run?: () => Promise<void> } = {};
    const { state, ops, snapshots, deps, advance, manifest, v2 } =
      await twoPublishes({
        beforeConditionalPut: async () => {
          // 앞의 두 게시에서는 끼어들지 않음(ctx.run을 정한 뒤 한 번만)
          if (interleaved || !ctx.run) return;
          interleaved = true;
          await ctx.run();
        },
      });
    const v3 = advance(60_000);
    ctx.run = async () => {
      newer = advance(PUBLISH_POLICY.lockTtlMs + 1_000);
      await seedWarnings(state, [WIND_WAVE_ROW], {
        confirmedAt: "2026-10-23T02:33:00Z",
      });
      expect(await publishSnapshot(deps("b"))).toMatchObject({
        status: "published",
        version: newer,
      });
    };
    expect(await publishSnapshot(deps("a"), { rollbackTo: V1 })).toEqual({
      status: "failed",
      version: v3,
      reason: "version_not_newer",
    });
    expect(manifest()!.snapshotVersion).toBe(newer);
    expect(await snapshots.listVersions()).toEqual([V1, v2, newer]);
    // 게시되지 않은 되돌리기의 표시를 남기지 않음
    expect(ops.noticeHold!.notices).toEqual({});
  });

  it("점검·최소 화면 버전은 되돌리기로 풀리거나 내려가지 않는다(지금 설정 그대로)", async () => {
    const { snapshots, deps, advance, manifest } = await twoPublishes();
    // 고른 게시본의 manifest 사본에 지금과 다른 설정이 남아 있어도 쓰지 않음
    const copyPath = `data/${V1}/manifest.json`;
    const copy = snapshots.files.get(copyPath)!;
    await snapshots.putFile(
      copyPath,
      JSON.stringify({
        ...(JSON.parse(copy.body) as ManifestFile),
        maintenance: {
          active: !MANIFEST_SETTINGS.maintenance.active,
          until: null,
        },
        minWebBuild: MANIFEST_SETTINGS.minWebBuild - 1,
      }),
      copy.cacheControl,
    );
    advance(60_000);
    await publishSnapshot(deps(), { rollbackTo: V1 });
    expect(manifest()).toMatchObject({
      maintenance: MANIFEST_SETTINGS.maintenance,
      minWebBuild: MANIFEST_SETTINGS.minWebBuild,
      policyVersion: PUBLISH_POLICY.policyVersion,
    });
  });

  it("예약 전 공지도 그때 상태로 남겨 두지만 공개 게시본에는 넣지 않는다", async () => {
    const later = notice("n-later", { startsAt: "2026-10-23T03:00:00Z" });
    const box = { candidates: [notice("n-a"), later] as unknown[] };
    const { ops, snapshots, deps, advance, manifest } = await setup({
      notices: async () => box.candidates,
    });
    await publishSnapshot(deps());
    expect(ops.publishNotices.get(V1)).toEqual([notice("n-a"), later]);
    // 요약에는 공지를 싣지 않음(운영 API가 기간 조회로 읽는 항목을 작게 유지)
    expect(ops.summaries.get(V1)).not.toHaveProperty("notices");
    expect(JSON.stringify(manifest())).not.toContain("n-later");

    // 그 뒤 예약 공지의 시각을 바꿈 → 되돌리면 그때 예약(03:00)으로 되살아나고, 시작 전이라 싣지 않음
    box.candidates = [
      notice("n-a"),
      notice("n-later", { startsAt: "2026-10-23T02:31:00Z" }),
    ];
    advance(120_000);
    await publishSnapshot(deps());
    expect(manifest()!.notices!.map((n) => n.id)).toEqual(["n-a", "n-later"]);
    const v3 = advance(60_000);
    await publishSnapshot(deps(), { rollbackTo: V1 });
    expect(manifest()!.notices).toEqual([notice("n-a")]);
    expect(ops.noticeHold!.notices["n-later"]!.live).toEqual(later);
    for (const [path, file] of snapshots.files) {
      if (path.startsWith(`data/${v3}/`)) {
        expect(file.body, path).not.toContain("n-later");
      }
    }
  });

  it("고른 게시본의 공지 상태를 모르면 되돌리지 않는다(manifest·포인터 그대로)", async () => {
    const { ops, snapshots, deps, advance, manifest, events, v2 } =
      await twoPublishes();
    const before = snapshots.files.get(MANIFEST_PATH)!.body;
    // 기록이 없는 버전(이 기능 전 게시·기록 쓰기 실패)
    advance(60_000);
    expect(
      await publishSnapshot(deps(), { rollbackTo: "20261001T000000Z" }),
    ).toMatchObject({ status: "failed", reason: "rollback_target_missing" });
    // 요약은 있지만 공지 상태 기록이 없는 버전(그때 운영 DB를 읽지 못함)
    ops.publishNotices.delete(V1);
    advance(60_000);
    expect(await publishSnapshot(deps(), { rollbackTo: V1 })).toMatchObject({
      status: "failed",
      reason: "rollback_target_missing",
    });
    expect(snapshots.files.get(MANIFEST_PATH)!.body).toBe(before);
    expect(manifest()!.snapshotVersion).toBe(v2);
    expect(ops.noticeHold).toBeNull();
    expect(await snapshots.listVersions()).toEqual([V1, v2]);
    expect(events().at(-1)).toMatchObject({
      event: "publish_failed",
      reason: "rollback_target_missing",
      target: V1,
    });
  });

  it("남겨 둔 공지 상태가 계약에 맞지 않으면 일부만 되살리지 않고 멈춘다", async () => {
    const { ops, deps, advance, manifest, v2 } = await twoPublishes();
    ops.publishNotices.set(V1, [
      ...ops.publishNotices.get(V1)!,
      { ...notice("n-bad"), kind: "unknown" },
    ]);
    advance(60_000);
    expect(await publishSnapshot(deps(), { rollbackTo: V1 })).toMatchObject({
      status: "failed",
      reason: "rollback_target_invalid",
    });
    expect(manifest()!.snapshotVersion).toBe(v2);
    expect(ops.noticeHold).toBeNull();
  });

  it("운영 DB를 읽지 못하면 되돌리지 않는다(지금 공지를 추정하지 않음)", async () => {
    const { ops, box, deps, advance, manifest, v2 } = await twoPublishes();
    Object.defineProperty(box, "candidates", {
      get() {
        throw new Error("AccessDenied");
      },
    });
    advance(60_000);
    expect(await publishSnapshot(deps(), { rollbackTo: V1 })).toMatchObject({
      status: "failed",
      reason: "exception:Error",
    });
    expect(manifest()!.snapshotVersion).toBe(v2);
    expect(ops.noticeHold).toBeNull();
  });

  it("manifest 교체에 실패하면 포인터를 앞 값으로 되돌려 놓는다(다음 자동 게시가 공지를 되돌리지 않음)", async () => {
    let failing = false;
    const { ops, snapshots, deps, advance, manifest, v2 } = await twoPublishes({
      failOn: (path) => failing && path === MANIFEST_PATH,
    });
    failing = true;
    const v3 = advance(60_000);
    expect(await publishSnapshot(deps(), { rollbackTo: V1 })).toMatchObject({
      status: "failed",
      version: v3,
    });
    expect(manifest()!.snapshotVersion).toBe(v2);
    expect(await snapshots.listVersions()).toEqual([V1, v2]);
    expect(ops.noticeHold!.notices).toEqual({});

    failing = false;
    advance(60_000);
    expect(await publishSnapshot(deps())).toEqual({
      status: "unchanged",
      version: v2,
    });
    expect(manifest()!.notices!.map((n) => n.id)).toEqual(["n-a", "n-new"]);
  });

  // DynamoDB는 맵의 칸 순서를 지키지 않음. 읽어 온 포인터의 칸 순서를 뒤집어 그 상황을 만듦
  const reordered = <T>(value: T): T =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, inner]) => [key, reordered(inner)]),
        ) as T)
      : value;
  const readsReordered = (ops: Awaited<ReturnType<typeof setup>>["ops"]) => {
    const get = ops.getNoticeHold.bind(ops);
    ops.getNoticeHold = async () => reordered(await get());
  };

  it("저장소가 포인터의 칸 순서를 바꿔 돌려줘도 같은 되돌리기는 변경 없음으로 끝낸다", async () => {
    const { ops, snapshots, deps, advance, v2 } = await twoPublishes();
    const v3 = advance(60_000);
    await publishSnapshot(deps(), { rollbackTo: V1 });
    readsReordered(ops);
    expect(JSON.stringify(await ops.getNoticeHold())).not.toBe(
      JSON.stringify(ops.noticeHold),
    );
    advance(60_000);
    expect(await publishSnapshot(deps(), { rollbackTo: V1 })).toEqual({
      status: "unchanged",
      version: v3,
    });
    expect(await snapshots.listVersions()).toEqual([V1, v2, v3]);
  });

  it("같은 되돌리기를 다시 부르면 새 버전을 만들지 않고 변경 없음으로 끝낸다", async () => {
    const { ops, snapshots, deps, advance, manifest, v2 } =
      await twoPublishes();
    const v3 = advance(60_000);
    await publishSnapshot(deps(), { rollbackTo: V1 });
    const hold = structuredClone(ops.noticeHold);

    advance(60_000);
    expect(await publishSnapshot(deps(), { rollbackTo: V1 })).toEqual({
      status: "unchanged",
      version: v3,
    });
    expect(manifest()!.snapshotVersion).toBe(v3);
    expect(await snapshots.listVersions()).toEqual([V1, v2, v3]);
    // 포인터도 다시 쓰지 않음(되돌린 시각·version 그대로)
    expect(ops.noticeHold).toEqual(hold);
    expect(ops.lastRun).toMatchObject({
      source: "rollback",
      result: "unchanged",
    });
  });

  it("포인터 쓰기가 실제로는 됐는데 응답만 실패하면 다시 읽어 앞 값으로 되돌려 놓는다", async () => {
    const { ops, deps, advance, manifest, v2 } = await twoPublishes();
    // 다시 읽은 포인터의 칸 순서가 쓴 것과 달라도 이 실행이 쓴 값으로 알아봄
    readsReordered(ops);
    const put = ops.putNoticeHold.bind(ops);
    let calls = 0;
    ops.putNoticeHold = async (...args) => {
      calls += 1;
      const written = await put(...args);
      if (calls === 1) throw new Error("TimeoutError");
      return written;
    };
    advance(60_000);
    expect(await publishSnapshot(deps(), { rollbackTo: V1 })).toMatchObject({
      status: "failed",
      reason: "exception:Error",
    });
    expect(manifest()!.snapshotVersion).toBe(v2);
    // 게시되지 않았으므로 표시가 남지 않음(다음 자동 게시가 공지를 되돌리지 않음)
    expect(ops.noticeHold!.notices).toEqual({});
  });

  it("게시됐는지 알 수 없게 끝난 되돌리기는 포인터를 그대로 두고 확인이 필요하다고 알린다", async () => {
    const { ops, snapshots, deps, advance, events } = await twoPublishes();
    // 포인터를 쓴 뒤부터 manifest를 읽지 못함(교체도, 그 뒤 확인도 실패)
    let broken = false;
    const put = ops.putNoticeHold.bind(ops);
    ops.putNoticeHold = async (...args) => {
      const written = await put(...args);
      broken = true;
      return written;
    };
    const getTagged = snapshots.getTaggedFile.bind(snapshots);
    snapshots.getTaggedFile = async (path) => {
      if (broken) throw new Error("ServiceUnavailable");
      return getTagged(path);
    };
    const getFile = snapshots.getFile.bind(snapshots);
    snapshots.getFile = async (path) => {
      if (broken && path === MANIFEST_PATH) {
        throw new Error("ServiceUnavailable");
      }
      return getFile(path);
    };
    advance(60_000);
    expect(await publishSnapshot(deps(), { rollbackTo: V1 })).toMatchObject({
      status: "failed",
    });
    expect(Object.keys(ops.noticeHold!.notices)).toEqual(["n-a", "n-new"]);
    expect(events()).toContainEqual(
      expect.objectContaining({ event: "rollback_hold_unknown", target: V1 }),
    );
  });

  it("포인터를 앞 값으로 되돌려 놓지 못하면 오류로 알린다", async () => {
    let failing = false;
    const { ops, deps, advance, events } = await twoPublishes({
      failOn: (path) => failing && path === MANIFEST_PATH,
    });
    failing = true;
    const put = ops.putNoticeHold.bind(ops);
    let calls = 0;
    ops.putNoticeHold = async (...args) => {
      calls += 1;
      if (calls > 1) throw new Error("ProvisionedThroughputExceededException");
      return put(...args);
    };
    advance(60_000);
    expect(await publishSnapshot(deps(), { rollbackTo: V1 })).toMatchObject({
      status: "failed",
    });
    expect(events()).toContainEqual(
      expect.objectContaining({
        event: "rollback_hold_not_restored",
        target: V1,
      }),
    );
  });

  it("읽은 뒤 포인터가 바뀌었으면('다시 적용'과 겹침) 덮지 않고 멈춘다", async () => {
    const { ops, deps, advance, manifest, v2 } = await twoPublishes();
    const get = ops.getNoticeHold.bind(ops);
    ops.getNoticeHold = async () => {
      const hold = await get();
      // 되돌리기가 포인터를 읽은 직후 다른 쓰기가 끼어듦
      await ops.putNoticeHold({}, hold?.version ?? 0, "2026-10-23T02:32:00Z");
      return hold;
    };
    advance(60_000);
    expect(await publishSnapshot(deps(), { rollbackTo: V1 })).toMatchObject({
      status: "failed",
      reason: "hold_conflict",
    });
    expect(manifest()!.snapshotVersion).toBe(v2);
  });

  it("자동 게시가 포인터를 읽지 못하면 운영 DB 노출본을 그대로 싣지 않고 지금 manifest의 공지를 이어 쓴다", async () => {
    const { state, ops, deps, advance, manifest, events } =
      await twoPublishes();
    advance(60_000);
    await publishSnapshot(deps(), { rollbackTo: V1 });
    ops.getNoticeHold = async () => {
      throw new Error("AccessDenied");
    };
    await seedWarnings(state, [WIND_WAVE_ROW], {
      confirmedAt: "2026-10-23T02:33:00Z",
    });
    const v4 = advance(60_000);
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
      version: v4,
    });
    // 되돌린 공지(n-new·바뀐 n-a)가 다시 나가지 않음
    expect(manifest()!.notices).toEqual([notice("n-a")]);
    expect(events().some((e) => e.event === "publish_notices_unread")).toBe(
      true,
    );
    // 그때 공지 상태를 모르는 게시라 기록을 남기지 않음 → 이 버전으로는 되돌릴 수 없음
    expect(ops.publishNotices.has(v4)).toBe(false);
  });

  it("공지 상태를 남기지 못해도 게시는 끝난 것으로 두고 경고만 남긴다(그 버전은 되돌릴 수 없음)", async () => {
    const { ops, deps, advance, events } = await setup({
      notices: async () => [notice("n-a")],
    });
    ops.putPublishNotices = async () => {
      throw new Error("ProvisionedThroughputExceededException");
    };
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
      version: V1,
    });
    expect(events()).toContainEqual(
      expect.objectContaining({ event: "publish_notices_not_recorded" }),
    );
    advance(60_000);
    expect(await publishSnapshot(deps(), { rollbackTo: V1 })).toMatchObject({
      status: "failed",
      reason: "rollback_target_missing",
    });
  });

  it("앞 되돌리기의 표시는 새 되돌리기에서 다시 계산한다(뒤 게시본으로 되돌리면 표시가 풀림)", async () => {
    const { ops, deps, advance, manifest, v2 } = await twoPublishes();
    advance(60_000);
    await publishSnapshot(deps(), { rollbackTo: V1 });
    expect(Object.keys(ops.noticeHold!.notices)).toEqual(["n-a", "n-new"]);
    advance(60_000);
    await publishSnapshot(deps(), { rollbackTo: v2 });
    expect(ops.noticeHold!.notices).toEqual({});
    expect(manifest()!.notices).toEqual([
      notice("n-a", CHANGED),
      notice("n-new"),
    ]);
  });
});

// 해변 ID 집합 대조 (결정 기록 D16-C1). 저장소 원본 목록과 다르면 게시하지 않고 앞 게시본을 둠
describe("해변 ID 대조 (D16-C1)", () => {
  const IDS = BEACHES.map((beach) => beach.id);

  it("집합으로 견줘 누락·추가·중복을 가린다(수가 같아도 ID가 다르면 다름)", () => {
    expect(beachIdProblem(IDS, IDS)).toBeNull();
    expect(beachIdProblem(IDS, [...IDS].reverse())).toBeNull();
    expect(beachIdProblem(IDS, IDS.slice(1))).toEqual({
      missing: [IDS[0]],
      extra: [],
      duplicate: [],
    });
    expect(beachIdProblem(IDS, [...IDS.slice(1), "b9999"])).toEqual({
      missing: [IDS[0]],
      extra: ["b9999"],
      duplicate: [],
    });
    expect(beachIdProblem(IDS, [...IDS, IDS[0]!])).toEqual({
      missing: [],
      extra: [],
      duplicate: [IDS[0]],
    });
    // 원본 목록 안의 중복도 문제로 봄
    expect(beachIdProblem([...IDS, IDS[1]!], IDS)).toMatchObject({
      duplicate: [IDS[1]],
    });
  });

  it.each([
    ["해변 1개 누락", BEACHES.slice(1), { missing: [IDS[0]], extra: [] }],
    [
      "같은 수의 다른 ID",
      [...BEACHES.slice(1), { ...BEACHES[0]!, id: "b9999" }],
      { missing: [IDS[0]], extra: ["b9999"] },
    ],
    ["중복", [...BEACHES, BEACHES[0]!], { duplicate: [IDS[0]] }],
  ])(
    "%s이면 게시하지 않고 앞 게시본을 그대로 둔다",
    async (_name, beaches, problem) => {
      const first = await setup();
      await publishSnapshot(first.deps());
      const before = first.snapshots.files.get(MANIFEST_PATH)!.body;
      // 같은 저장소에서 해변 파일만 어긋난 채로 다시 게시
      const second = await setup({ beaches, seed: false });
      const deps = {
        ...second.deps(),
        state: first.state,
        ops: first.ops,
        snapshots: first.snapshots,
        clock: () => NOW_MS + 60_000,
      };
      expect(await publishSnapshot(deps)).toMatchObject({
        status: "failed",
        reason: "beach_ids",
      });
      expect(first.snapshots.files.get(MANIFEST_PATH)!.body).toBe(before);
      expect(await first.snapshots.listVersions()).toEqual([V1]);
      expect(await first.ops.getPublishedVersion()).toBe(V1);
      expect(second.events().at(-1)).toMatchObject({
        event: "publish_failed",
        reason: "beach_ids",
        where: "source",
        ...problem,
      });
    },
  );

  it("비율 기준이 없다: 해변이 많아도 하나만 빠지면 게시하지 않는다", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...BEACHES[i % BEACHES.length]!,
      id: `b${String(i + 1).padStart(4, "0")}`,
      slug: `beach-${i + 1}`,
    })) as Beach[];
    const { snapshots, deps } = await setup({
      beaches: many.slice(1),
      beachIds: many.map((beach) => beach.id),
    });
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "failed",
      reason: "beach_ids",
    });
    expect(snapshots.files.size).toBe(0);
  });

  it("관측을 받지 못해도 해변을 빼지 않는다(해변 수 그대로 게시, 분류만 판단불가)", async () => {
    const { state, snapshots, deps } = await setup({ seed: false });
    await seedWarnings(state, [HEAVY_RAIN_ROW]);
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
    });
    const status = JSON.parse(
      snapshots.files.get(`data/${V1}/status.json`)!.body,
    ) as StatusFile;
    expect(Object.keys(status.beaches).sort()).toEqual([...IDS].sort());
    expect(
      Object.values(status.beaches).every((b) => b.category !== "clear"),
    ).toBe(true);
  });
});

// 게시 실행 결과 (결정 기록 D16-C2). 변경이 없어 생략한 것과 실패를 나눠 남김
describe("게시 실행 결과 (D16-C2)", () => {
  it("게시·생략·실패를 다른 결과로 남기고, 실패한 실행만 따로 모은다", async () => {
    let failing = false;
    const { ops, deps, advance } = await setup({
      failOn: (path) => failing && path === MANIFEST_PATH,
    });
    await publishSnapshot(deps());
    expect(ops.lastRun).toEqual({
      at: NOW,
      source: "auto",
      result: "published",
      version: V1,
      checks: { beachIds: true, format: true, required: true },
    });

    advance(60_000);
    await publishSnapshot(deps());
    expect(ops.lastRun).toMatchObject({ result: "unchanged", version: V1 });
    expect(ops.failedRuns).toEqual([]);

    failing = true;
    const v3 = advance(2 * 60 * 60 * 1000); // 파고 90분이 지나 분류가 바뀜 → 게시를 시도함
    expect(await publishSnapshot(deps())).toMatchObject({ status: "failed" });
    expect(ops.lastRun).toMatchObject({
      result: "failed",
      version: v3,
      source: "auto",
    });
    expect(ops.lastRun!.reason).toMatch(/^exception:/);
    expect(ops.failedRuns).toEqual([ops.lastRun]);
  });

  it("다른 실행이 게시 중이라 물러난 실행은 남기지 않는다", async () => {
    const { ops, deps } = await setup();
    await ops.acquireLock(PUBLISH_POLICY.lockName, "other", NOW_MS, 60_000);
    expect(await publishSnapshot(deps())).toEqual({ status: "busy" });
    expect(ops.lastRun).toBeNull();
  });

  it("운영자가 시작한 게시와 되돌리기는 원인을 구분해 남긴다", async () => {
    const { ops, deps, advance } = await setup();
    await publishSnapshot({ ...deps(), source: "operator" });
    expect(ops.lastRun).toMatchObject({ source: "operator" });
    expect(ops.summaries.get(V1)).toMatchObject({ source: "operator" });
    // 되돌릴 것이 없는 되돌리기는 변경 없음으로 남음
    advance(60_000);
    await publishSnapshot(deps(), { rollbackTo: V1 });
    expect(ops.lastRun).toMatchObject({
      source: "rollback",
      target: V1,
      result: "unchanged",
    });
  });

  it("운영자 게시 작업 ID를 실행 기록과 게시 요약에 함께 남긴다(작업 기록이 빠져도 결과를 찾게, #331)", async () => {
    const { ops, deps } = await setup();
    await publishSnapshot({
      ...deps(),
      source: "operator",
      jobId: "j-0123456789ab",
      operatorSub: "operator-sub",
    });
    expect(ops.lastRun).toMatchObject({
      source: "operator",
      jobId: "j-0123456789ab",
    });
    expect(ops.summaries.get(V1)).toMatchObject({
      jobId: "j-0123456789ab",
      operatorSub: "operator-sub",
    });
  });

  it("게시 요약에 분류별 해변 수와 공지 요약값을 남긴다(운영 화면 '바뀐 것', #331)", async () => {
    const { ops, snapshots, deps } = await setup();
    await publishSnapshot(deps());
    const status = JSON.parse(
      snapshots.files.get(`data/${V1}/status.json`)!.body,
    ) as { beaches: Record<string, { category: string }> };
    const count = (category: string) =>
      Object.values(status.beaches).filter((b) => b.category === category)
        .length;
    const summary = ops.summaries.get(V1)!;
    expect(summary.categoryCounts).toEqual({
      clear: count("clear"),
      unavailable: count("unavailable"),
      undetermined: count("undetermined"),
    });
    expect(summary.noticeDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("먼저 시작했지만 늦게 끝난 실행이 더 새 실행의 결과를 덮지 않는다", async () => {
    const { ops } = await setup();
    const newer = {
      at: "2026-10-23T02:35:00Z",
      source: "auto",
      result: "published",
      version: "20261023T023500Z",
    } as const;
    await ops.putPublishRun(newer, NOW_MS);
    await ops.putPublishRun(
      {
        at: "2026-10-23T02:32:00Z",
        source: "rollback",
        result: "failed",
        version: "20261023T023200Z",
        reason: "version_not_newer",
      },
      NOW_MS,
    );
    expect(ops.lastRun).toEqual(newer);
    // 실패한 실행 자체는 따로 남음
    expect(ops.failedRuns).toHaveLength(1);
  });

  it("결과를 남기지 못해도 게시 결과는 그대로이고 경고만 남긴다", async () => {
    const { ops, deps, events } = await setup();
    ops.putPublishRun = async () => {
      throw new Error("ProvisionedThroughputExceededException");
    };
    expect(await publishSnapshot(deps())).toMatchObject({
      status: "published",
      version: V1,
    });
    expect(events()).toContainEqual(
      expect.objectContaining({ event: "publish_run_not_recorded" }),
    );
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
