import type { Beach, ManifestFile } from "@baradun/contracts";
import type { Logger } from "../core/collect/log";
import type { SnapshotStore } from "../core/snapshots/types";
import type { OpsStore, StateStore } from "../core/store/types";
import type { ZoneTables } from "../core/warnings/beach-warnings";
import { formatUtcIso } from "../core/warnings/time";
import { readPublishInputs } from "./inputs";
import { MANIFEST_SETTINGS, PUBLISH_POLICY } from "./policy";
import { ripCurrentInfo } from "../core/rip/rip-current";
import { BeachSnapshotError, buildSnapshot, type Snapshot } from "./snapshot";
import type { SeasonTable } from "./season";
import { contractErrors, type ContractFile } from "./validate";

// publish-snapshot (아키텍처 6.2, BRD-61)
// 순서: 게시 잠금 → State 묶음 조회 → 분류 → 계약 검사 → /data/{v}/ 업로드 → manifest 교체 → 게시 버전 기록 → 오래된 버전 정리
// 어느 단계든 실패하면 manifest를 바꾸지 않음(이전 버전 유지). 바뀐 게 없으면 게시 생략(11장)

export const MANIFEST_PATH = "data/manifest.json";

export interface PublishDeps {
  readonly state: StateStore;
  readonly ops: OpsStore;
  readonly snapshots: SnapshotStore;
  readonly beaches: readonly Beach[]; // data/beaches
  readonly zones: ZoneTables;
  readonly seasons: SeasonTable; // data/beach-meta.json 운영 기간
  readonly log: Logger;
  readonly clock: () => number; // 서버 시각(epoch ms)
  readonly owner: string; // 이 실행의 id(Lambda 요청 id)
}

// busy: 다른 실행이 게시 중. unchanged: 지금 manifest와 내용이 같음. failed: manifest 그대로
export type PublishResult =
  | { status: "published"; version: string; removed: string[] }
  | { status: "unchanged"; version: string }
  | { status: "busy" }
  | { status: "failed"; version: string; reason: string };

// 게시 버전 경로에 올리는 파일. manifest.json 사본은 롤백 때 그대로 되돌리려고 둠
const FILES = {
  beaches: { name: "beaches.json", contract: "BeachesFile" },
  status: { name: "status.json", contract: "StatusFile" },
  history: { name: "history.json", contract: "HistoryFile" },
  nationwideWarnings: {
    name: "nationwide-warnings.json",
    contract: "NationwideWarningsFile",
  },
} as const satisfies Record<
  keyof Snapshot,
  { name: string; contract: ContractFile }
>;
const KEYS = Object.keys(FILES) as (keyof Snapshot)[];

const versionPath = (version: string, name: string) =>
  `data/${version}/${name}`;

// 20261017T053000Z (계약 snapshotVersion 형식). 초 단위 → 글자 순서 = 시각 순서
export function snapshotVersion(ms: number): string {
  return formatUtcIso(ms).replace(/[-:]/g, "");
}

function manifestFor(version: string, generatedAt: string): ManifestFile {
  return {
    schemaVersion: MANIFEST_SETTINGS.schemaVersion,
    snapshotVersion: version,
    policyVersion: PUBLISH_POLICY.policyVersion,
    generatedAt,
    maintenance: { ...MANIFEST_SETTINGS.maintenance },
    minWebBuild: MANIFEST_SETTINGS.minWebBuild,
    files: {
      beaches: `/${versionPath(version, FILES.beaches.name)}`,
      status: `/${versionPath(version, FILES.status.name)}`,
      history: `/${versionPath(version, FILES.history.name)}`,
      nationwideWarnings: `/${versionPath(version, FILES.nationwideWarnings.name)}`,
    },
  };
}

function parseManifest(body: string | null): ManifestFile | null {
  if (body === null) return null;
  try {
    const value: unknown = JSON.parse(body);
    return contractErrors("ManifestFile", value).length === 0
      ? (value as ManifestFile)
      : null;
  } catch {
    return null;
  }
}

// 지금 manifest가 이 버전을 가리킬 수 있는지. 읽지 못하면 그럴 수 있다고 봄(지우지 않는 쪽)
// 둘 중 늦은 버전. 자릿수가 고정된 형식이라 글자 비교 = 시각 순서. 둘 다 없으면 null
function newestVersion(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

async function manifestMayPointTo(
  snapshots: SnapshotStore,
  version: string,
): Promise<boolean> {
  try {
    const body = await snapshots.getFile(MANIFEST_PATH);
    if (body === null) return false;
    const current = parseManifest(body);
    return current === null || current.snapshotVersion === version;
  } catch {
    return true;
  }
}

// 지금 manifest가 가리키는 파일과 설정이 모두 같으면 게시하지 않음
// 지금 manifest를 못 읽으면 다르다고 봄(게시함)
async function sameAsCurrent(
  snapshots: SnapshotStore,
  current: ManifestFile | null,
  bodies: Record<keyof Snapshot, string>,
): Promise<boolean> {
  if (current === null) return false;
  if (
    current.policyVersion !== PUBLISH_POLICY.policyVersion ||
    current.minWebBuild !== MANIFEST_SETTINGS.minWebBuild ||
    JSON.stringify(current.maintenance) !==
      JSON.stringify(MANIFEST_SETTINGS.maintenance)
  ) {
    return false;
  }
  const previous = await Promise.all(
    KEYS.map((key) => snapshots.getFile(current.files[key].replace(/^\//, ""))),
  );
  return KEYS.every((key, i) => previous[i] === bodies[key]);
}

// 오래된 버전 정리. 최근 48개와 지금 manifest가 가리키는 버전은 남김. 실패해도 게시는 그대로(다음 게시가 다시 지움)
async function removeOldVersions(
  snapshots: SnapshotStore,
  keep: string,
  log: Logger,
): Promise<string[]> {
  try {
    const versions = await snapshots.listVersions();
    const old = versions
      .slice(0, Math.max(0, versions.length - PUBLISH_POLICY.retainVersions))
      .filter((v) => v !== keep);
    for (const version of old) await snapshots.deleteVersion(version);
    return old;
  } catch (error) {
    log("warn", "publish_cleanup_failed", {
      error: error instanceof Error ? error.name : typeof error,
    });
    return [];
  }
}

export async function publishSnapshot(
  deps: PublishDeps,
): Promise<PublishResult> {
  const { ops, snapshots, log } = deps;
  const startedMs = deps.clock();
  const version = snapshotVersion(startedMs);
  const now = formatUtcIso(startedMs);

  const locked = await ops.acquireLock(
    PUBLISH_POLICY.lockName,
    deps.owner,
    startedMs,
    PUBLISH_POLICY.lockTtlMs,
  );
  if (!locked) {
    log("info", "publish_busy", { version });
    return { status: "busy" };
  }

  const fail = (reason: string, fields: Record<string, unknown> = {}) => {
    log("error", "publish_failed", { version, reason, ...fields });
    return { status: "failed", version, reason } as const;
  };

  let uploaded = false;
  try {
    // 같은 초에 두 번 돌았거나 시계가 뒤로 감 → 이미 쓴 버전 경로를 덮지 않음(immutable 캐시라 같은 주소에 다른 내용이 생김)
    // Ops 기록은 manifest 교체 뒤에 쓰므로 실제보다 뒤처질 수 있음 → 지금 manifest가 가리키는 버전도 함께 봄
    const current = parseManifest(await snapshots.getFile(MANIFEST_PATH));
    const published = newestVersion(
      await ops.getPublishedVersion(),
      current?.snapshotVersion ?? null,
    );
    if (published !== null && version <= published) {
      return fail("version_not_newer", { published });
    }

    let snapshot: Snapshot;
    const inputs = await readPublishInputs(deps.state, log);
    try {
      snapshot = buildSnapshot({
        beaches: deps.beaches,
        zones: deps.zones,
        seasons: deps.seasons,
        inputs,
        now,
      });
    } catch (error) {
      if (error instanceof BeachSnapshotError) {
        return fail("classify", {
          beachId: error.beachId,
          slug: error.slug,
          message: error.message,
        });
      }
      throw error;
    }

    // 이안류 값을 숨긴 해변 중 모르는 문구·틀린 시각은 운영 알림(정보는 null로 게시됨, BRD-57)
    for (const beach of deps.beaches) {
      const { hidden } = ripCurrentInfo(inputs.ripReadings[beach.id], now);
      if (hidden === "unknown_label" || hidden === "bad_time") {
        log("warn", "publish_rip_hidden", {
          beachId: beach.id,
          reason: hidden,
        });
      }
    }

    const manifest = manifestFor(version, now);
    const errors = [
      ...KEYS.flatMap((key) =>
        contractErrors(FILES[key].contract, snapshot[key]),
      ),
      ...contractErrors("ManifestFile", manifest),
    ];
    if (errors.length > 0) {
      return fail("contract", { errors: errors.slice(0, 20) });
    }

    const bodies = Object.fromEntries(
      KEYS.map((key) => [key, JSON.stringify(snapshot[key])]),
    ) as Record<keyof Snapshot, string>;
    if (await sameAsCurrent(snapshots, current, bodies)) {
      log("info", "publish_unchanged", { version: current!.snapshotVersion });
      return { status: "unchanged", version: current!.snapshotVersion };
    }

    // 버전 경로 먼저. 다 올라간 뒤에만 manifest를 바꿈
    uploaded = true;
    const versioned = PUBLISH_POLICY.cacheControl.versioned;
    const manifestBody = JSON.stringify(manifest);
    // 하나가 실패해도 시작한 쓰기를 모두 기다린 뒤에 실패로 넘어감(allSettled)
    // → finally의 버전 경로 삭제 뒤에 늦게 끝난 쓰기가 파일을 되살리지 않음
    const settled = await Promise.allSettled([
      ...KEYS.map((key) =>
        snapshots.putFile(
          versionPath(version, FILES[key].name),
          bodies[key],
          versioned,
        ),
      ),
      snapshots.putFile(
        versionPath(version, "manifest.json"),
        manifestBody,
        versioned,
      ),
    ]);
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected !== undefined) throw rejected.reason;
    // manifest 교체는 조건부 쓰기(읽은 manifest가 그대로일 때만). 잠금 시간을 넘긴 실행과 새 실행이
    // 거의 같은 순간 써도, 확인과 쓰기 사이에 끼어든 쓰기가 있으면 이 쓰기는 거절됨 → 다시 읽고 판단
    // 더 새 버전이 이미 게시됐으면 manifest를 옛 버전으로 되돌리지 않음
    let replaced = false;
    for (
      let attempt = 1;
      attempt <= PUBLISH_POLICY.manifestWriteAttempts;
      attempt += 1
    ) {
      const currentFile = await snapshots.getTaggedFile(MANIFEST_PATH);
      const latest = newestVersion(
        await ops.getPublishedVersion(),
        parseManifest(currentFile?.body ?? null)?.snapshotVersion ?? null,
      );
      if (latest !== null && version <= latest) {
        return fail("version_not_newer", { published: latest });
      }
      if (
        await snapshots.putFileIf(
          MANIFEST_PATH,
          manifestBody,
          PUBLISH_POLICY.cacheControl.manifest,
          currentFile?.etag ?? null,
        )
      ) {
        replaced = true;
        break;
      }
      log("warn", "publish_manifest_conflict", { version, attempt });
    }
    if (!replaced) return fail("manifest_conflict");
    uploaded = false; // manifest가 이 버전을 가리킴 → 지우면 안 됨

    // 잠금 안에서는 생기지 않아야 함. manifest는 이미 바뀌었으므로 알리기만 함
    // 예외도 같게 봄: 여기서 던지면 이미 끝난 게시가 failed로 잘못 보고됨
    if (!(await ops.setPublishedVersion(version).catch(() => false))) {
      log("error", "publish_version_not_recorded", { version });
    }
    const removed = await removeOldVersions(snapshots, version, log);
    log("info", "publish_finished", {
      version,
      beaches: deps.beaches.length,
      removed: removed.length,
    });
    return { status: "published", version, removed };
  } catch (error) {
    return fail(
      `exception:${error instanceof Error ? error.name : typeof error}`,
    );
  } finally {
    // manifest를 바꾸기 전에 멈춘 업로드는 지움(보존 48개 자리를 차지하지 않게). 실패해도 다음 정리가 지움
    // manifest 쓰기가 실제로는 됐는데 응답만 실패했을 수 있음 → manifest가 이 버전을 가리키거나 읽지 못하면 지우지 않음
    if (uploaded && !(await manifestMayPointTo(snapshots, version))) {
      await snapshots.deleteVersion(version).catch(() => undefined);
    }
    await ops
      .releaseLock(PUBLISH_POLICY.lockName, deps.owner)
      .catch(() => false);
  }
}

// 롤백 (아키텍처 1장: manifest를 이전 버전으로 되돌려 수 분 내 복구, T06)
// 그 버전 경로의 manifest 사본과 파일 네 개가 모두 있어야 되돌림. 하나라도 없으면 지금 manifest 그대로
// 다음 게시가 새 버전으로 다시 덮으므로, 게시 코드 문제로 되돌릴 때는 수집기 일정을 먼저 멈춤
// 점검·최소 화면 버전은 데이터가 아니라 운영 설정 → 사본의 값이 아니라 지금 코드의 MANIFEST_SETTINGS를 씀
// (점검 중 롤백해도 점검이 풀리지 않고, 올린 minWebBuild가 되돌아가지 않음. BRD-43 리뷰)
export async function rollbackManifest(
  snapshots: SnapshotStore,
  version: string,
): Promise<{ status: "rolled_back" } | { status: "failed"; reason: string }> {
  const manifest = parseManifest(
    await snapshots.getFile(versionPath(version, "manifest.json")),
  );
  if (manifest === null || manifest.snapshotVersion !== version) {
    return { status: "failed", reason: "manifest_missing" };
  }
  const files = await Promise.all(
    KEYS.map((key) =>
      snapshots.getFile(manifest.files[key].replace(/^\//, "")),
    ),
  );
  if (files.some((body) => body === null)) {
    return { status: "failed", reason: "files_missing" };
  }
  const restored: ManifestFile = {
    ...manifest,
    maintenance: { ...MANIFEST_SETTINGS.maintenance },
    minWebBuild: MANIFEST_SETTINGS.minWebBuild,
  };
  await snapshots.putFile(
    MANIFEST_PATH,
    JSON.stringify(restored),
    PUBLISH_POLICY.cacheControl.manifest,
  );
  return { status: "rolled_back" };
}
