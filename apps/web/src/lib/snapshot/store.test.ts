import { readFileSync } from "node:fs";

import type { ManifestFile, StatusFile } from "@baradun/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSnapshotStore,
  MANIFEST_URL,
  POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  type KeyValueStorage,
  type SnapshotDeps,
} from "./store";
import { DEVICE_CLOCK } from "./clock";
import { deriveBeachView } from "./view";

// 조회·갱신 검사 (BRD-41, 아키텍처 9.1·그림 2). 가짜 서버·가짜 타이머로 돌림

const read = <T>(name: string) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../../../packages/contracts/examples/valid/${name}`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as T;

const manifestExample = read<ManifestFile>("manifest.json");
const statusExample = read<StatusFile>("status.json");
const DEVICE_START = Date.parse("2026-10-17T05:30:00Z");

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

// 가짜 서버: manifest·status 응답을 테스트마다 바꿈
function fakeServer() {
  const server = {
    manifest: structuredClone(manifestExample) as unknown,
    status: structuredClone(statusExample) as unknown,
    // 서버 시각 - 기기 시각(ms). Date 헤더에 반영
    skewMs: 0,
    sendDate: true,
    down: false,
    statusDown: false,
    // 응답이 끝나지 않음(멈춘 망). 실제 fetch처럼 abort되면 실패함
    hang: false,
    // abort도 무시하고 끝나지 않음(최악의 경우)
    ignoreAbort: false,
    // status 요청만 끝나지 않음
    hangStatus: false,
    calls: [] as string[],
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      server.calls.push(url);
      if (server.hang || (server.hangStatus && url !== MANIFEST_URL)) {
        return new Promise<Response>((_, reject) => {
          if (server.ignoreAbort) return;
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }
      if (server.down) throw new TypeError("Failed to fetch");
      const headers = new Headers();
      if (server.sendDate) {
        headers.set("date", new Date(Date.now() + server.skewMs).toUTCString());
      }
      if (url === MANIFEST_URL) {
        return new Response(JSON.stringify(server.manifest), { headers });
      }
      if (server.statusDown) return new Response("", { status: 503 });
      return new Response(JSON.stringify(server.status), { headers });
    }),
  };
  return server;
}

function setup(
  options: {
    server?: ReturnType<typeof fakeServer>;
    storage?: ReturnType<typeof memoryStorage>;
    session?: ReturnType<typeof memoryStorage>;
  } = {},
) {
  const server = options.server ?? fakeServer();
  const storage = options.storage ?? memoryStorage();
  const session = options.session ?? memoryStorage();
  let visible = true;
  const visibilityListeners = new Set<() => void>();
  const reload = vi.fn();
  const deps: SnapshotDeps = {
    fetch: server.fetch as unknown as typeof fetch,
    now: () => Date.now(),
    storage,
    session,
    reload,
    isVisible: () => visible,
    onVisibilityChange(listener) {
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
  };
  const store = createSnapshotStore(deps);
  const setVisible = (next: boolean) => {
    visible = next;
    visibilityListeners.forEach((listener) => listener());
  };
  const manifestCalls = () =>
    server.calls.filter((url) => url === MANIFEST_URL).length;
  const statusCalls = () =>
    server.calls.filter((url) => url.endsWith("/status.json")).length;
  return {
    server,
    storage,
    session,
    store,
    reload,
    setVisible,
    manifestCalls,
    statusCalls,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: DEVICE_START });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("manifest 먼저, 바뀔 때만 status", () => {
  it("처음 열 때 manifest → status 순서로 받음", async () => {
    const { store, server } = setup();
    store.start();
    await store.refresh();
    expect(server.calls).toEqual([MANIFEST_URL, manifestExample.files.status]);
    expect(store.getState()).toMatchObject({ phase: "ready", live: true });
  });

  it("snapshotVersion이 같으면 status를 다시 받지 않음", async () => {
    const { store, manifestCalls, statusCalls } = setup();
    store.start();
    await store.refresh();
    await store.refresh();
    expect(manifestCalls()).toBe(2);
    expect(statusCalls()).toBe(1);
  });

  it("snapshotVersion이 바뀌면 status를 받음", async () => {
    const { store, server, statusCalls } = setup();
    store.start();
    await store.refresh();
    server.manifest = {
      ...manifestExample,
      snapshotVersion: "20261017T060000Z",
      files: {
        ...manifestExample.files,
        status: "/data/20261017T060000Z/status.json",
      },
    };
    await store.refresh();
    expect(statusCalls()).toBe(2);
    expect(server.calls.at(-1)).toBe("/data/20261017T060000Z/status.json");
  });

  it("status를 못 받았으면 같은 버전이어도 다음 조회 때 다시 받음", async () => {
    const { store, server, statusCalls } = setup();
    server.statusDown = true;
    store.start();
    await store.refresh();
    expect(store.getState().live).toBe(false);
    server.statusDown = false;
    await store.refresh();
    expect(statusCalls()).toBe(2);
    expect(store.getState().live).toBe(true);
  });

  it("점검 중이면 점검 상태(status 받지 않음)", async () => {
    const { store, server, statusCalls } = setup();
    server.manifest = {
      ...manifestExample,
      maintenance: { active: true, until: null },
    };
    store.start();
    await store.refresh();
    expect(store.getState().phase).toBe("maintenance");
    expect(statusCalls()).toBe(0);
  });
});

describe("갱신 시점", () => {
  it("열어 둔 동안 5분마다 manifest 확인", async () => {
    const { store, manifestCalls } = setup();
    store.start();
    await store.refresh();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(manifestCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(manifestCalls()).toBe(3);
  });

  it("화면이 안 보이면 멈추고, 돌아오면 바로 확인", async () => {
    const { store, setVisible, manifestCalls } = setup();
    store.start();
    await store.refresh();
    setVisible(false);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(manifestCalls()).toBe(1);
    setVisible(true);
    await store.refresh();
    expect(manifestCalls()).toBe(2);
  });

  it("안 보이는 동안 validUntil이 지났으면 복귀 즉시 판단불가(응답을 기다리지 않음)", async () => {
    const { store, server, setVisible } = setup();
    store.start();
    await store.refresh();
    setVisible(false);
    // 예시 validUntil 06:03:40을 넘겨 06:10에 복귀, 응답은 오지 않음
    vi.setSystemTime(Date.parse("2026-10-17T06:10:00Z"));
    server.hang = true;
    setVisible(true);
    expect(
      deriveBeachView({ id: "b0001", hidden: false }, store.getState()),
    ).toMatchObject({
      category: "undetermined",
      badge: { kind: "warning_unknown" },
    });
  });

  it("처음에 안 보이는 상태로 열리면 보일 때까지 받지 않음", async () => {
    const { store, setVisible, manifestCalls } = setup();
    setVisible(false);
    store.start();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(manifestCalls()).toBe(0);
    setVisible(true);
    await store.refresh();
    expect(manifestCalls()).toBe(1);
  });

  it("validUntil이 지나면 즉시 판단불가로 바꾸고 다시 조회", async () => {
    const { store, manifestCalls } = setup();
    store.start();
    await store.refresh();
    // 예시 validUntil 06:03:40, 지금 05:30:00
    // (그사이 5분마다 확인도 돌아서 횟수는 그 시점 기준으로 셈)
    await vi.advanceTimersByTimeAsync(
      Date.parse("2026-10-17T06:03:40Z") - Date.now(),
    );
    const before = manifestCalls();
    expect(
      deriveBeachView({ id: "b0001", hidden: false }, store.getState()),
    ).toMatchObject({ category: "clear" });

    await vi.advanceTimersByTimeAsync(1);
    expect(manifestCalls()).toBe(before + 1);
    // 서버가 아직 같은 스냅샷 → 판단불가 유지, 같은 만료로 반복 조회하지 않음
    expect(
      deriveBeachView({ id: "b0001", hidden: false }, store.getState()),
    ).toMatchObject({
      category: "undetermined",
      badge: { kind: "warning_unknown" },
    });
    // 다음 5분 확인(06:05:00) 전까지 추가 조회 없음
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manifestCalls()).toBe(before + 1);
  });
});

describe("시계 보정", () => {
  it.each([
    ["20분 빠름", -20 * 60_000],
    ["20분 느림", +20 * 60_000],
  ])("기기 시계가 %s → Date 헤더로 보정", async (_, skewMs) => {
    // 실제(서버) 시각은 05:30 이후여야 함(manifest generatedAt 05:30:12보다 앞이면 서버 시각을 믿지 않음)
    const device = DEVICE_START + Math.max(0, -skewMs);
    vi.setSystemTime(device);
    const { store, server } = setup();
    server.skewMs = skewMs;
    store.start();
    await store.refresh();
    const state = store.getState();
    expect(state.clock).toEqual({ offsetMs: skewMs, trusted: true });
    expect(state.nowMs).toBe(device + skewMs);
  });

  it("2분 이내 차이는 무시", async () => {
    const { store, server } = setup();
    server.skewMs = 2 * 60_000;
    store.start();
    await store.refresh();
    expect(store.getState().clock).toEqual({ offsetMs: 0, trusted: true });
  });

  it("Date 헤더가 없으면 기기 시계(서버 시각 모름)", async () => {
    const { store, server } = setup();
    server.sendDate = false;
    store.start();
    await store.refresh();
    expect(store.getState().clock).toEqual({ offsetMs: 0, trusted: false });
  });
});

describe("지원 범위 밖 schemaVersion", () => {
  it("자동 새로고침 1회 → 다시 열어도 안 되면 판단불가 상태", async () => {
    const session = memoryStorage();
    const first = setup({ session });
    first.server.manifest = { ...manifestExample, schemaVersion: 2 };
    first.store.start();
    await first.store.refresh();
    expect(first.reload).toHaveBeenCalledTimes(1);

    // 새로고침 뒤 새 화면(같은 브라우저 탭 sessionStorage)
    const second = setup({ session, server: first.server });
    second.store.start();
    await second.store.refresh();
    expect(second.reload).not.toHaveBeenCalled();
    expect(second.store.getState().phase).toBe("schema_unsupported");
  });

  it("다시 지원 범위 안이 되면 정상(새로고침 기록은 남겨 반복 방지)", async () => {
    const session = memoryStorage();
    const { store, server, reload } = setup({ session });
    server.manifest = { ...manifestExample, schemaVersion: 2 };
    session.setItem("baradun:schema-reload", "2");
    store.start();
    await store.refresh();
    expect(store.getState().phase).toBe("schema_unsupported");
    server.manifest = manifestExample;
    await store.refresh();
    expect(store.getState().phase).toBe("ready");
    expect(session.data.get("baradun:schema-reload")).toBe("2");
    expect(reload).not.toHaveBeenCalled();
  });

  it("새로고침 기록을 못 남기면 새로고침하지 않음(무한 새로고침 방지)", async () => {
    const broken: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    const { store, server, reload } = setup({
      session: broken as ReturnType<typeof memoryStorage>,
    });
    server.manifest = { ...manifestExample, schemaVersion: 2 };
    store.start();
    await store.refresh();
    expect(reload).not.toHaveBeenCalled();
    expect(store.getState().phase).toBe("schema_unsupported");
  });
});

describe("오프라인 (B5)", () => {
  it("조회 실패 시 메모리의 마지막 값 + live false", async () => {
    const { store, server } = setup();
    store.start();
    await store.refresh();
    server.down = true;
    await store.refresh();
    const state = store.getState();
    expect(state.live).toBe(false);
    expect(
      deriveBeachView({ id: "b0002", hidden: false }, state),
    ).toMatchObject({
      category: "unavailable",
      confirmedAt: "2026-10-17T05:18:40Z",
    });
  });

  it("오프라인으로 열면 기기에 저장한 마지막 값을 꺼냄(서버 시각 모름)", async () => {
    const storage = memoryStorage();
    const online = setup({ storage });
    online.store.start();
    await online.store.refresh();

    const offline = setup({ storage });
    offline.server.down = true;
    offline.store.start();
    await offline.store.refresh();
    const state = offline.store.getState();
    expect(state).toMatchObject({
      phase: "ready",
      live: false,
      clock: { trusted: false },
    });
    expect(
      deriveBeachView({ id: "b0001", hidden: false }, state),
    ).toMatchObject({
      category: "undetermined",
      badge: { kind: "warning_unknown" },
    });
  });

  it("저장한 값도 없으면 모든 해변 판단불가", async () => {
    const { store, server } = setup();
    server.down = true;
    store.start();
    await store.refresh();
    expect(
      deriveBeachView({ id: "b0001", hidden: false }, store.getState()),
    ).toMatchObject({
      category: "undetermined",
      badge: { kind: "unconfirmed" },
    });
  });

  it("모양이 틀린 status는 받지 못한 것으로 봄", async () => {
    const { store, server } = setup();
    server.status = { beaches: [] };
    store.start();
    await store.refresh();
    expect(store.getState()).toMatchObject({ live: false, statuses: null });
  });
});

describe("요청 시간 제한 (끝나지 않는 응답)", () => {
  const b0001 = { id: "b0001", hidden: false };
  const b0002 = { id: "b0002", hidden: false };

  // 한 번 정상으로 받아 기기에 마지막 값을 저장해 둠
  async function storedSnapshot() {
    const storage = memoryStorage();
    const online = setup({ storage });
    online.store.start();
    await online.store.refresh();
    online.store.stop();
    return storage;
  }

  it.each([
    ["abort되면 실패하는 fetch", false],
    ["abort도 무시하는 fetch", true],
  ])(
    "%s: 시간 초과 → 판단불가·마지막 값 → 다시 시도 시 새 요청",
    async (_, ignoreAbort) => {
      const storage = await storedSnapshot();
      const { store, server, manifestCalls } = setup({ storage });
      server.hang = true;
      server.ignoreAbort = ignoreAbort;
      store.start();

      // 응답을 기다리지 않고 저장된 마지막 값부터 B5 규칙으로 보임
      expect(store.getState()).toMatchObject({ phase: "ready", live: false });
      expect(deriveBeachView(b0001, store.getState())).toMatchObject({
        category: "undetermined",
        badge: { kind: "warning_unknown" },
      });
      expect(deriveBeachView(b0002, store.getState())).toMatchObject({
        category: "unavailable",
        badge: { kind: "warning", type: "wind_wave" },
        confirmedAt: "2026-10-17T05:18:40Z",
      });

      // 10초 직전까지는 같은 요청에 묶임
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
      void store.refresh();
      expect(manifestCalls()).toBe(1);

      // 10초가 지나면 실패로 끝나고 inFlight가 풀림
      await vi.advanceTimersByTimeAsync(1);
      expect(store.getState().live).toBe(false);

      // 다시 시도 → 새 요청이 나가고, 응답이 오면 교체
      server.hang = false;
      await store.refresh();
      expect(manifestCalls()).toBe(2);
      expect(store.getState().live).toBe(true);
      expect(deriveBeachView(b0001, store.getState())).toMatchObject({
        category: "clear",
      });
    },
  );

  it("status 요청이 멈춰도 10초 뒤 실패, 다음 폴링이 새 요청을 보냄", async () => {
    const { store, server, statusCalls } = setup();
    store.start();
    await store.refresh();
    expect(store.getState().live).toBe(true);

    // 새 스냅샷의 status만 멈춤(manifest는 정상)
    server.hangStatus = true;
    server.manifest = {
      ...manifestExample,
      snapshotVersion: "20261017T060000Z",
      files: {
        ...manifestExample.files,
        status: "/data/20261017T060000Z/status.json",
      },
    };
    void store.refresh();
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(store.getState().live).toBe(false);

    server.hangStatus = false;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - REQUEST_TIMEOUT_MS);
    // 처음 받기 · 멈춘 요청 · 5분 폴링의 새 요청
    expect(statusCalls()).toBe(3);
    expect(store.getState().live).toBe(true);
  });

  it("저장된 값이 없으면 시간 초과 뒤 모든 해변 판단불가", async () => {
    const { store, server } = setup();
    server.hang = true;
    store.start();
    expect(store.getState().phase).toBe("loading");
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(deriveBeachView(b0001, store.getState())).toMatchObject({
      category: "undetermined",
      badge: { kind: "unconfirmed" },
    });
  });
});

describe("status 경로를 현재 스냅샷에 묶음", () => {
  it.each([
    ["이전 버전 경로", "/data/20261017T050000Z/status.json"],
    ["외부 주소", "https://example.com/data/20261017T060000Z/status.json"],
    ["프로토콜 상대 주소", "//example.com/data/20261017T060000Z/status.json"],
  ])(
    "%s → 받지 않고 실패(마지막 값), 바른 manifest가 오면 받음",
    async (_, path) => {
      const { store, server, statusCalls } = setup();
      store.start();
      await store.refresh();

      server.manifest = {
        ...manifestExample,
        snapshotVersion: "20261017T060000Z",
        files: { ...manifestExample.files, status: path },
      };
      await store.refresh();
      expect(server.calls).not.toContain(path);
      expect(store.getState()).toMatchObject({ live: false });
      expect(statusCalls()).toBe(1);

      server.manifest = {
        ...manifestExample,
        snapshotVersion: "20261017T060000Z",
        files: {
          ...manifestExample.files,
          status: "/data/20261017T060000Z/status.json",
        },
      };
      await store.refresh();
      expect(server.calls.at(-1)).toBe("/data/20261017T060000Z/status.json");
      expect(store.getState()).toMatchObject({ live: true });
    },
  );
});

describe("status 실패에도 새로 확인한 서버 시계 유지", () => {
  it("기기 시계 20분 느림 + 저장된 값 + status 시간 초과 → 서버 시각으로 만료 판정", async () => {
    const storage = memoryStorage();
    const online = setup({ storage });
    online.store.start();
    await online.store.refresh();
    online.store.stop();

    // 실제 06:35, 기기 06:15(20분 느림). 파고 expiresAt 06:30은 이미 지남
    vi.setSystemTime(Date.parse("2026-10-17T06:15:00Z"));
    const { store, server } = setup({ storage });
    server.skewMs = 20 * 60_000;
    server.hangStatus = true;
    store.start();
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

    const state = store.getState();
    expect(state).toMatchObject({
      live: false,
      clock: { offsetMs: 20 * 60_000, trusted: true },
    });
    expect(
      deriveBeachView({ id: "b0001", hidden: false }, state),
    ).toMatchObject({ metrics: { waveHeight: { kind: "hidden" } } });
  });
});

describe("전체 재검증", () => {
  const b0001 = { id: "b0001", hidden: false };
  const b0002 = { id: "b0002", hidden: false };
  const v2 = "20261017T060000Z";
  const manifestV2 = {
    ...manifestExample,
    snapshotVersion: v2,
    generatedAt: "2026-10-17T06:00:10Z",
    files: { ...manifestExample.files, status: `/data/${v2}/status.json` },
  };

  it("이전 스냅샷 manifest가 와도 새 상태를 덮지 않음(발효 특보 유지)", async () => {
    const { store, server, storage, statusCalls } = setup();
    // 06:00 스냅샷: b0001에 풍랑주의보 발효
    const statusV2 = structuredClone(statusExample);
    statusV2.beaches.b0001 = structuredClone(statusExample.beaches.b0002!);
    server.manifest = manifestV2;
    server.status = statusV2;
    vi.setSystemTime(Date.parse("2026-10-17T06:01:00Z"));
    store.start();
    await store.refresh();
    expect(deriveBeachView(b0001, store.getState())).toMatchObject({
      category: "unavailable",
    });
    const saved = storage.data.get("baradun:last-snapshot");

    // CDN 엣지 차이로 05:30 manifest(b0001 특보 없음)가 다시 옴
    server.manifest = manifestExample;
    server.status = statusExample;
    await store.refresh();
    expect(statusCalls()).toBe(1);
    expect(store.getState().manifest?.snapshotVersion).toBe(v2);
    expect(deriveBeachView(b0001, store.getState())).toMatchObject({
      category: "unavailable",
    });
    expect(storage.data.get("baradun:last-snapshot")).toBe(saved);
  });

  it("이전 스냅샷 응답의 서버 시각이 지금 manifest 게시 시각보다 이르면 믿지 않음", async () => {
    const { store, server } = setup();
    server.manifest = manifestV2;
    vi.setSystemTime(Date.parse("2026-10-17T06:01:00Z"));
    store.start();
    await store.refresh();
    expect(store.getState().clock).toEqual({ offsetMs: 0, trusted: true });

    // 늦은 CDN 엣지가 05:30 manifest를 Age 없이 05:31 Date로 다시 줌(06:00:10 게시보다 이름)
    server.manifest = manifestExample;
    server.skewMs = -30 * 60_000;
    await store.refresh();
    expect(store.getState().clock).toEqual(DEVICE_CLOCK);
    expect(store.getState().manifest?.snapshotVersion).toBe(v2);
  });

  it("새 버전이 점검 중이면 이전 스냅샷 manifest가 와도 점검이 풀리지 않음", async () => {
    const { store, server } = setup();
    vi.setSystemTime(Date.parse("2026-10-17T06:01:00Z"));
    store.start();
    await store.refresh();
    expect(store.getState().phase).toBe("ready");

    server.manifest = {
      ...manifestV2,
      maintenance: { active: true, until: null },
    };
    await store.refresh();
    expect(store.getState().phase).toBe("maintenance");

    // 늦은 CDN 엣지가 05:30 manifest(점검 아님)를 다시 줌
    server.manifest = manifestExample;
    await store.refresh();
    expect(store.getState().phase).toBe("maintenance");
  });

  it("새 버전 status를 못 받은 뒤 이전 스냅샷 manifest가 와도 live로 되살리지 않음", async () => {
    const { store, server, statusCalls } = setup();
    vi.setSystemTime(Date.parse("2026-10-17T06:01:00Z"));
    store.start();
    await store.refresh();
    expect(store.getState().live).toBe(true);

    server.manifest = manifestV2;
    server.statusDown = true;
    await store.refresh();
    expect(store.getState().live).toBe(false);

    server.manifest = manifestExample;
    server.statusDown = false;
    await store.refresh();
    expect(store.getState().live).toBe(false);
    expect(statusCalls()).toBe(2);
  });

  it("기기에 저장된 값보다 이전 스냅샷(publisher 버전 되돌림)이면 네트워크 값을 받음(고착 방지)", async () => {
    const storage = memoryStorage();
    const online = setup({ storage });
    online.server.manifest = manifestV2;
    vi.setSystemTime(Date.parse("2026-10-17T06:01:00Z"));
    online.store.start();
    await online.store.refresh();
    online.store.stop();

    const { store, statusCalls } = setup({ storage });
    store.start();
    await store.refresh();
    expect(statusCalls()).toBe(1);
    expect(store.getState()).toMatchObject({ live: true });
    expect(store.getState().manifest?.snapshotVersion).toBe(
      manifestExample.snapshotVersion,
    );
  });

  it.each([
    ["빈 객체", {}],
    ["오류 응답", { error: "captive portal" }],
    ["문자열 버전", { ...manifestExample, schemaVersion: "1" }],
  ])(
    "모양이 틀린 manifest(%s) → 새로고침 없이 실패 경로(B5)",
    async (_, body) => {
      const { store, server, reload } = setup();
      store.start();
      await store.refresh();
      server.manifest = body;
      await store.refresh();
      expect(reload).not.toHaveBeenCalled();
      expect(store.getState()).toMatchObject({ phase: "ready", live: false });
      expect(deriveBeachView(b0002, store.getState())).toMatchObject({
        category: "unavailable",
        badge: { kind: "warning", type: "wind_wave" },
      });
    },
  );

  it("모양이 틀린 manifest 응답의 Date 헤더는 서버 시각으로 쓰지 않음", async () => {
    const { store, server } = setup();
    server.skewMs = 20 * 60_000;
    server.manifest = { error: "captive portal" };
    store.start();
    await store.refresh();
    expect(store.getState().clock).toEqual({ offsetMs: 0, trusted: false });
  });

  it("지원 밖 형식 배너는 네트워크 실패 한 번으로 풀리지 않음", async () => {
    const session = memoryStorage();
    session.setItem("baradun:schema-reload", "2");
    const { store, server } = setup({ session });
    server.manifest = { ...manifestExample, schemaVersion: 2 };
    store.start();
    await store.refresh();
    server.down = true;
    await store.refresh();
    expect(store.getState().phase).toBe("schema_unsupported");
  });

  it("먼 미래 만료 시각이어도 타이머가 반복 실행되지 않음", async () => {
    const statuses = structuredClone(statusExample);
    for (const status of Object.values(statuses.beaches)) {
      status.validUntil = "2100-01-01T00:00:00Z";
      for (const metric of Object.values(status.observation.metrics)) {
        if (metric.expiresAt) metric.expiresAt = "2100-01-01T00:00:00Z";
      }
    }
    const { store, server } = setup();
    server.status = statuses;
    // 가짜 타이머는 한도(2^31-1ms)를 넘는 지연을 브라우저처럼 즉시 실행하지 않아서, 넘긴 지연 값을 직접 확인
    const spy = vi.spyOn(globalThis, "setTimeout");
    store.start();
    await store.refresh();
    const delays = spy.mock.calls.map(([, delay]) => Number(delay ?? 0));
    spy.mockRestore();
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(POLL_INTERVAL_MS);
  });

  it("기기 시계가 30일 늦고 서버 시각을 모름 → 지금 시각 모름(값 숨김), 타이머 반복 없음", async () => {
    const storage = memoryStorage();
    const online = setup({ storage });
    online.store.start();
    await online.store.refresh();
    online.store.stop();

    vi.setSystemTime(DEVICE_START - 30 * 24 * 3_600_000);
    const { store, server } = setup({ storage });
    server.down = true;
    const listener = vi.fn();
    store.subscribe(listener);
    store.start();
    await store.refresh();
    expect(store.getState().nowMs).toBeNaN();
    expect(deriveBeachView(b0001, store.getState())).toMatchObject({
      category: "undetermined",
      metrics: { waveHeight: { kind: "hidden" }, wind: { kind: "hidden" } },
    });
    expect(deriveBeachView(b0002, store.getState())).toMatchObject({
      category: "unavailable",
    });
    listener.mockClear();
    await vi.advanceTimersByTimeAsync(300);
    expect(listener).not.toHaveBeenCalled();
  });

  it("서버 시각이 게시 시각보다 2분 넘게 이르면 서버 시각을 믿지 않음", async () => {
    const { store, server } = setup();
    server.skewMs = -60 * 60_000; // 서버 04:30 < generatedAt 05:30:12
    store.start();
    await store.refresh();
    expect(store.getState().clock).toEqual({ offsetMs: 0, trusted: false });
  });

  it("조회 중에 validUntil이 지나면 그 조회가 끝난 뒤 한 번 더 조회", async () => {
    const { store, server, manifestCalls } = setup();
    store.start();
    await store.refresh();
    // 06:03:35에 시작한 조회가 멈춤(validUntil 06:03:40)
    await vi.advanceTimersByTimeAsync(
      Date.parse("2026-10-17T06:03:35Z") - Date.now(),
    );
    const before = manifestCalls();
    server.hang = true;
    void store.refresh();
    await vi.advanceTimersByTimeAsync(6_000); // 만료 지남, 조회는 진행 중
    expect(manifestCalls()).toBe(before + 1);
    server.hang = false;
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS); // 멈춘 조회가 시간 초과로 끝남
    expect(manifestCalls()).toBe(before + 2);
    expect(store.getState().live).toBe(true);
  });

  it.each([
    [
      "손상된 JSON",
      (s: ReturnType<typeof memoryStorage>) => {
        s.setItem("baradun:last-snapshot", "{not json");
      },
    ],
    [
      "읽기 예외",
      (s: ReturnType<typeof memoryStorage>) => {
        s.getItem = () => {
          throw new Error("SecurityError");
        };
      },
    ],
  ])("저장소 %s → 무시하고 네트워크로 정상", async (_, breakStorage) => {
    const storage = memoryStorage();
    breakStorage(storage);
    const { store } = setup({ storage });
    store.start();
    await store.refresh();
    expect(store.getState()).toMatchObject({ phase: "ready", live: true });
  });

  it("저장 용량 초과(setItem 예외)여도 화면은 정상", async () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    const { store } = setup({ storage });
    store.start();
    await store.refresh();
    expect(store.getState()).toMatchObject({ live: true });
  });

  it("조회 중에 화면을 숨겼다 다시 보여도 조회 하나로 합침", async () => {
    const { store, server, setVisible, manifestCalls } = setup();
    server.hang = true;
    store.start();
    setVisible(false);
    setVisible(true);
    expect(manifestCalls()).toBe(1);
    server.hang = false;
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    store.stop();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(manifestCalls()).toBe(1);
  });
});

describe("스냅샷 버전 형식·저장된 값의 시계", () => {
  it("형식이 틀린 snapshotVersion → 못 읽은 것으로 보고 이후 정상 버전을 막지 않음", async () => {
    const bad = "zzz";
    const { store, server } = setup();
    server.manifest = {
      ...manifestExample,
      snapshotVersion: bad,
      files: { ...manifestExample.files, status: `/data/${bad}/status.json` },
    };
    store.start();
    await store.refresh();
    expect(store.getState().manifest).toBeNull();
    server.manifest = manifestExample;
    await store.refresh();
    expect(store.getState()).toMatchObject({ live: true });
    expect(store.getState().manifest?.snapshotVersion).toBe(
      manifestExample.snapshotVersion,
    );
  });

  it("기기 시계가 게시 시각보다 한참 이르면 저장된 값을 꺼내는 순간부터 지금 시각 모름", async () => {
    const storage = memoryStorage();
    const online = setup({ storage });
    online.store.start();
    await online.store.refresh();
    online.store.stop();

    vi.setSystemTime(DEVICE_START - 30 * 24 * 3_600_000);
    const { store, server } = setup({ storage });
    server.hang = true;
    store.start();
    expect(store.getState()).toMatchObject({ live: false });
    expect(store.getState().nowMs).toBeNaN();
  });
});

describe("점검 해제 후 status 실패", () => {
  it("점검이 끝난 manifest를 받고 status만 실패 → 점검 화면을 풀고 B5", async () => {
    const { store, server } = setup();
    store.start();
    await store.refresh();
    server.manifest = {
      ...manifestExample,
      maintenance: { active: true, until: null },
    };
    await store.refresh();
    expect(store.getState().phase).toBe("maintenance");

    server.manifest = {
      ...manifestExample,
      snapshotVersion: "20261017T060000Z",
      generatedAt: "2026-10-17T05:30:30Z",
      files: {
        ...manifestExample.files,
        status: "/data/20261017T060000Z/status.json",
      },
    };
    server.statusDown = true;
    await store.refresh();
    expect(store.getState()).toMatchObject({ phase: "ready", live: false });
    expect(
      deriveBeachView({ id: "b0002", hidden: false }, store.getState()),
    ).toMatchObject({ category: "unavailable", stale: true });
  });
});

describe("지원 밖 형식 이후 (Claude 리뷰)", () => {
  it("버전 전환 중 v1·v2가 번갈아 와도 새로고침은 탭당 한 번", async () => {
    const session = memoryStorage();
    const first = setup({ session });
    first.server.manifest = { ...manifestExample, schemaVersion: 2 };
    first.store.start();
    await first.store.refresh();
    expect(first.reload).toHaveBeenCalledTimes(1);

    const second = setup({ session, server: first.server });
    second.server.manifest = manifestExample;
    second.store.start();
    await second.store.refresh();
    expect(second.store.getState().phase).toBe("ready");
    second.server.manifest = { ...manifestExample, schemaVersion: 2 };
    await second.store.refresh();
    expect(second.reload).not.toHaveBeenCalled();
    expect(second.store.getState().phase).toBe("schema_unsupported");
  });

  it("지원 밖 형식 화면에서 지원 manifest를 받고 status만 실패 → 배너를 풀고 B5(발효 특보 유지)", async () => {
    const session = memoryStorage();
    session.setItem("baradun:schema-reload", "2");
    const { store, server } = setup({ session });
    store.start();
    await store.refresh();
    server.manifest = { ...manifestExample, schemaVersion: 2 };
    await store.refresh();
    expect(store.getState().phase).toBe("schema_unsupported");

    server.manifest = {
      ...manifestExample,
      snapshotVersion: "20261017T060000Z",
      generatedAt: "2026-10-17T05:30:30Z",
      files: {
        ...manifestExample.files,
        status: "/data/20261017T060000Z/status.json",
      },
    };
    server.statusDown = true;
    await store.refresh();
    expect(store.getState()).toMatchObject({ phase: "ready", live: false });
    expect(
      deriveBeachView({ id: "b0002", hidden: false }, store.getState()),
    ).toMatchObject({
      category: "unavailable",
      badge: { kind: "warning", type: "wind_wave" },
      stale: true,
    });
  });
});

describe("버전마다 새로고침 한 번", () => {
  it("v2로 한 번 새로고침한 탭에 나중에 v3가 오면 다시 한 번 새로고침", async () => {
    const session = memoryStorage();
    session.setItem("baradun:schema-reload", "2");
    const { store, server, reload } = setup({ session });
    server.manifest = { ...manifestExample, schemaVersion: 3 };
    store.start();
    await store.refresh();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(session.data.get("baradun:schema-reload")).toBe("3");
  });
});
