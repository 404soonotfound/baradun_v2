import { readFileSync } from "node:fs";

import type { ManifestFile, StatusFile } from "@baradun/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSnapshotStore,
  MANIFEST_URL,
  POLL_INTERVAL_MS,
  type KeyValueStorage,
  type SnapshotDeps,
} from "./store";
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
    // 응답이 오지 않음(느린 네트워크)
    hang: false,
    calls: [] as string[],
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      server.calls.push(url);
      if (server.hang) return new Promise<Response>(() => {});
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
    const { store, server } = setup();
    server.skewMs = skewMs;
    store.start();
    await store.refresh();
    const state = store.getState();
    expect(state.clock).toEqual({ offsetMs: skewMs, trusted: true });
    expect(state.nowMs).toBe(DEVICE_START + skewMs);
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

  it("다시 지원 범위 안이 되면 기록을 지우고 정상", async () => {
    const session = memoryStorage();
    const { store, server, reload } = setup({ session });
    server.manifest = { ...manifestExample, schemaVersion: 2 };
    session.setItem("baradun:schema-reload", "1");
    store.start();
    await store.refresh();
    expect(store.getState().phase).toBe("schema_unsupported");
    server.manifest = manifestExample;
    await store.refresh();
    expect(store.getState().phase).toBe("ready");
    expect(session.data.size).toBe(0);
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
