// 화면 파일 저장 서비스 워커 (아키텍처 9.1 '오프라인', BRD-42)
// build-sw.mts가 빌드 뒤 SW_BUILD(Next 빌드 ID)·SW_PRECACHE(미리 저장할 경로)·SW_PAGES(HTML을 저장하는 탭 화면)를
// 앞에 붙여 out/sw.js로 내보냄.
// - 화면 파일(HTML·_next/static·vendor)만 저장함. 바다 정보(/data/**)·다른 출처(지도 타일 등)는 손대지 않음
//   → 브라우저가 늘 네트워크로 받고, 못 받으면 store.ts가 기기에 둔 마지막 값을 B5 규칙(live: false)으로 보여줌
// - HTML은 네트워크 먼저, 못 받을 때만 저장본. 저장본도 없으면 같은 언어 홈으로 보냄(오프라인 홈)
// - HTML 저장본은 탭 화면 8개(SW_PAGES)만 둠. 상세·검색 등 그 밖의 화면은 열어도 저장하지 않음(결정 29)
// - 빌드마다 캐시 이름이 다름. 새 워커는 기다리지 않고 바로 교체하고 옛 빌드 캐시를 지움
// 고전 스크립트(import 없음)로 둠: 모듈 서비스 워커를 못 쓰는 브라우저가 있음

const CACHE_PREFIX = "baradun-screen-";
const CACHE_NAME = CACHE_PREFIX + SW_BUILD;
// HTML을 저장해 두는 화면(탭 화면). 미리 저장·저장·저장본 사용 모두 이 목록으로만 가림
const SAVED_PAGES = new Set(SW_PAGES);
// 응답이 멈춘 망(캡티브 포털 등)에서 HTML을 끝없이 기다리지 않게 함(store.ts REQUEST_TIMEOUT_MS와 같은 값)
const PAGE_TIMEOUT_MS = 10000;

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME,
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const kind = requestKind(event.request);
  if (kind === "page") event.respondWith(page(event));
  else if (kind === "asset") event.respondWith(asset(event));
  // 그 밖(바다 정보·RSC 조회·다른 출처·GET이 아닌 요청)은 respondWith를 부르지 않아 브라우저가 그대로 네트워크로 보냄
});

// 이 워커가 다루는 요청 종류. null이면 손대지 않음
function requestKind(request) {
  if (request.method !== "GET" || request.headers.has("range")) return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return null;
  // 바다 정보는 주소창으로 직접 열어도 저장본을 내놓지 않음
  if (url.pathname === "/data" || url.pathname.startsWith("/data/")) {
    return null;
  }
  if (request.mode === "navigate") return "page";
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/vendor/")
  ) {
    return "asset";
  }
  return null;
}

// 설치: 오프라인 홈에 필요한 파일을 이 빌드 캐시에 모두 넣음. 하나라도 실패하면 설치 실패(지금 워커 유지)
async function precache() {
  const cache = await caches.open(CACHE_NAME);
  try {
    await Promise.all(
      SW_PRECACHE.map(async (path) => {
        const isPage = SAVED_PAGES.has(path);
        // HTML은 HTTP 캐시를 거치더라도 서버에 다시 확인. _next/static은 이름에 해시가 있어 그대로 씀
        const response = await fetch(path, {
          cache: isPage ? "no-cache" : "default",
        });
        if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
        if (isPage && !(await isThisBuild(response.clone()))) {
          throw new Error(`${path}: 다른 빌드의 HTML`);
        }
        await cache.put(path, response);
      }),
    );
  } catch (error) {
    // 반쯤 채운 캐시를 남기지 않음
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

// 이 빌드가 만든 HTML인지(Next가 HTML에 빌드 ID를 넣음). 배포 중 다른 빌드의 HTML·캡티브 포털 페이지를 저장하지 않게
async function isThisBuild(response) {
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return false;
  return (await response.text()).includes(SW_BUILD);
}

// 화면(HTML)은 헤더만이 아니라 본문까지 같은 시간 제한 안에서 다 받음(헤더만 오고 본문이 멈춘 망에서도 저장본으로 넘어가게)
// 이동(navigate) 요청은 옵션을 붙여 다시 만들 수 없어 abort 대신 race로 끊고, 받던 본문은 읽기를 취소함(늦게 온 응답은 버림)
// 결과: { response, cacheable }. 다 받은 본문으로 새 Response를 만들므로 저장 여부(cacheable)는 원래 응답으로 미리 정함
function fetchPage(request) {
  let timer;
  let reader = null;
  let timedOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      if (reader) reader.cancel().catch(() => {});
      reject(new Error("화면 파일 시간 초과"));
    }, PAGE_TIMEOUT_MS);
  });
  const pending = fetch(request).then(async (response) => {
    // 시간 제한 뒤에 헤더가 오면 본문을 받지 않고 버림
    if (timedOut) {
      if (response.body) response.body.cancel().catch(() => {});
      throw new Error("화면 파일 시간 초과");
    }
    // basic이 아닌 응답(opaqueredirect 등)·리디렉트를 거친 응답·본문 없는 응답은 다시 만들지 않고 그대로 넘김(저장하지 않음)
    if (response.type !== "basic" || response.redirected || !response.body) {
      return { response, cacheable: false };
    }
    reader = response.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    // 받은 본문은 이미 풀린 값이라 압축·길이 헤더는 뺌
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return {
      response: new Response(new Blob(chunks), {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
      cacheable: response.ok,
    };
  });
  pending.catch(() => {});
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

// 저장 주소에서 검색어(?…)를 뺌. 화면은 검색어를 브라우저에서 읽음
function pageKey(url) {
  return url.origin + url.pathname;
}

// 탭 화면만 저장·저장본 사용. 그 밖의 화면은 같은 캐시에 저장본이 있어도 쓰지 않음
function isSavedPage(url) {
  return SAVED_PAGES.has(url.pathname);
}

// 같은 언어 홈. 영어 주소(/en/…)면 영어 홈
function homeFor(url) {
  return url.pathname === "/en" || url.pathname.startsWith("/en/")
    ? "/en/"
    : "/";
}

async function page(event) {
  const request = event.request;
  const url = new URL(request.url);
  const cache = await caches.open(CACHE_NAME);
  let response = null;
  let cacheable = false;
  try {
    ({ response, cacheable } = await fetchPage(request));
  } catch {
    response = null;
  }
  // 서버 오류(5xx)도 못 받은 것으로 봄. 404 등은 그대로 보여줌
  if (response && response.status < 500) {
    if (cacheable && isSavedPage(url)) {
      const copy = response.clone();
      event.waitUntil(
        isThisBuild(copy.clone())
          .then((ok) => (ok ? cache.put(pageKey(url), copy) : undefined))
          .catch(() => {}),
      );
    }
    return response;
  }
  const saved = isSavedPage(url)
    ? await cache.match(pageKey(url), { ignoreSearch: true })
    : undefined;
  if (saved) return saved;
  // 저장하지 않는 화면(상세·검색 등)·저장본이 없는 화면: 같은 언어 오프라인 홈으로 보냄(홈은 설치 때 저장함)
  const home = homeFor(url);
  if (url.pathname !== home && (await cache.match(home))) {
    return Response.redirect(new URL(home, url.origin).href, 302);
  }
  return response ?? Response.error();
}

// _next/static·vendor: 이름에 해시·판 번호가 있어 내용이 바뀌지 않음 → 저장본 먼저
// 코드(chunks)는 설치 때 이 빌드 것을 모두 저장함. 나중에 받는 것은 글꼴·지도 작업자 파일만 저장(옛 빌드 코드를 새 캐시에 남기지 않음)
async function asset(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);
  const saved = await cache.match(request);
  if (saved) return saved;
  const response = await fetch(request);
  const path = new URL(request.url).pathname;
  if (
    response.ok &&
    response.type === "basic" &&
    (path.startsWith("/_next/static/media/") || path.startsWith("/vendor/"))
  ) {
    const copy = response.clone();
    event.waitUntil(cache.put(request, copy).catch(() => {}));
  }
  return response;
}
