import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TABS } from "../src/lib/nav";

import {
  OFFLINE_PAGES,
  precacheList,
  serviceWorkerSource,
} from "./build-sw.mjs";

// 실제로 내보내는 service-worker.js를 가짜 self·caches·fetch 위에서 돌려 봄 (BRD-42)
const SOURCE = readFileSync(
  new URL("./service-worker.js", import.meta.url),
  "utf8",
);
const ORIGIN = "https://baradun.example";
const BUILD = "build-new";

const abs = (url: string) => new URL(url, ORIGIN).href;

// 브라우저 fetch 응답처럼 type을 basic으로 둠(Node Response는 default)
function respond(body: string, init: ResponseInit = {}, type = "basic") {
  const response = new Response(body, init);
  Object.defineProperty(response, "type", { value: type });
  return response;
}
const html = (body: string, status = 200) =>
  respond(body, { status, headers: { "content-type": "text/html" } });
const thisBuildHtml = (label = "page") =>
  html(`<html>${label} "b":"${BUILD}"</html>`);

class FakeCache {
  entries = new Map<string, Response>();
  async put(request: string | { url: string }, response: Response) {
    this.entries.set(
      abs(typeof request === "string" ? request : request.url),
      response,
    );
  }
  async match(
    request: string | { url: string },
    options?: { ignoreSearch?: boolean },
  ) {
    let key = abs(typeof request === "string" ? request : request.url);
    if (options?.ignoreSearch) key = key.split("?")[0] ?? key;
    return this.entries.get(key)?.clone();
  }
}

class FakeCaches {
  stores = new Map<string, FakeCache>();
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name)!;
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name: string) {
    return this.stores.delete(name);
  }
}

type Listener = (event: unknown) => void;

function load({
  fetch,
  precache = ["/", "/en/", "/_next/static/chunks/a.js"],
  caches = new FakeCaches(),
}: {
  fetch: (request: unknown, init?: unknown) => Promise<Response>;
  precache?: string[];
  caches?: FakeCaches;
}) {
  const listeners: Record<string, Listener> = {};
  const self = {
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = listener;
    },
    location: { origin: ORIGIN },
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
  };
  const fetchSpy = vi.fn(fetch);
  const context = vm.createContext({
    self,
    caches,
    fetch: fetchSpy,
    Response,
    URL,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  vm.runInContext(serviceWorkerSource(BUILD, precache, SOURCE), context);
  const cache = () => caches.stores.get(`baradun-screen-${BUILD}`);

  async function lifecycle(type: "install" | "activate") {
    let wait: Promise<unknown> = Promise.resolve();
    listeners[type]!({ waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  }

  // respondWith를 안 부르면 undefined(브라우저가 그대로 네트워크로 보냄)
  async function request(
    url: string,
    { mode = "no-cors", method = "GET", headers = {} } = {},
  ) {
    let responded: Promise<Response> | undefined;
    const waits: Promise<unknown>[] = [];
    listeners.fetch!({
      request: { url: abs(url), mode, method, headers: new Headers(headers) },
      respondWith: (p: Promise<Response>) => (responded = p),
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    const response = responded ? await responded : undefined;
    await Promise.all(waits);
    return response;
  }
  const navigate = (url: string) => request(url, { mode: "navigate" });

  return { self, caches, cache, fetch: fetchSpy, lifecycle, request, navigate };
}

const offline = () => Promise.reject(new TypeError("Failed to fetch"));

afterEach(() => {
  vi.useRealTimers();
});

describe("설치", () => {
  it("미리 저장 목록을 이 빌드 캐시에 넣고 기다리지 않고 교체함", async () => {
    const sw = load({
      fetch: async (url) =>
        String(url).endsWith("/") ? thisBuildHtml(String(url)) : respond("js"),
    });
    await sw.lifecycle("install");
    expect([...sw.cache()!.entries.keys()].sort()).toEqual([
      abs("/"),
      abs("/_next/static/chunks/a.js"),
      abs("/en/"),
    ]);
    expect(sw.self.skipWaiting).toHaveBeenCalled();
    // HTML은 HTTP 캐시가 있어도 서버에 다시 확인
    expect(sw.fetch).toHaveBeenCalledWith("/", { cache: "no-cache" });
  });

  it("다른 빌드의 HTML이면 설치 실패, 반쯤 채운 캐시를 지움", async () => {
    const sw = load({
      fetch: async (url) =>
        String(url).endsWith("/")
          ? html('<html>"b":"build-old"</html>')
          : respond("js"),
    });
    await expect(sw.lifecycle("install")).rejects.toThrow("다른 빌드");
    expect(sw.cache()).toBeUndefined();
    expect(sw.self.skipWaiting).not.toHaveBeenCalled();
  });

  it("파일 하나라도 못 받으면(HTTP 오류·연결 끊김) 설치 실패", async () => {
    const failing = load({
      fetch: async (url) =>
        String(url).endsWith(".js")
          ? respond("", { status: 404 })
          : thisBuildHtml(),
    });
    await expect(failing.lifecycle("install")).rejects.toThrow("HTTP 404");
    expect(failing.cache()).toBeUndefined();

    const disconnected = load({ fetch: offline });
    await expect(disconnected.lifecycle("install")).rejects.toThrow();
    expect(disconnected.cache()).toBeUndefined();
  });

  it("HTML이 아닌 응답(content-type)은 이 빌드 화면으로 보지 않음", async () => {
    const sw = load({
      precache: ["/"],
      fetch: async () => respond(`"b":"${BUILD}"`),
    });
    await expect(sw.lifecycle("install")).rejects.toThrow("다른 빌드");
  });
});

describe("활성화", () => {
  it("옛 빌드 캐시만 지우고 열린 화면을 바로 맡음", async () => {
    const caches = new FakeCaches();
    await caches.open("baradun-screen-build-old");
    await caches.open(`baradun-screen-${BUILD}`);
    await caches.open("other-app");
    const sw = load({ fetch: offline, caches });
    await sw.lifecycle("activate");
    expect(await caches.keys()).toEqual([
      `baradun-screen-${BUILD}`,
      "other-app",
    ]);
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });
});

describe("손대지 않는 요청", () => {
  it.each([
    ["바다 정보 manifest", "/data/manifest.json", {}],
    ["바다 정보 status", "/data/20261017T053000Z/status.json", {}],
    ["주소창으로 연 바다 정보", "/data/manifest.json", { mode: "navigate" }],
    [
      "지도 타일(다른 출처)",
      "https://tiles.openfreemap.org/planet/1/2/3.pbf",
      {},
    ],
    ["다른 출처 화면 이동", "https://example.com/", { mode: "navigate" }],
    [
      "GET이 아닌 요청",
      "/settings/inquiry/",
      { mode: "navigate", method: "POST" },
    ],
    ["RSC 조회", "/explore/index.txt?_rsc=abc", {}],
    [
      "범위 요청",
      "/_next/static/media/a.woff2",
      { headers: { range: "bytes=0-1" } },
    ],
  ])("%s", async (_, url, options) => {
    const sw = load({ fetch: offline });
    expect(await sw.request(url, options)).toBeUndefined();
    expect(sw.fetch).not.toHaveBeenCalled();
  });
});

describe("화면 이동(HTML)", () => {
  it("네트워크 먼저. 이 빌드의 HTML이면 검색어 없는 주소로 저장", async () => {
    const sw = load({ fetch: async () => thisBuildHtml("search") });
    await sw.lifecycle("activate");
    await sw.caches.open(`baradun-screen-${BUILD}`);
    const response = await sw.navigate("/search/?q=경포");
    expect(await response!.text()).toContain("search");
    expect([...sw.cache()!.entries.keys()]).toEqual([abs("/search/")]);
  });

  it("다른 빌드·리디렉트된 응답은 보여주되 저장하지 않음", async () => {
    const other = load({
      fetch: async () => html('<html>"b":"build-next"</html>'),
    });
    await other.caches.open(`baradun-screen-${BUILD}`);
    expect((await other.navigate("/explore/"))!.status).toBe(200);
    expect(other.cache()!.entries.size).toBe(0);

    const redirected = load({
      fetch: async () => {
        const response = thisBuildHtml();
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      },
    });
    await redirected.caches.open(`baradun-screen-${BUILD}`);
    await redirected.navigate("/explore/");
    expect(redirected.cache()!.entries.size).toBe(0);
  });

  it("연결이 끊기면 저장본(검색어 무시)", async () => {
    const sw = load({ fetch: offline });
    const cache = await sw.caches.open(`baradun-screen-${BUILD}`);
    await cache.put("/search/", html("saved search"));
    const response = await sw.navigate("/search/?q=경포");
    expect(await response!.text()).toBe("saved search");
  });

  it("서버 오류(5xx)면 저장본, 404는 그대로", async () => {
    const failing = load({ fetch: async () => html("down", 503) });
    const cache = await failing.caches.open(`baradun-screen-${BUILD}`);
    await cache.put("/explore/", html("saved explore"));
    expect(await (await failing.navigate("/explore/"))!.text()).toBe(
      "saved explore",
    );
    // 저장본이 없으면 서버 응답을 그대로
    expect((await failing.navigate("/favorites/"))!.status).toBe(503);

    const missing = load({ fetch: async () => html("not found", 404) });
    const missingCache = await missing.caches.open(`baradun-screen-${BUILD}`);
    await missingCache.put("/", thisBuildHtml());
    const response = await missing.navigate("/nope/");
    expect(response!.status).toBe(404);
    expect(missing.cache()!.entries.has(abs("/nope/"))).toBe(false);
  });

  it("열어 본 적 없는 화면은 같은 언어 홈으로 보냄", async () => {
    const sw = load({ fetch: offline });
    const cache = await sw.caches.open(`baradun-screen-${BUILD}`);
    await cache.put("/", html("home ko"));
    await cache.put("/en/", html("home en"));
    const ko = await sw.navigate("/spots/gyeongpo/");
    expect(ko!.status).toBe(302);
    expect(ko!.headers.get("location")).toBe(abs("/"));
    const en = await sw.navigate("/en/spots/gyeongpo/");
    expect(en!.headers.get("location")).toBe(abs("/en/"));
    // 홈 자체는 저장본으로
    expect(await (await sw.navigate("/en/"))!.text()).toBe("home en");
  });

  it("홈 저장본도 없으면 네트워크 오류 그대로(되돌림 반복 없음)", async () => {
    const sw = load({ fetch: offline });
    await sw.caches.open(`baradun-screen-${BUILD}`);
    expect((await sw.navigate("/"))!.type).toBe("error");
    expect((await sw.navigate("/spots/a/"))!.type).toBe("error");
  });

  it("응답이 10초 넘게 멈추면 저장본으로", async () => {
    vi.useFakeTimers();
    const sw = load({ fetch: () => new Promise<Response>(() => {}) });
    const cache = await sw.caches.open(`baradun-screen-${BUILD}`);
    await cache.put("/", html("saved home"));
    const pending = sw.navigate("/");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await (await pending)!.text()).toBe("saved home");
  });
});

describe("화면 파일(_next/static·vendor)", () => {
  it("저장본 먼저", async () => {
    const sw = load({ fetch: offline });
    const cache = await sw.caches.open(`baradun-screen-${BUILD}`);
    await cache.put("/_next/static/chunks/a.js", respond("saved js"));
    const response = await sw.request("/_next/static/chunks/a.js");
    expect(await response!.text()).toBe("saved js");
    expect(sw.fetch).not.toHaveBeenCalled();
  });

  it("나중에 받은 코드는 저장하지 않고(옛 빌드 코드) 글꼴·지도 작업자 파일만 저장", async () => {
    const sw = load({ fetch: async () => respond("file") });
    await sw.caches.open(`baradun-screen-${BUILD}`);
    await sw.request("/_next/static/chunks/old-build.js");
    await sw.request("/_next/static/media/font.woff2");
    await sw.request("/vendor/maplibre-gl-worker-6.16.0.js");
    expect([...sw.cache()!.entries.keys()]).toEqual([
      abs("/_next/static/media/font.woff2"),
      abs("/vendor/maplibre-gl-worker-6.16.0.js"),
    ]);
  });

  it("오류 응답은 저장하지 않음", async () => {
    const sw = load({ fetch: async () => respond("", { status: 404 }) });
    await sw.caches.open(`baradun-screen-${BUILD}`);
    expect((await sw.request("/_next/static/media/x.woff2"))!.status).toBe(404);
    expect(sw.cache()!.entries.size).toBe(0);
  });
});

describe("precacheList", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function out(files: Record<string, string>) {
    dir = mkdtempSync(path.join(tmpdir(), "baradun-sw-"));
    for (const [file, body] of Object.entries(files)) {
      const full = path.join(dir, file);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
    return dir;
  }

  // 탭 화면 HTML 8개(두 언어). 내용은 기본 이 빌드 ID만
  const pages = (body = BUILD) =>
    Object.fromEntries(
      OFFLINE_PAGES.map((page) => [`${page.slice(1)}index.html`, body]),
    );

  it("하단 탭 화면이 nav.ts TABS와 같음(두 언어)", () => {
    expect(OFFLINE_PAGES).toEqual([
      ...TABS.map((tab) => tab.path),
      ...TABS.map((tab) => `/en${tab.path}`),
    ]);
  });

  it("두 언어 탭 화면 + 이 빌드 코드 + 그 화면이 미리 받는 글꼴", () => {
    const root = out({
      ...pages(),
      "index.html": `<link href="/_next/static/media/a.woff2"/> \\"b\\":\\"${BUILD}\\"`,
      "en/explore/index.html": `${BUILD}<link href="/_next/static/media/b.woff2"/>`,
      "_next/static/chunks/x.js": "",
      "_next/static/chunks/y.css": "",
      [`_next/static/${BUILD}/_buildManifest.js`]: "",
      "_next/static/media/unused.woff2": "",
      "spots/a/index.html": "",
    });
    expect(precacheList(root, BUILD)).toEqual([
      ...OFFLINE_PAGES,
      `/_next/static/${BUILD}/_buildManifest.js`,
      "/_next/static/chunks/x.js",
      "/_next/static/chunks/y.css",
      "/_next/static/media/a.woff2",
      "/_next/static/media/b.woff2",
    ]);
  });

  it("화면 HTML에 빌드 ID가 없거나 화면·코드가 없으면 빌드를 멈춤", () => {
    expect(() =>
      precacheList(
        out({
          ...pages(),
          "favorites/index.html": "other",
          "_next/static/chunks/a.js": "",
        }),
        BUILD,
      ),
    ).toThrow("/favorites/: HTML에 빌드 ID");
    const missing = pages();
    delete missing["en/settings/index.html"];
    expect(() => precacheList(out(missing), BUILD)).toThrow(
      "/en/settings/: index.html 없음",
    );
    expect(() => precacheList(out(pages()), BUILD)).toThrow("코드 파일 없음");
  });
});
