import type { ManifestFile } from "@baradun/contracts";
import { describe, expect, it } from "vitest";
import { createLogger } from "../core/collect/log";
import { MemorySnapshotStore } from "../core/snapshots/memory";
import { snapshotVersion } from "../core/snapshots/version";
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
import { MANIFEST_PATH, publishSnapshot } from "./publish";
import { republishVersion } from "./republish";

// 옛 게시 파일 다시 내보내기 (결정 기록 D20-4, 급할 때만 쓰는 도구)
// 옛 파일을 새 버전 번호로 다시 내보내되 관측·확인 시각은 고치지 않음

const NOW_MS = Date.parse(NOW);
const V1 = snapshotVersion(NOW_MS);

const notice = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  kind: "general",
  title: { ko: "공지", en: "Notice" },
  body: { ko: "본문", en: "Body" },
  startsAt: "2026-10-23T02:00:00Z",
  endsAt: null,
  ...overrides,
});

// V1: 특보 없음 → V2: 풍랑주의보 발효. 그 뒤 V1 파일을 다시 내보내는 상황
// first·second: V1·V2를 게시할 때 운영 DB에 있던 공지 노출본
async function setup(
  options: {
    failOn?: (path: string) => boolean;
    first?: unknown[];
    second?: unknown[];
  } = {},
) {
  const state = new MemoryStateStore();
  const ops = new MemoryOpsStore();
  const snapshots = new MemorySnapshotStore({ failOn: options.failOn });
  const lines: string[] = [];
  let nowMs = NOW_MS;
  // 운영 DB의 공지 노출본. unreadable이면 읽기 실패
  const db = { candidates: options.first ?? [], unreadable: false };
  const notices = async () => {
    if (db.unreadable) throw new Error("AccessDenied");
    return db.candidates;
  };
  const log = createLogger(
    () => [],
    (line) => lines.push(line),
  );
  const base = (owner = "run-1") => ({
    ops,
    snapshots,
    notices,
    log,
    clock: () => nowMs,
    owner,
  });
  const publish = () =>
    publishSnapshot({
      ...base(),
      state,
      beaches: BEACHES,
      beachIds: BEACHES.map((beach) => beach.id),
      zones: ZONES,
      seasons: SEASONS,
      weatherAreas: WEATHER_AREAS,
    });
  const advance = (ms: number) => {
    nowMs += ms;
    return snapshotVersion(nowMs);
  };
  await seedWarnings(state, [HEAVY_RAIN_ROW]);
  await seedReadings(state);
  await publish();
  db.candidates = options.second ?? options.first ?? [];
  await seedWarnings(state, [WIND_WAVE_ROW], {
    confirmedAt: "2026-10-23T02:31:00Z",
  });
  const v2 = advance(120_000);
  expect(await publish()).toMatchObject({ status: "published", version: v2 });
  const manifest = () =>
    JSON.parse(snapshots.files.get(MANIFEST_PATH)!.body) as ManifestFile;
  const body = (path: string) => snapshots.files.get(path)?.body;
  const events = () =>
    lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { ops, snapshots, db, base, advance, manifest, body, events, v2 };
}

describe("republishVersion (D20-4)", () => {
  it("옛 파일을 내용 그대로 새 버전 경로에 올리고 지금보다 큰 버전의 manifest로 바꾼다", async () => {
    const { ops, snapshots, base, advance, manifest, body, v2 } = await setup();
    const v3 = advance(60_000);
    expect(await republishVersion(base(), V1)).toEqual({
      status: "published",
      version: v3,
      removed: [],
    });
    expect(v3 > v2).toBe(true);
    const names = [
      "beaches.json",
      "status.json",
      "history.json",
      "nationwide-warnings.json",
      "weather.json",
    ];
    // 파일은 한 글자도 고치지 않음 → 관측·확인 시각이 그때 그대로
    for (const name of names) {
      expect(body(`data/${v3}/${name}`), name).toBe(body(`data/${V1}/${name}`));
    }
    expect(manifest()).toMatchObject({
      snapshotVersion: v3,
      // 게시 시각도 그때 값 그대로(지금 만든 데이터처럼 보이게 하지 않음)
      generatedAt: NOW,
      files: Object.fromEntries(
        [
          ["beaches", "beaches.json"],
          ["status", "status.json"],
          ["history", "history.json"],
          ["nationwideWarnings", "nationwide-warnings.json"],
          ["weather", "weather.json"],
        ].map(([key, name]) => [key, `/data/${v3}/${name}`]),
      ),
    });
    expect(body(`data/${v3}/manifest.json`)).toBe(body(MANIFEST_PATH));
    expect(await ops.getPublishedVersion()).toBe(v3);
    expect(await snapshots.listVersions()).toEqual([V1, v2, v3]);
    // 잠금을 풀어 다음 게시가 바로 맡을 수 있음
    expect(
      await ops.acquireLock(PUBLISH_POLICY.lockName, "next", NOW_MS, 1),
    ).toBe(true);
  });

  it("점검·최소 화면 버전은 사본의 값이 아니라 지금 설정을 쓴다", async () => {
    const { snapshots, base, advance, manifest, body } = await setup();
    const copyPath = `data/${V1}/manifest.json`;
    await snapshots.putFile(
      copyPath,
      JSON.stringify({
        ...(JSON.parse(body(copyPath)!) as ManifestFile),
        maintenance: {
          active: !MANIFEST_SETTINGS.maintenance.active,
          until: null,
        },
        minWebBuild: MANIFEST_SETTINGS.minWebBuild - 1,
      }),
      "x",
    );
    advance(60_000);
    expect(await republishVersion(base(), V1)).toMatchObject({
      status: "published",
    });
    expect(manifest()).toMatchObject({
      maintenance: MANIFEST_SETTINGS.maintenance,
      minWebBuild: MANIFEST_SETTINGS.minWebBuild,
    });
  });

  it("게시 요약과 실행 결과에 다시 내보내기임을 남긴다", async () => {
    const { ops, base, advance, v2 } = await setup();
    const v3 = advance(60_000);
    await republishVersion(base(), V1);
    const summary = ops.summaries.get(v3)!;
    expect(summary).toMatchObject({
      source: "republish",
      target: V1,
      previous: v2,
      beachCount: BEACHES.length,
      // 분류는 옛 파일에 적힌 그대로
      delayedBeachIds: ops.summaries.get(V1)!.delayedBeachIds,
    });
    // 공지 상태는 이번에 읽은 지금 상태(공지 없음)를 남김
    expect(ops.publishNotices.get(v3)).toEqual([]);
    expect(ops.lastRun).toMatchObject({
      source: "republish",
      result: "published",
      version: v3,
      target: V1,
    });
    // 되돌림 포인터는 건드리지 않음
    expect(ops.noticeHold).toBeNull();
  });

  it.each([
    [
      "없는 버전",
      (_: string): string => "20261001T000000Z",
      [],
      "manifest_missing",
    ],
    [
      "파일이 빠진 버전",
      (v: string): string => v,
      ["status.json"],
      "files_missing",
    ],
    [
      "날씨가 실렸는데 weather.json이 빠진 버전",
      (v: string): string => v,
      ["weather.json"],
      "files_missing",
    ],
  ] as const)(
    "%s은 다시 내보내지 않는다(manifest 그대로)",
    async (_name, pick, drop, reason) => {
      const { ops, snapshots, base, advance, body, events, v2 } = await setup();
      const before = body(MANIFEST_PATH);
      for (const name of drop) snapshots.files.delete(`data/${V1}/${name}`);
      const v3 = advance(60_000);
      expect(await republishVersion(base(), pick(V1))).toEqual({
        status: "failed",
        version: v3,
        reason,
      });
      expect(body(MANIFEST_PATH)).toBe(before);
      expect(await snapshots.listVersions()).toEqual([V1, v2]);
      expect(await ops.getPublishedVersion()).toBe(v2);
      expect(ops.lastRun).toMatchObject({ result: "failed", reason });
      expect(events().at(-1)).toMatchObject({
        event: "publish_failed",
        source: "republish",
        reason,
      });
    },
  );

  it("사본이 다른 버전 경로의 파일을 가리키면 파일 없음과 다른 사유로 멈춘다", async () => {
    const { snapshots, base, advance, body, events } = await setup();
    const before = body(MANIFEST_PATH);
    const copyPath = `data/${V1}/manifest.json`;
    const copy = JSON.parse(body(copyPath)!) as ManifestFile;
    await snapshots.putFile(
      copyPath,
      JSON.stringify({
        ...copy,
        files: { ...copy.files, status: "/data/20261001T000000Z/status.json" },
      }),
      "x",
    );
    advance(60_000);
    expect(await republishVersion(base(), V1)).toMatchObject({
      status: "failed",
      reason: "files_mismatch",
    });
    expect(body(MANIFEST_PATH)).toBe(before);
    expect(events().at(-1)).toMatchObject({ reason: "files_mismatch" });
  });

  it("다른 판단 정책으로 게시된 버전은 다시 내보내지 않는다(모든 화면이 판단불가가 되므로)", async () => {
    const { snapshots, base, advance, body } = await setup();
    const before = body(MANIFEST_PATH);
    const copyPath = `data/${V1}/manifest.json`;
    await snapshots.putFile(
      copyPath,
      JSON.stringify({
        ...(JSON.parse(body(copyPath)!) as ManifestFile),
        policyVersion: "warnings-0+observations-0",
      }),
      "x",
    );
    advance(60_000);
    expect(await republishVersion(base(), V1)).toMatchObject({
      status: "failed",
      reason: "policy_unsupported",
    });
    expect(body(MANIFEST_PATH)).toBe(before);
  });

  it("계약에 맞지 않는 옛 파일은 다시 내보내지 않는다", async () => {
    const { snapshots, base, advance, body } = await setup();
    const before = body(MANIFEST_PATH);
    await snapshots.putFile(`data/${V1}/status.json`, '{"beaches":[]}', "x");
    advance(60_000);
    expect(await republishVersion(base(), V1)).toMatchObject({
      status: "failed",
      reason: "contract",
    });
    expect(body(MANIFEST_PATH)).toBe(before);
  });

  it("다른 실행이 게시 중이면(같은 잠금) 아무것도 하지 않는다", async () => {
    const { ops, snapshots, base, advance, body, v2 } = await setup();
    const before = body(MANIFEST_PATH);
    advance(60_000);
    await ops.acquireLock(PUBLISH_POLICY.lockName, "other", NOW_MS, 600_000);
    expect(await republishVersion(base(), V1)).toEqual({ status: "busy" });
    expect(body(MANIFEST_PATH)).toBe(before);
    expect(await snapshots.listVersions()).toEqual([V1, v2]);
  });

  it("manifest 교체에 실패하면 올리다 만 버전 경로를 지우고 앞 게시본을 둔다", async () => {
    let failing = false;
    const { snapshots, base, advance, body, v2 } = await setup({
      failOn: (path) => failing && path === MANIFEST_PATH,
    });
    const before = body(MANIFEST_PATH);
    failing = true;
    advance(60_000);
    expect(await republishVersion(base(), V1)).toMatchObject({
      status: "failed",
    });
    expect(body(MANIFEST_PATH)).toBe(before);
    expect(await snapshots.listVersions()).toEqual([V1, v2]);
  });

  it("같은 초에 다시 돌면 이미 쓴 버전을 덮지 않는다", async () => {
    const { base } = await setup();
    expect(await republishVersion(base(), V1)).toMatchObject({
      status: "failed",
      reason: "version_not_newer",
    });
  });

  // 공지는 사본의 값이 아니라 지금 상태로 실음(사용자 결정 2026-11-12, PR #407 리뷰)
  describe("공지", () => {
    it("그 뒤 운영자가 끝낸 공지는 다시 나가지 않고, 지금 노출 중인 공지가 실린다", async () => {
      const { ops, base, advance, manifest, body } = await setup({
        first: [notice("n-old")],
        // V1 뒤에 n-old 노출을 끝내고 n-new를 노출함
        second: [
          notice("n-old", { endsAt: "2026-10-23T02:31:00Z" }),
          notice("n-new"),
        ],
      });
      expect(body(`data/${V1}/manifest.json`)).toContain("n-old");
      const v3 = advance(60_000);
      expect(await republishVersion(base(), V1)).toMatchObject({
        status: "published",
        version: v3,
      });
      expect(manifest().notices).toEqual([notice("n-new")]);
      // 특보·관측 파일은 옛 것 그대로
      expect(body(`data/${v3}/status.json`)).toBe(
        body(`data/${V1}/status.json`),
      );
      expect(ops.publishNotices.get(v3)).toEqual([notice("n-new")]);
    });

    it("끝 시각이 지난 공지가 실린 사본도 다시 내보낸다(그 공지는 싣지 않음)", async () => {
      const ending = notice("n-ending", { endsAt: "2026-10-23T02:31:00Z" });
      const { base, advance, manifest } = await setup({ first: [ending] });
      advance(60_000);
      expect(await republishVersion(base(), V1)).toMatchObject({
        status: "published",
      });
      expect(manifest()).not.toHaveProperty("notices");
    });

    it("되돌림으로 표시한 공지는 다시 내보내도 표시대로 싣는다", async () => {
      const { ops, base, advance, manifest } = await setup({
        first: [notice("n-a"), notice("n-b")],
      });
      const held = {
        target: V1,
        at: "2026-10-23T02:32:00Z",
        live: null,
      };
      await ops.putNoticeHold({ "n-b": held }, 0, held.at);
      advance(60_000);
      await republishVersion(base(), V1);
      expect(manifest().notices).toEqual([notice("n-a")]);
      // 포인터는 건드리지 않음
      expect(ops.noticeHold).toEqual({ version: 1, notices: { "n-b": held } });
    });

    it("운영 DB를 읽지 못하면 지금 게시본의 공지를 이어 쓰고, 공지 상태는 남기지 않는다", async () => {
      const { ops, db, base, advance, manifest, events } = await setup({
        first: [notice("n-old")],
        second: [notice("n-now")],
      });
      db.unreadable = true;
      const v3 = advance(60_000);
      expect(await republishVersion(base(), V1)).toMatchObject({
        status: "published",
      });
      // 사본(V1)의 n-old가 아니라 지금 게시본(V2)의 n-now
      expect(manifest().notices).toEqual([notice("n-now")]);
      expect(ops.publishNotices.has(v3)).toBe(false);
      expect(events().some((e) => e.event === "publish_notices_unread")).toBe(
        true,
      );
    });
  });
});
