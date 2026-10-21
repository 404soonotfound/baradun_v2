import type { ManifestFile } from "@baradun/contracts";

import {
  clockFromHeaders,
  correctedNow,
  DEVICE_CLOCK,
  expiryDeadline,
  isExpired,
  type Clock,
} from "./clock";
import { METRIC_KEYS, type ViewSource } from "./view";

// 바다 정보 조회·갱신 (아키텍처 9.1·그림 2, BRD-41)
// manifest를 먼저 받고 snapshotVersion이 바뀔 때만 status를 받음.
// 다시 받는 때: 처음 열 때 · 앱 복귀 · 당겨서 새로고침/다시 시도 · validUntil 만료 · 열어 둔 동안 5분마다(안 보이면 멈춤).
// 바다 정보는 항상 네트워크 먼저, 못 받을 때만 마지막 값(기기 저장)을 꺼냄.
// React와 브라우저 API는 deps로 받아서 테스트에서 가짜로 바꿔 끼움.

// 이 화면이 읽을 수 있는 계약 버전
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];
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
  // 마지막 조회 성공 시각(보정된 시각, ms)
  checkedAtMs: number | null;
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
  isVisible: () => boolean;
  // 화면이 보이게 되거나 숨겨질 때 부를 함수 등록. 해제 함수를 돌려줌
  onVisibilityChange: (listener: () => void) => () => void;
}

export interface SnapshotStore {
  getState: () => SnapshotState;
  subscribe: (listener: () => void) => () => void;
  // 당겨서 새로고침·다시 시도
  refresh: () => Promise<void>;
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
  checkedAtMs: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safe<T>(run: () => T): T | null {
  try {
    return run();
  } catch {
    return null;
  }
}

// manifest 모양 확인. 브라우저에서 스키마 검사기(ajv)를 돌리지 않고 쓰는 필드만 확인함
function readManifest(value: unknown): ManifestFile | "unsupported" | null {
  if (!isRecord(value)) return null;
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(value.schemaVersion as number)) {
    return "unsupported";
  }
  const files = value.files;
  const maintenance = value.maintenance;
  if (
    typeof value.snapshotVersion !== "string" ||
    !isRecord(files) ||
    typeof files.status !== "string" ||
    !isRecord(maintenance) ||
    typeof maintenance.active !== "boolean"
  ) {
    return null;
  }
  return value as unknown as ManifestFile;
}

function readStatuses(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.beaches) ? value.beaches : null;
}

export function createSnapshotStore(deps: SnapshotDeps): SnapshotStore {
  let state: SnapshotState = INITIAL_STATE;
  // status를 받아 둔 snapshotVersion. status 받기에 실패하면 그대로라 다음 조회 때 다시 받음
  let loadedVersion: string | null = null;
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

  function now(clock: Clock = state.clock) {
    return correctedNow(clock, deps.now());
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

    deadlineTimer = setTimeout(onDeadline, Math.max(0, next - now()));
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
    if (newlyExpired) void refresh();
  }

  // 메모리에 값이 없으면 기기에 저장해 둔 마지막 값을 꺼냄. 서버 시각은 모르는 것으로 둠.
  // live: false라 B5 규칙(발효 특보 배지 유지, 나머지는 특보 확인 못 함)으로 보임
  function showStored() {
    if (state.statuses) return;
    const stored = safe(() =>
      JSON.parse(deps.storage?.getItem(LAST_SNAPSHOT_KEY) ?? "null"),
    );
    const manifest = isRecord(stored) ? readManifest(stored.manifest) : null;
    const statuses = isRecord(stored) ? readStatuses(stored.status) : null;
    if (!manifest || manifest === "unsupported" || !statuses) return;
    set({
      phase: state.phase === "loading" ? "ready" : state.phase,
      manifest,
      statuses,
      clock: DEVICE_CLOCK,
      live: false,
      nowMs: now(DEVICE_CLOCK),
    });
  }

  function fail() {
    showStored();
    const { manifest, statuses, clock } = state;
    set({
      // 점검 화면은 그대로 덮어 둠. 처음부터 못 받았으면 데이터 없이 판단불가
      phase: state.phase === "maintenance" ? "maintenance" : "ready",
      manifest,
      statuses,
      clock,
      live: false,
      nowMs: now(clock),
    });
  }

  function unsupported() {
    const reloaded = safe(() => deps.session?.getItem(SCHEMA_RELOAD_KEY));
    if (reloaded !== "1") {
      // 새 화면 파일이 나왔을 수 있어 한 번만 새로고침. 기록을 못 남기면 새로고침하지 않음
      const recorded = safe(() => {
        deps.session?.setItem(SCHEMA_RELOAD_KEY, "1");
        return deps.session?.getItem(SCHEMA_RELOAD_KEY) === "1";
      });
      if (recorded) {
        deps.reload();
        return;
      }
    }
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
    try {
      // no-cache: 브라우저 캐시를 쓰더라도 매번 서버에 바뀌었는지 확인
      const { response, body } = await fetchJson(MANIFEST_URL, {
        cache: "no-cache",
      });
      clock = clockFromHeaders(
        response.headers.get("date"),
        response.headers.get("age"),
        deps.now(),
      );
      manifest = readManifest(body);
    } catch {
      return fail();
    }
    if (manifest === "unsupported") return unsupported();
    if (!manifest) return fail();
    safe(() => deps.session?.removeItem(SCHEMA_RELOAD_KEY));

    // 점검 중이면 마지막 값도 숨김(화면이 전체를 덮음, 9.1)
    if (manifest.maintenance.active) {
      return set({
        phase: "maintenance",
        manifest,
        live: true,
        clock,
        nowMs: now(clock),
        checkedAtMs: now(clock),
      });
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
      if (!statuses) return fail();
      loadedVersion = manifest.snapshotVersion;
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
      nowMs: now(clock),
      checkedAtMs: now(clock),
    });
  }

  // 겹쳐 부르면 진행 중인 조회 하나로 합침
  function refresh(): Promise<void> {
    inFlight ??= run().finally(() => {
      inFlight = null;
    });
    return inFlight;
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
    start,
    stop,
  };
}
