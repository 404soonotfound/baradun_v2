import {
  buildPublishSummary,
  buildStationTable,
  canonicalJson,
  type PublishRun,
  type PublishSource,
} from "../core/collect/publish-summary";
import type { Beach, ManifestFile, Notice } from "@baradun/contracts";
import type { Logger } from "../core/collect/log";
import type { SnapshotStore } from "../core/snapshots/types";
import type { NoticeHold, OpsStore, StateStore } from "../core/store/types";
import type { ZoneTables } from "../core/warnings/beach-warnings";
import { snapshotVersion } from "../core/snapshots/version";
import { formatUtcIso } from "../core/warnings/time";
import { readPublishInputs } from "./inputs";
import {
  applyNoticeHold,
  currentNotices,
  MANIFEST_PATH,
  noticeHoldFor,
  parseManifest,
  publishableNotices,
  started,
} from "./notice-select";
import { MANIFEST_SETTINGS, PUBLISH_POLICY } from "./policy";
import { BeachSnapshotError, buildSnapshot, type Snapshot } from "./snapshot";
import type { SeasonTable } from "./season";
import { contractErrors, type ContractFile } from "./validate";
import { buildWeather, type WeatherAreaTable } from "./weather";

// publish-snapshot (아키텍처 6.2, BRD-61)
// 순서: 게시 잠금 → 해변 ID 대조 → State 묶음 조회 → 분류 → 계약 검사 → /data/{v}/ 업로드 → manifest 교체 → 게시 버전 기록 → 오래된 버전 정리
// 어느 단계든 실패하면 manifest를 바꾸지 않음(이전 버전 유지). 바뀐 게 없으면 게시 생략(11장)
// 자동 게시·'지금 게시'·되돌리기가 모두 이 함수 하나를 씀(같은 잠금·같은 계약 검사, 결정 기록 D20-1·D16-C4)
// - 되돌리기(rollbackTo): 옛 manifest를 되살리지 않고 지금보다 큰 새 snapshotVersion으로 다시 게시함(D20-1)
//   공지만 고른 게시본 때 상태로 되살리고(D20-2), 특보·관측은 늘 지금 수집 사실을 씀(D20-3)
// - 옛 게시 파일을 그대로 다시 내보내는 긴급 도구는 republish.ts(D20-4)

// 공지 고르기·manifest 읽기는 운영 API도 쓰므로 가벼운 모듈(notice-select.ts)에 둠. 기존 가져오기를 위해 다시 내보냄
export {
  applyNoticeHold,
  currentNotices,
  MANIFEST_PATH,
  noticeHoldFor,
  parseManifest,
  publishableNotices,
};

export interface PublishDeps {
  readonly state: StateStore;
  readonly ops: OpsStore;
  readonly snapshots: SnapshotStore;
  readonly beaches: readonly Beach[]; // data/beaches
  // 저장소 원본 해변 ID 목록(data/beach-meta.json의 해변 칸). 해변 파일과 따로 묶여 들어온 목록이라
  // 읽은 해변 파일·게시 결과와 집합으로 대조함(D16-C1)
  readonly beachIds: readonly string[];
  readonly zones: ZoneTables;
  readonly seasons: SeasonTable; // data/beach-meta.json 운영 기간
  readonly weatherAreas: WeatherAreaTable; // data/weather-areas.json(BRD-181)
  readonly log: Logger;
  // 운영 DB의 노출본 공지(지운 것 제외). 시각·계약 검사는 여기서 함(BRD-151, 아키텍처 18.4)
  readonly notices: () => Promise<readonly unknown[]>;
  readonly clock: () => number; // 서버 시각(epoch ms)
  readonly owner: string; // 이 실행의 id(Lambda 요청 id)
  // 게시 원인. 없으면 자동 게시. 되돌리기는 options.rollbackTo가 정함
  readonly source?: "auto" | "operator";
  // 운영 API가 연 게시 작업 ID(#331). 실행 기록·게시 요약에 함께 남겨 작업 기록이 빠져도 결과를 찾게 함
  readonly jobId?: string;
}

export interface PublishOptions {
  // 되돌리기: 이 게시본 때의 공지 상태로 되살려 새 버전으로 게시함(D20-1~3)
  readonly rollbackTo?: string;
}

// busy: 다른 실행이 게시 중. unchanged: 지금 manifest와 내용이 같음. failed: manifest 그대로
export type PublishResult =
  | { status: "published"; version: string; removed: string[] }
  | { status: "unchanged"; version: string }
  | { status: "busy" }
  | { status: "failed"; version: string; reason: string };

// 게시 버전 경로에 올리는 파일. manifest.json 사본은 긴급 다시 내보내기(republish.ts)가 읽음
export const FILES = {
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
export const KEYS = Object.keys(FILES) as (keyof Snapshot)[];
// 날씨(BRD-181)는 참고 정보라 판단 파일과 따로 다룸: 만들지 못하면 이 파일만 빼고 판단 파일은 게시함
export const WEATHER = {
  name: "weather.json",
  contract: "WeatherFile",
} as const;

export const versionPath = (version: string, name: string) =>
  `data/${version}/${name}`;

// 해변 ID 집합 대조(D16-C1). 저장소 원본 목록과 다르면(누락·추가·중복) 게시하지 않음
// 비율 기준 없음: 하나라도 다르면 멈춤. 관측 실패는 해변을 빼지 않으므로(분류만 판단불가) 여기 걸리지 않음
export interface BeachIdProblem {
  readonly missing: string[]; // 원본에 있는데 없음
  readonly extra: string[]; // 원본에 없는데 있음
  readonly duplicate: string[]; // 두 번 이상 나옴(원본 목록 안의 중복 포함)
}

export function beachIdProblem(
  expected: readonly string[],
  actual: readonly string[],
): BeachIdProblem | null {
  const want = new Set(expected);
  const have = new Set(actual);
  const repeated = (ids: readonly string[]) =>
    ids.filter((id, i) => ids.indexOf(id) !== i);
  const problem = {
    missing: [...want].filter((id) => !have.has(id)).sort(),
    extra: [...have].filter((id) => !want.has(id)).sort(),
    duplicate: [
      ...new Set([...repeated(expected), ...repeated(actual)]),
    ].sort(),
  };
  return problem.missing.length +
    problem.extra.length +
    problem.duplicate.length >
    0
    ? problem
    : null;
}

// 칸 순서와 상관없는 비교(DynamoDB는 맵의 칸 순서를 지키지 않음, publish-summary.ts canonicalJson)
const canonical = canonicalJson;

// 두 포인터가 같은 공지를 같은 노출본으로 되돌리는지(고른 게시본·되돌린 시각은 보지 않음)
export function sameHeldNotices(
  a: NoticeHold["notices"],
  b: NoticeHold["notices"],
): boolean {
  const lives = (held: NoticeHold["notices"]) =>
    canonical(
      Object.fromEntries(
        Object.entries(held).map(([id, entry]) => [id, entry.live]),
      ),
    );
  return lives(a) === lives(b);
}

// 지금 공지 읽기: 운영 DB 노출본에 되돌림 포인터를 반영함. 자동 게시와 다시 내보내기가 같이 씀
// - notices: 게시본에 실을 공지(시작한 것만) · state: 지금 공지 상태(끝나지 않은 노출본 전부). 모르면 null
// - 운영 DB나 포인터를 읽지 못하면 지금 manifest의 공지를 이어서 씀(끝난 것은 뺌)
//   공지를 읽지 못했다고 특보·관측 게시를 멈추지 않고, 노출 중인 점검 예고가 조용히 사라지지도 않게 함
//   포인터를 읽지 못했을 때 운영 DB 노출본을 그대로 실으면 되돌린 공지가 다시 나감 → 그것도 못 읽은 것으로 봄
export async function readCurrentNotices(
  deps: Pick<PublishDeps, "ops" | "notices" | "log">,
  current: ManifestFile | null,
  nowMs: number,
  version: string,
): Promise<{ notices: Notice[]; state: Notice[] | null }> {
  try {
    const [candidates, hold] = await Promise.all([
      deps.notices(),
      deps.ops.getNoticeHold(),
    ]);
    const state = currentNotices(
      applyNoticeHold(candidates, hold),
      nowMs,
      deps.log,
    );
    return { notices: started(state, nowMs), state };
  } catch (error) {
    deps.log("warn", "publish_notices_unread", {
      version,
      error: error instanceof Error ? error.name : typeof error,
    });
    return {
      notices: publishableNotices(current?.notices ?? [], nowMs, deps.log),
      state: null,
    };
  }
}

function manifestFor(
  version: string,
  generatedAt: string,
  notices: readonly Notice[],
  withWeather: boolean,
): ManifestFile {
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
      // 날씨를 만들지 못한 게시에는 칸을 두지 않음 → 화면은 '날씨를 확인하지 못했어요'
      ...(withWeather
        ? { weather: `/${versionPath(version, WEATHER.name)}` }
        : {}),
    },
    // 공지가 없으면 칸을 두지 않음(공지 기능 전 manifest와 같은 모양)
    ...(notices.length > 0 ? { notices: [...notices] } : {}),
  };
}

// 지금 manifest가 이 버전을 가리킬 수 있는지. 읽지 못하면 그럴 수 있다고 봄(지우지 않는 쪽)
// 둘 중 늦은 버전. 자릿수가 고정된 형식이라 글자 비교 = 시각 순서. 둘 다 없으면 null
export function newestVersion(
  a: string | null,
  b: string | null,
): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

export async function manifestMayPointTo(
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

// 지금 manifest가 가리키는 파일과 설정·공지가 모두 같으면 게시하지 않음
// 지금 manifest를 못 읽으면 다르다고 봄(게시함)
async function sameAsCurrent(
  snapshots: SnapshotStore,
  current: ManifestFile | null,
  bodies: Record<keyof Snapshot, string>,
  notices: readonly Notice[],
  weatherBody: string | null,
): Promise<boolean> {
  if (current === null) return false;
  if (
    JSON.stringify(current.notices ?? []) !== JSON.stringify(notices) ||
    current.policyVersion !== PUBLISH_POLICY.policyVersion ||
    current.minWebBuild !== MANIFEST_SETTINGS.minWebBuild ||
    JSON.stringify(current.maintenance) !==
      JSON.stringify(MANIFEST_SETTINGS.maintenance)
  ) {
    return false;
  }
  if ((current.files.weather === undefined) !== (weatherBody === null)) {
    return false;
  }
  const previous = await Promise.all(
    KEYS.map((key) => snapshots.getFile(current.files[key].replace(/^\//, ""))),
  );
  const previousWeather = current.files.weather
    ? await snapshots.getFile(current.files.weather.replace(/^\//, ""))
    : null;
  return (
    KEYS.every((key, i) => previous[i] === bodies[key]) &&
    previousWeather === weatherBody
  );
}

// 오래된 버전 정리. 최근 48개와 지금 manifest가 가리키는 버전은 남김. 실패해도 게시는 그대로(다음 게시가 다시 지움)
export async function removeOldVersions(
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

// manifest 교체는 조건부 쓰기(읽은 manifest가 그대로일 때만). 잠금 시간을 넘긴 실행과 새 실행이
// 거의 같은 순간 써도, 확인과 쓰기 사이에 끼어든 쓰기가 있으면 이 쓰기는 거절됨 → 다시 읽고 판단
// 더 새 버전이 이미 게시됐으면 manifest를 옛 버전으로 되돌리지 않음
export async function replaceManifest(
  deps: Pick<PublishDeps, "ops" | "snapshots" | "log">,
  version: string,
  manifestBody: string,
): Promise<
  | { ok: true }
  | { ok: false; reason: "version_not_newer"; published: string }
  | { ok: false; reason: "manifest_conflict" }
> {
  const { ops, snapshots, log } = deps;
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
      return { ok: false, reason: "version_not_newer", published: latest };
    }
    if (
      await snapshots.putFileIf(
        MANIFEST_PATH,
        manifestBody,
        PUBLISH_POLICY.cacheControl.manifest,
        currentFile?.etag ?? null,
      )
    ) {
      return { ok: true };
    }
    log("warn", "publish_manifest_conflict", { version, attempt });
  }
  return { ok: false, reason: "manifest_conflict" };
}

// 게시 실행 결과 남기기(D16-C2: 변경이 없어 생략한 것과 실패를 나눔). 남기지 못해도 게시 결과는 그대로 → 경고만
export async function recordPublishRun(
  deps: Pick<PublishDeps, "ops" | "log">,
  run: PublishRun,
  nowMs: number,
): Promise<void> {
  try {
    await deps.ops.putPublishRun(run, nowMs);
  } catch (error) {
    deps.log("warn", "publish_run_not_recorded", {
      version: run.version,
      result: run.result,
      error: error instanceof Error ? error.name : typeof error,
    });
  }
}

// 이 실행 환경에서 마지막으로 쓴 관측소 표(저장소별). 같으면 다시 쓰지 않음
const writtenStationTables = new WeakMap<OpsStore, string>();

// manifest를 바꾼 뒤 남기는 기록 둘. 서로 기다릴 필요가 없어 함께 보냄(게시 잠금을 잡고 있는 시간을 줄임)
// 어느 쪽이든 남기지 못해도 게시는 끝난 것 → 경고만
// - 이 게시 때의 공지 상태(되돌리기 기준, D20-2). 모르는 게시(운영 DB를 읽지 못함)는 남기지 않음
//   → 기록이 없는 버전으로는 되돌릴 수 없음
// - 운영 화면용 게시 요약(BRD-187, 빠진 요약은 previous 사슬로 드러남)과 관측소 표
export async function recordPublished(
  deps: Pick<PublishDeps, "ops" | "log"> & { beaches?: readonly Beach[] },
  published: {
    version: string;
    previous: string | null;
    now: string;
    startedMs: number;
    status: Parameters<typeof buildPublishSummary>[0]["status"];
    source: PublishSource;
    target: string | undefined;
    noticeState: readonly Notice[] | null;
    // 게시본에 실은 공지(요약값을 남겨 운영 화면이 공지 변경 여부를 보여 줌)
    notices: readonly Notice[];
    jobId: string | undefined;
  },
): Promise<void> {
  const { ops, log } = deps;
  const { version, now, startedMs } = published;
  const warn = (event: string) => (error: unknown) =>
    log("warn", event, {
      version,
      error: error instanceof Error ? error.name : typeof error,
    });
  const noticeState = published.noticeState;
  await Promise.all([
    noticeState === null
      ? undefined
      : ops
          .putPublishNotices(version, noticeState, startedMs)
          .catch(warn("publish_notices_not_recorded")),
    (async () => {
      await ops.putPublishSummary(
        buildPublishSummary({
          version,
          previous: published.previous,
          publishedAt: now,
          beachCount: Object.keys(published.status).length,
          status: published.status,
          source: published.source,
          ...(published.target !== undefined
            ? { target: published.target }
            : {}),
          notices: published.notices,
          ...(published.jobId !== undefined ? { jobId: published.jobId } : {}),
        }),
        startedMs,
      );
      // 관측소 표는 해변 파일에서만 나옴 → 이 실행 환경에서 처음이거나 바뀌었을 때만 씀(쓰기 용량 아낌)
      // 해변 파일을 읽지 않는 실행(다시 내보내기)은 쓰지 않음
      if (!deps.beaches) return;
      const table = buildStationTable(deps.beaches);
      const text = JSON.stringify(table);
      if (writtenStationTables.get(ops) !== text) {
        await ops.putStationTable(table, now);
        writtenStationTables.set(ops, text);
      }
    })().catch(warn("publish_summary_not_recorded")),
  ]);
}

// 로그에 남기는 ID 수 상한(해변 전체가 어긋나도 한 줄이 너무 길어지지 않게)
const LOGGED_IDS = 20;

// 게시 잠금을 잡고 body를 한 번 돌린 뒤 실행 결과를 남기고 잠금을 풂
// 자동 게시·'지금 게시'·되돌리기(publishSnapshot)와 다시 내보내기(republish.ts)가 같이 씀(같은 잠금, D20-1·D16-C4)
// 다른 실행이 게시 중이면 아무것도 하지 않고 busy(실행 결과도 남기지 않음)
export async function withPublishLock(
  deps: Pick<PublishDeps, "ops" | "log" | "clock" | "owner" | "jobId">,
  source: PublishSource,
  target: string | undefined,
  body: (run: {
    startedMs: number;
    version: string;
    now: string;
  }) => Promise<PublishResult>,
): Promise<PublishResult> {
  const { ops, log } = deps;
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

  try {
    const result = await body({ startedMs, version, now });
    if (result.status !== "busy") {
      await recordPublishRun(
        deps,
        {
          at: now,
          source,
          result: result.status,
          version: result.version,
          ...(result.status === "failed" ? { reason: result.reason } : {}),
          ...(target !== undefined ? { target } : {}),
          ...(deps.jobId !== undefined ? { jobId: deps.jobId } : {}),
        },
        startedMs,
      );
    }
    return result;
  } finally {
    await ops
      .releaseLock(PUBLISH_POLICY.lockName, deps.owner)
      .catch(() => false);
  }
}

export async function publishSnapshot(
  deps: PublishDeps,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const source: PublishSource =
    options.rollbackTo !== undefined ? "rollback" : (deps.source ?? "auto");
  return withPublishLock(deps, source, options.rollbackTo, (run) =>
    runPublish(deps, options, { ...run, source }),
  );
}

// 잠금을 잡은 뒤의 게시 한 번. 잠금 해제와 실행 결과 기록은 withPublishLock이 함
async function runPublish(
  deps: PublishDeps,
  options: PublishOptions,
  run: {
    startedMs: number;
    version: string;
    now: string;
    source: PublishSource;
  },
): Promise<PublishResult> {
  const { ops, snapshots, log } = deps;
  const { startedMs, version, now, source } = run;
  const rollbackTo = options.rollbackTo;

  const fail = (reason: string, fields: Record<string, unknown> = {}) => {
    log("error", "publish_failed", { version, reason, source, ...fields });
    return { status: "failed", version, reason } as const;
  };
  const failBeachIds = (
    where: "source" | "beaches" | "status",
    problem: BeachIdProblem,
  ) =>
    fail("beach_ids", {
      where,
      missing: problem.missing.slice(0, LOGGED_IDS),
      extra: problem.extra.slice(0, LOGGED_IDS),
      duplicate: problem.duplicate.slice(0, LOGGED_IDS),
      missingCount: problem.missing.length,
      extraCount: problem.extra.length,
    });

  let uploaded = false;
  // 되돌리기가 포인터를 바꾼 뒤 manifest 교체에 실패하면 되돌려 놓을 앞 포인터
  let holdToRestore: {
    notices: NoticeHold["notices"];
    version: number;
  } | null = null;
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

    // 읽은 해변 파일이 저장소 원본 목록과 같은지(묶을 때 빠진 파일·같은 수의 다른 ID·중복)
    const sourceProblem = beachIdProblem(
      deps.beachIds,
      deps.beaches.map((beach) => beach.id),
    );
    if (sourceProblem) return failBeachIds("source", sourceProblem);

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

    // 게시 결과(해변 목록·해변 상태)도 원본 목록과 같은지. 조립 중에 해변이 빠지거나 더해지면 게시하지 않음
    const beachesProblem = beachIdProblem(
      deps.beachIds,
      snapshot.beaches.beaches.map((beach) => beach.id),
    );
    if (beachesProblem) return failBeachIds("beaches", beachesProblem);
    const statusProblem = beachIdProblem(
      deps.beachIds,
      Object.keys(snapshot.status.beaches),
    );
    if (statusProblem) return failBeachIds("status", statusProblem);

    // 공지. noticeState: 이 게시 때의 공지 상태(끝나지 않은 노출본 전부, Ops에 남김). null이면 모름
    let notices: Notice[];
    let noticeState: Notice[] | null;
    // 되돌리기에서 manifest 교체 직전에 쓸 새 포인터
    let nextHold: {
      notices: NoticeHold["notices"];
      previous: NoticeHold | null;
    } | null = null;
    if (rollbackTo !== undefined) {
      // 되돌리기는 추정하지 않음: 고른 게시본의 공지 상태나 지금 운영 DB를 읽지 못하면 하지 않음(manifest 그대로)
      const target = await ops.getPublishNotices(rollbackTo);
      if (target === null) {
        return fail("rollback_target_missing", { target: rollbackTo });
      }
      if (
        target.some((notice) => contractErrors("Notice", notice).length > 0)
      ) {
        return fail("rollback_target_invalid", { target: rollbackTo });
      }
      const previous = await ops.getNoticeHold();
      const live = currentNotices(await deps.notices(), startedMs, log);
      noticeState = currentNotices(target, startedMs, log);
      nextHold = {
        notices: noticeHoldFor(noticeState, live, rollbackTo, now),
        previous,
      };
      notices = started(noticeState, startedMs);
    } else {
      const read = await readCurrentNotices(deps, current, startedMs, version);
      notices = read.notices;
      noticeState = read.state;
    }

    // 날씨는 판단 파일과 따로 검사. 예외·계약 오류면 날씨만 빼고 알림(분류·특보 게시를 막지 않음)
    let weatherBody: string | null = null;
    try {
      const weather = buildWeather(
        deps.weatherAreas,
        deps.beaches,
        inputs.weather,
        startedMs,
        log,
      );
      const weatherErrors = contractErrors(WEATHER.contract, weather);
      if (weatherErrors.length === 0) weatherBody = JSON.stringify(weather);
      else {
        log("error", "publish_weather_contract", {
          version,
          errors: weatherErrors.slice(0, 20),
        });
      }
    } catch (error) {
      log("error", "publish_weather_failed", {
        version,
        error: error instanceof Error ? error.name : typeof error,
      });
    }

    const manifest = manifestFor(version, now, notices, weatherBody !== null);
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
    // 되돌리기는 되돌릴 것이 있으면 내용이 같아 보여도 새 버전으로 게시함(포인터를 남겨야 다음 자동 게시가 따름, D20-1)
    // 포인터도 게시 내용도 지금과 같을 때만 생략함(같은 되돌리기를 다시 부른 경우. 사용자 결정 2026-11-12)
    const nothingToRollBack =
      nextHold === null ||
      sameHeldNotices(nextHold.notices, nextHold.previous?.notices ?? {});
    if (
      nothingToRollBack &&
      (await sameAsCurrent(snapshots, current, bodies, notices, weatherBody))
    ) {
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
      ...(weatherBody === null
        ? []
        : [
            snapshots.putFile(
              versionPath(version, WEATHER.name),
              weatherBody,
              versioned,
            ),
          ]),
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

    // 되돌리기: manifest를 바꾸기 직전에 포인터를 먼저 씀. 순서가 반대면 포인터 쓰기만 실패했을 때
    // 다음 자동 게시가 되돌린 공지를 다시 내보냄. manifest 교체가 실패하면 finally가 앞 포인터로 되돌려 놓음
    // 읽은 뒤 포인터가 바뀌었으면('다시 적용'·다른 되돌리기) 덮지 않고 멈춤
    if (nextHold) {
      const expected = nextHold.previous?.version ?? 0;
      const restore = {
        notices: nextHold.previous?.notices ?? {},
        version: expected + 1,
      };
      let written: boolean;
      try {
        written = await ops.putNoticeHold(nextHold.notices, expected, now);
      } catch (error) {
        // 실제로는 쓰였는데 응답만 실패했을 수 있음 → 다시 읽어 이 실행이 쓴 값이면 되돌려 놓을 대상으로 둠
        // 다시 읽지도 못하면 포인터가 어느 쪽인지 모름 → 알림(그대로면 다음 자동 게시가 공지를 되돌려 게시함)
        const after = await ops.getNoticeHold().catch(() => undefined);
        if (after === undefined) {
          log("error", "rollback_hold_unknown", {
            version,
            target: rollbackTo,
          });
        } else if (
          after?.version === restore.version &&
          canonical(after.notices) === canonical(nextHold.notices)
        ) {
          holdToRestore = restore;
        }
        throw error;
      }
      if (!written) return fail("hold_conflict", { target: rollbackTo });
      holdToRestore = restore;
    }

    const replaced = await replaceManifest(deps, version, manifestBody);
    if (!replaced.ok) {
      return replaced.reason === "version_not_newer"
        ? fail(replaced.reason, { published: replaced.published })
        : fail(replaced.reason);
    }
    uploaded = false; // manifest가 이 버전을 가리킴 → 지우면 안 됨

    // 잠금 안에서는 생기지 않아야 함. manifest는 이미 바뀌었으므로 알리기만 함
    // 예외도 같게 봄: 여기서 던지면 이미 끝난 게시가 failed로 잘못 보고됨
    if (!(await ops.setPublishedVersion(version).catch(() => false))) {
      log("error", "publish_version_not_recorded", { version });
    }
    await recordPublished(deps, {
      version,
      previous: published,
      now,
      startedMs,
      status: snapshot.status.beaches,
      source,
      target: rollbackTo,
      noticeState,
      notices,
      jobId: deps.jobId,
    });
    const removed = await removeOldVersions(snapshots, version, log);
    log("info", "publish_finished", {
      version,
      source,
      beaches: deps.beaches.length,
      removed: removed.length,
      ...(rollbackTo !== undefined ? { target: rollbackTo } : {}),
    });
    return { status: "published", version, removed };
  } catch (error) {
    return fail(
      `exception:${error instanceof Error ? error.name : typeof error}`,
    );
  } finally {
    // manifest를 바꾸기 전에 멈춘 업로드는 지움(보존 48개 자리를 차지하지 않게). 실패해도 다음 정리가 지움
    // manifest 쓰기가 실제로는 됐는데 응답만 실패했을 수 있음 → manifest가 이 버전을 가리키거나 읽지 못하면 지우지 않음
    const landed = uploaded && (await manifestMayPointTo(snapshots, version));
    // manifest를 읽지 못해 게시됐는지 모르는 되돌리기: 포인터를 되돌려 놓지 않음(게시됐다면 그 표시가 맞음)
    // 결과는 실패로 나가지만 포인터는 새 값이라, 그대로면 다음 자동 게시가 공지를 되돌려 게시함 → 알림
    if (landed && holdToRestore) {
      log("error", "rollback_hold_unknown", { version, target: rollbackTo });
    }
    if (uploaded && !landed) {
      await snapshots.deleteVersion(version).catch(() => undefined);
      // 게시되지 않은 되돌리기의 포인터를 앞 값으로 되돌려 놓음. 못 하면 알림
      // (그대로 남으면 다음 자동 게시가 이 포인터대로 공지를 되돌려 게시함)
      if (holdToRestore) {
        const restored = await ops
          .putNoticeHold(holdToRestore.notices, holdToRestore.version, now)
          .catch(() => false);
        if (!restored) {
          log("error", "rollback_hold_not_restored", {
            version,
            target: rollbackTo,
          });
        }
      }
    }
  }
}
