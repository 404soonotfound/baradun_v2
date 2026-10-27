import type { ManifestFile } from "@baradun/contracts";

import {
  clockFromHeaders,
  CLOCK_TOLERANCE_MS,
  correctedNow,
  DEVICE_CLOCK,
  expiryDeadline,
  isExpired,
  isTime,
  type Clock,
} from "./clock";
import {
  hidesLastValues,
  isRecord,
  METRIC_KEYS,
  type ViewSource,
} from "./view";

// 바다 정보 조회·갱신 (아키텍처 9.1·그림 2, BRD-41)
// manifest를 먼저 받고 snapshotVersion이 바뀔 때만 status를 받음.
// 다시 받는 때: 처음 열 때 · 앱 복귀 · 당겨서 새로고침/다시 시도 · validUntil 만료 · 열어 둔 동안 5분마다(안 보이면 멈춤).
// 바다 정보는 항상 네트워크 결과로 정함. 메모리에 값이 없을 때(첫 실행 등)만 응답을 기다리는 동안 기기에 저장된
// 마지막 값을 B5 규칙(live: false — 발효 특보 배지 유지, 나머지는 특보 확인 못 함)으로 먼저 보여주고, 응답이 오면 바꿈.
// 못 받으면 지금 보여주는 값(없으면 저장된 마지막 값)을 B5로 둠.
// React와 브라우저 API는 deps로 받아서 테스트에서 가짜로 바꿔 끼움.

// 이 화면이 읽을 수 있는 계약 버전
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];
// 스냅샷 버전 형식(계약). 이 형식이라 글자순 = 시간순
const SNAPSHOT_VERSION_PATTERN = /^[0-9]{8}T[0-9]{6}Z$/;
// 같은 출처의 상대 주소만 읽음(17.2 이식성 원칙)
export const MANIFEST_URL = "/data/manifest.json";
export const POLL_INTERVAL_MS = 5 * 60_000;
// 요청 하나(manifest·status 각각)의 시간 제한. 응답이 멈춘 망(캡티브 포털 등)에서도 실패로 끝내 다음 조회가 막히지 않게 함
export const REQUEST_TIMEOUT_MS = 10_000;

// 마지막으로 받은 manifest·status. 오프라인으로 앱을 열었을 때 꺼냄
const LAST_SNAPSHOT_KEY = "baradun:last-snapshot";
// 지원 밖 schemaVersion일 때 자동 새로고침을 이미 했는지(이 브라우저 탭 안에서만)
const SCHEMA_RELOAD_KEY = "baradun:schema-reload";

export interface SnapshotState extends ViewSource {
  manifest: ManifestFile | null;
}

export type KeyValueStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export interface SnapshotDeps {
  fetch: typeof fetch;
  // 기기 시각(ms)
  now: () => number;
  // localStorage. 못 쓰면 null
  storage: KeyValueStorage | null;
  // sessionStorage. 못 쓰면 null → 자동 새로고침 안 함(무한 새로고침 방지)
  session: KeyValueStorage | null;
  reload: () => void;
  // 이 화면 빌드의 버전 번호(build.ts WEB_BUILD). manifest.minWebBuild보다 낮으면 강제 업데이트 상태(자동 새로고침 없음)
  webBuild: number;
  isVisible: () => boolean;
  // 화면이 보이게 되거나 숨겨질 때 부를 함수 등록. 해제 함수를 돌려줌
  onVisibilityChange: (listener: () => void) => () => void;
}

export interface SnapshotStore {
  getState: () => SnapshotState;
  subscribe: (listener: () => void) => () => void;
  // 당겨서 새로고침·다시 시도
  refresh: () => Promise<void>;
  // 조회 없이 지금 시각으로 화면만 다시 계산(전국 특보 45분 만료 등 store 밖 만료 시각)
  recompute: () => void;
  // 첫 구독 때 시작, 마지막 구독 해제 때 멈춤
  start: () => void;
  stop: () => void;
}

export const INITIAL_STATE: SnapshotState = {
  phase: "loading",
  manifest: null,
  statuses: null,
  live: false,
  clock: DEVICE_CLOCK,
  nowMs: 0,
};

function safe<T>(run: () => T): T | null {
  try {
    return run();
  } catch {
    return null;
  }
}

// 현재 스냅샷의 status 경로. 같은 출처 상대 주소 + 이 snapshotVersion 폴더만 허용
export function statusPath(snapshotVersion: string): string {
  return `/data/${snapshotVersion}/status.json`;
}

// manifest 모양 확인. 브라우저에서 스키마 검사기(ajv)를 돌리지 않고 쓰는 필드만 확인함.
// status 경로가 이 snapshotVersion을 가리키지 않으면(배포 중 이전 경로·외부 주소) 읽지 못한 것으로 봄:
// 다른 스냅샷의 상태를 현재 값으로 저장·표시하지 않게
function readManifest(value: unknown): ManifestFile | "unsupported" | null {
  if (!isRecord(value)) return null;
  // 정수 버전일 때만 '지원 밖 형식'(새로고침 대상). 버전이 없거나 숫자가 아니면(캡티브 포털·프록시 오류 응답 등)
  // 그냥 못 읽은 것 → 실패 경로(B5)
  if (!Number.isInteger(value.schemaVersion)) return null;
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(value.schemaVersion as number)) {
    return "unsupported";
  }
  const files = value.files;
  const maintenance = value.maintenance;
  if (
    typeof value.snapshotVersion !== "string" ||
    !SNAPSHOT_VERSION_PATTERN.test(value.snapshotVersion) ||
    !isTime(value.generatedAt) ||
    !isRecord(files) ||
    files.status !== statusPath(value.snapshotVersion) ||
    !isRecord(maintenance) ||
    typeof maintenance.active !== "boolean" ||
    // 최소 화면 버전을 못 읽으면 이 화면이 읽어도 되는 데이터인지 모름 → 못 읽은 것(B5)
    !Number.isInteger(value.minWebBuild) ||
    (value.minWebBuild as number) < 0
  ) {
    return null;
  }
  return value as unknown as ManifestFile;
}

// 보정된 시각이 게시 시각(generatedAt)보다 2분 넘게 이른지 = 그 시계가 틀린 게 확실함
function isBeforePublished(nowMs: number, manifest: ManifestFile): boolean {
  return nowMs < Date.parse(manifest.generatedAt) - CLOCK_TOLERANCE_MS;
}

function readStatuses(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.beaches) ? value.beaches : null;
}

export function createSnapshotStore(deps: SnapshotDeps): SnapshotStore {
  let state: SnapshotState = INITIAL_STATE;
  // status를 받아 둔 snapshotVersion. status 받기에 실패하면 그대로라 다음 조회 때 다시 받음
  let loadedVersion: string | null = null;
  // 이번 세션에 네트워크로 받은 manifest 중 가장 새 snapshotVersion(점검·status 실패 포함)
  let latestVersion: string | null = null;
  // 이 탭이 마지막으로 정상 수신한 manifest·status(메모리). 점검·강제 업데이트로 상태에서 비운 뒤 그 화면이 풀렸는데
  // status만 실패하면 여기서 B5로 복구함(localStorage를 못 쓰는 환경에서도 발효 특보 배지를 잃지 않게)
  let lastLive: {
    manifest: ManifestFile;
    statuses: Record<string, unknown>;
  } | null = null;
  let inFlight: Promise<void> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let unwatchVisibility: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function set(next: Partial<SnapshotState>) {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
    scheduleDeadline();
  }

  // 보정된 지금 시각. 서버 시각을 모르는데 기기 시각이 게시 시각(generatedAt)보다 2분 넘게 이르면
  // 기기 시계가 틀린 게 확실하므로 NaN(지금 시각 모름 → 모두 만료, clock.ts isExpired)
  function now(
    clock: Clock = state.clock,
    manifest: ManifestFile | null = state.manifest,
  ) {
    const nowMs = correctedNow(clock, deps.now());
    if (!clock.trusted && manifest && isBeforePublished(nowMs, manifest)) {
      return NaN;
    }
    return nowMs;
  }

  // 다음 만료 시각(validUntil·지표별 expiresAt 중 가장 이른 미래)에 화면을 다시 계산.
  // validUntil이 지났으면 바로 판단불가로 바뀌고(view.ts) 새 스냅샷을 조회함
  function scheduleDeadline() {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    deadlineTimer = null;
    if (!unwatchVisibility || !deps.isVisible() || !state.statuses) return;

    let next = Infinity;
    const consider = (expiresAt: unknown) => {
      const at = expiryDeadline(expiresAt as string | null, state.clock);
      if (at !== null && at > state.nowMs && at < next) next = at;
    };
    for (const status of Object.values(state.statuses)) {
      if (!isRecord(status)) continue;
      consider(status.validUntil);
      const metrics = isRecord(status.observation)
        ? status.observation.metrics
        : null;
      if (isRecord(metrics)) {
        for (const key of METRIC_KEYS) {
          const metric = metrics[key];
          if (isRecord(metric)) consider(metric.expiresAt);
        }
      }
    }
    if (next === Infinity) return;

    // 최대 5분 뒤에 깨어나 다시 계산. 먼 미래 값(잘못된 데이터·틀린 기기 시계)으로 setTimeout 한도(약 24.8일)를
    // 넘기면 즉시 실행돼 끝없이 반복되는 문제를 막음
    const delay = Math.min(Math.max(0, next - now()), POLL_INTERVAL_MS);
    if (!Number.isFinite(delay)) return;
    deadlineTimer = setTimeout(onDeadline, delay);
  }

  function onDeadline() {
    const before = state.nowMs;
    const nowMs = now();
    const statuses = Object.values(state.statuses ?? {});
    // 이번에 새로 만료된 validUntil이 있는지(이미 만료된 건 다시 조회하지 않아 반복 조회를 막음)
    const newlyExpired = statuses.some(
      (status) =>
        isRecord(status) &&
        !isExpired(status.validUntil as string, before, state.clock) &&
        isExpired(status.validUntil as string, nowMs, state.clock),
    );
    set({ nowMs });
    if (!newlyExpired) return;
    // 만료 전에 시작한 조회가 진행 중이면 거기에 합치지 않고, 끝난 뒤 한 번 더 조회
    // 진행 중 조회가 실패(reject)해도 처리 안 된 오류로 남지 않게 catch 후 다시 조회
    if (inFlight) {
      void inFlight
        .catch(() => {})
        .then(() => refresh())
        .catch(() => {});
    } else void refresh();
  }

  // 기기에 저장해 둔 마지막 값. 없거나 읽을 수 없으면 null
  function readStoredSnapshot() {
    const stored = safe(() =>
      JSON.parse(deps.storage?.getItem(LAST_SNAPSHOT_KEY) ?? "null"),
    );
    const manifest = isRecord(stored) ? readManifest(stored.manifest) : null;
    const statuses = isRecord(stored) ? readStatuses(stored.status) : null;
    if (!manifest || manifest === "unsupported" || !statuses) return null;
    return { manifest, statuses };
  }

  // 메모리에 값이 없으면 마지막 정상 수신값(이 탭 메모리 → 기기 저장)을 꺼냄. 서버 시각은 모르는 것으로 둠.
  // live: false라 B5 규칙(발효 특보 배지 유지, 나머지는 특보 확인 못 함)으로 보임
  // 점검·강제 업데이트 화면을 보이는 중에는 꺼내지 않음(상태에 지난 값을 들고 있지 않게).
  // evenIfHidden: 새 manifest가 그 화면을 풀었는데 status만 실패한 경우(fail)는 꺼냄
  function showStored(evenIfHidden = false) {
    if (state.statuses) return;
    if (!evenIfHidden && hidesLastValues(state.phase)) return;
    const last = lastLive ?? readStoredSnapshot();
    if (!last) return;
    const { manifest, statuses } = last;
    // 더 새 화면이 저장한 값(minWebBuild가 이 빌드보다 높음)은 이 화면이 잘못 읽을 수 있어 꺼내지 않음(9.1)
    if (manifest.minWebBuild > deps.webBuild) return;
    set({
      phase: state.phase === "loading" ? "ready" : state.phase,
      manifest,
      statuses,
      clock: DEVICE_CLOCK,
      live: false,
      nowMs: now(DEVICE_CLOCK, manifest),
    });
  }

  // fresh: 이번 조회에서 manifest를 받아 서버 시각을 알았으면 그 시계(status 실패여도 버리지 않음)
  // manifestOk: 이번 manifest가 지원 형식이고 점검 중이 아니며 이 화면 빌드가 읽어도 됨을 확인함(status만 실패)
  // → 점검 화면·강제 업데이트·지원 밖 형식 배너를 풀고 B5로(마지막 발효 특보 배지가 사라지지 않게)
  function fail(fresh?: Clock, manifestOk = false) {
    const clock = fresh ?? state.clock;
    const keep = !manifestOk && hidesLastValues(state.phase);
    // 점검·강제 업데이트 화면을 유지하는 동안은 저장된 값도 꺼내지 않음(상태에 지난 값을 들고 있지 않게)
    if (!keep) showStored(true);
    set({
      // 점검 화면·강제 업데이트·지원 밖 형식 배너는 그대로 둠. 처음부터 못 받았으면 데이터 없이 판단불가
      phase: keep ? state.phase : "ready",
      clock,
      live: false,
      nowMs: now(clock),
    });
  }

  // 같은 표시(mark)마다 이 브라우저 탭에서 한 번만 새로고침(9.1 '자동 새로고침 1회'). 기록은 새로고침한 표시 목록(쉼표 구분)이라
  // 버전 전환 중 v1·v2 또는 v2·v3가 번갈아 와도 반복하지 않고, 처음 보는 표시가 나오면 다시 한 번 새로고침함
  // 새로고침했으면 true. 기록을 못 남기면 새로고침하지 않고 false(무한 새로고침 방지)
  function reloadOnce(key: string, mark: string): boolean {
    const reloaded = safe(() => deps.session?.getItem(key)) ?? "";
    const marks = reloaded ? reloaded.split(",") : [];
    if (marks.includes(mark)) return false;
    const next = [...marks, mark].join(",");
    const recorded = safe(() => {
      deps.session?.setItem(key, next);
      return deps.session?.getItem(key) === next;
    });
    if (!recorded) return false;
    deps.reload();
    return true;
  }

  // 지원 밖 schemaVersion: 새 화면 파일이 나왔을 수 있어 버전마다 한 번 새로고침, 그래도 안 되면 판단불가 배너
  function unsupported(version: number) {
    if (reloadOnce(SCHEMA_RELOAD_KEY, String(version))) return;
    set({ phase: "schema_unsupported", live: false, nowMs: now() });
  }

  // 응답 받기 + 본문 읽기를 합쳐 10초 제한. 넘으면 요청을 끊고(abort) 실패로 끝냄.
  // fetch가 abort를 무시해도 race로 반드시 끝나서 inFlight가 풀림
  async function fetchJson(url: string, init?: RequestInit) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${url}: ${REQUEST_TIMEOUT_MS}ms 시간 초과`));
      }, REQUEST_TIMEOUT_MS);
    });
    const request = (async () => {
      const response = await deps.fetch(url, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return { response, body: (await response.json()) as unknown };
    })();
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
      // 시간 초과로 버려진 요청이 나중에 실패해도 처리 안 된 오류로 남지 않게
      request.catch(() => {});
    }
  }

  async function run() {
    // 첫 실행: 응답을 기다리지 않고 저장된 마지막 값부터 보여줌(B5). 응답이 오면 아래에서 교체
    showStored();
    let manifest: ManifestFile | "unsupported" | null;
    let clock: Clock;
    let body: unknown;
    try {
      // no-cache: 브라우저 캐시를 쓰더라도 매번 서버에 바뀌었는지 확인
      const result = await fetchJson(MANIFEST_URL, { cache: "no-cache" });
      const { response } = result;
      body = result.body;
      clock = clockFromHeaders(
        response.headers.get("date"),
        response.headers.get("age"),
        deps.now(),
      );
      manifest = readManifest(body);
    } catch {
      return fail();
    }
    // "unsupported"는 정수 schemaVersion일 때만 나옴(readManifest)
    if (manifest === "unsupported") {
      return unsupported((body as { schemaVersion: number }).schemaVersion);
    }
    // 읽을 수 없는 응답(캡티브 포털·프록시 오류 등)의 Date 헤더는 우리 서버 시각이 아닐 수 있어 쓰지 않음
    if (!manifest) return fail();
    // 자동 새로고침 기록은 지우지 않음: 버전 전환 중 엣지가 v1·v2를 번갈아 주면 새로고침이 반복되므로
    // 같은 버전으로는 이 브라우저 탭에서 한 번만(unsupported)

    // 서버 시각이 게시 시각보다 2분 넘게 이르면(캐시가 오래된 응답을 Age 없이 다시 내준 경우 등) 서버 시각을 믿지 않음
    const distrustBefore = (published: ManifestFile | null) => {
      if (
        clock.trusted &&
        published &&
        isBeforePublished(correctedNow(clock, deps.now()), published)
      ) {
        clock = DEVICE_CLOCK;
      }
    };
    distrustBefore(manifest);

    // 이번 세션에 네트워크로 받은 것보다 이전 스냅샷(CDN 엣지·캐시 차이)이면 무시하고 지금 값을 유지.
    // 발효 특보가 이전 스냅샷의 '특보 없음'으로 덮이지 않게. 버전 형식(20261017T053000Z)은 글자순 = 시간순.
    // 기기에 저장된 버전과는 비교하지 않음: publisher가 버전을 되돌리면 그 기기가 서버 응답을 계속 버리게 됨.
    // status까지 받은 버전(loadedVersion)이 아니라 받은 manifest 중 가장 새 버전과 비교함:
    // 새 버전이 점검 중이거나 그 status를 못 받았을 때 이전 스냅샷이 점검을 풀거나 live로 되살리지 않게
    if (latestVersion && manifest.snapshotVersion < latestVersion) {
      // 이번 응답으로 안 서버 시각은 반영(저장된 값을 기기 시계로 보던 중이면 보정됨).
      // 단 이전 스냅샷 응답이라 시각이 늦을 수 있어, 지금 보여주는 manifest 게시 시각보다 이르면 믿지 않음
      distrustBefore(state.manifest);
      return set({ clock, nowMs: now(clock) });
    }
    latestVersion = manifest.snapshotVersion;

    // 화면 빌드가 최소 버전보다 낮음 → 이전 화면이 새 데이터를 잘못 읽을 수 있어 값을 숨김(9.1)
    // 자동으로 새로고침하지 않음(2026-10-26 사용자 결정): 입력 중 화면이 사라지거나 새로고침이 반복될 수 있음
    // 강제 업데이트 화면(L15, BRD-38)의 버튼이 window.location.reload()를 부름. 사이트 HTML은 max-age=0이라 새 화면을 받음
    // 점검보다 먼저 봄: 새 화면이 점검 여부를 다시 확인함
    if (manifest.minWebBuild > deps.webBuild) {
      return hideAll("update_required", manifest, clock);
    }

    // 점검 중이면 마지막 값도 숨김(화면이 전체를 덮음, 9.1)
    if (manifest.maintenance.active) {
      return hideAll("maintenance", manifest, clock);
    }

    let statuses = state.statuses;
    if (manifest.snapshotVersion !== loadedVersion || !statuses) {
      try {
        // 버전 경로라 내용이 바뀌지 않음 → 브라우저 캐시 그대로 사용
        const { body } = await fetchJson(manifest.files.status);
        statuses = readStatuses(body);
      } catch {
        statuses = null;
      }
      if (!statuses) return fail(clock, true);
      loadedVersion = manifest.snapshotVersion;
      lastLive = { manifest, statuses };
      const snapshot = { manifest, status: { beaches: statuses } };
      safe(() =>
        deps.storage?.setItem(LAST_SNAPSHOT_KEY, JSON.stringify(snapshot)),
      );
    }

    set({
      phase: "ready",
      manifest,
      statuses,
      live: true,
      clock,
      nowMs: now(clock, manifest),
    });
  }

  // 화면 전체를 덮는 상태로 바꿈. 지난 statuses는 상태에서 비움(다른 소비자가 지난 값을 읽지 않고, 만료 타이머도 돌지 않게)
  // loadedVersion은 두지만 statuses가 없으면 다음 조회가 status를 다시 받음
  function hideAll(
    phase: "update_required" | "maintenance",
    manifest: ManifestFile,
    clock: Clock,
  ) {
    set({
      phase,
      manifest,
      statuses: null,
      live: true,
      clock,
      nowMs: now(clock, manifest),
    });
  }

  // 겹쳐 부르면 진행 중인 조회 하나로 합침
  function refresh(): Promise<void> {
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function recompute() {
    set({ nowMs: now() });
  }

  function resume() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    // 안 보이는 동안 만료 타이머가 멈춰 있었음. 응답을 기다리지 않고 지금 시각으로 먼저 다시 계산
    // (그사이 지난 validUntil은 바로 판단불가로 보임)
    if (state.statuses) set({ nowMs: now() });
    void refresh();
  }

  function pause() {
    if (pollTimer) clearInterval(pollTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    pollTimer = null;
    deadlineTimer = null;
  }

  function start() {
    if (unwatchVisibility) return;
    unwatchVisibility = deps.onVisibilityChange(() => {
      if (deps.isVisible())
        resume(); // 앱 복귀
      else pause();
    });
    if (deps.isVisible()) resume(); // 처음 열 때
  }

  function stop() {
    unwatchVisibility?.();
    unwatchVisibility = null;
    pause();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    recompute,
    start,
    stop,
  };
}
