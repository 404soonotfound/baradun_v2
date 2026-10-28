// 서비스 워커 만들기 (BRD-42). next build 뒤(postbuild) out/sw.js를 씀
// scripts/service-worker.js 앞에 이 빌드의 ID와 미리 저장할 경로 목록을 붙임 → 빌드마다 sw.js 내용이 달라져
// 브라우저가 새 워커를 받음. 미리 저장: 두 언어 탭 화면 HTML 8개 + 앱 셸(이 빌드의 코드 _next/static/chunks·빌드 ID 폴더
// + 그 HTML이 미리 받는 글꼴). 다른 화면(상세·검색 등)의 HTML은 열어도 저장하지 않음(결정 29). 나중에 받는 글꼴·지도 작업자
// 파일만 열 때 저장됨(service-worker.js). 앱 아이콘은 화면을 그리는 데 쓰지 않고 설치 때 OS가 받아 두므로 미리 저장하지 않음
// 실행: node scripts/build-sw.mts (Node 22.18 이상은 .mts를 그대로 실행, dev-data.mts와 같음)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// 오프라인으로 새로 열 수 있어야 하는 화면(trailingSlash 주소): 하단 탭·상단 메뉴 화면(lib/nav.ts TABS와 같음, 테스트로 확인)
// 홈("/"·"/en/")은 저장하지 않는 화면의 대신 화면이라 반드시 있어야 함. 워커는 이 목록의 화면 HTML만 저장함
const TAB_PATHS = ["/", "/explore/", "/favorites/", "/settings/"];
export const OFFLINE_PAGES = [
  ...TAB_PATHS,
  ...TAB_PATHS.map((tab) => `/en${tab}`),
];

function listFiles(dir: string, base: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    const url = `${base}/${entry.name}`;
    return entry.isDirectory() ? listFiles(full, url) : [url];
  });
}

// 미리 저장할 경로. 화면 HTML에 빌드 ID가 없으면(Next 출력 형식이 바뀜) 워커가 HTML을 저장하지 못하므로 빌드를 멈춤
export function precacheList(outDir: string, buildId: string): string[] {
  const media = new Set<string>();
  for (const page of OFFLINE_PAGES) {
    const file = path.join(outDir, page, "index.html");
    if (!existsSync(file)) throw new Error(`${page}: index.html 없음`);
    const html = readFileSync(file, "utf8");
    if (!html.includes(buildId)) {
      throw new Error(`${page}: HTML에 빌드 ID(${buildId})가 없음`);
    }
    for (const [url] of html.matchAll(/\/_next\/static\/media\/[^"'\\\s)]+/g)) {
      media.add(url);
    }
  }
  const code = [
    ...listFiles(
      path.join(outDir, "_next/static/chunks"),
      "/_next/static/chunks",
    ),
    ...listFiles(
      path.join(outDir, "_next/static", buildId),
      `/_next/static/${buildId}`,
    ),
  ];
  if (code.length === 0) throw new Error("_next/static 코드 파일 없음");
  return [...OFFLINE_PAGES, ...code.sort(), ...[...media].sort()];
}

// SW_PAGES: HTML을 저장하는 화면(탭 화면). 워커는 이 목록으로만 화면을 가림(미리 저장 때 HTML 확인·저장·저장본 사용)
// 화면은 미리 저장 목록에도 있어야 함(설치 때 받아 둬야 오프라인에서 열림)
export function serviceWorkerSource(
  buildId: string,
  precache: string[],
  source: string,
  pages: readonly string[] = OFFLINE_PAGES,
): string {
  const missing = pages.filter((page) => !precache.includes(page));
  if (missing.length > 0) {
    throw new Error(`미리 저장 목록에 없는 화면: ${missing.join(", ")}`);
  }
  return [
    `// 생성 파일(scripts/build-sw.mts). 직접 고치지 않음`,
    `const SW_BUILD = ${JSON.stringify(buildId)};`,
    `const SW_PRECACHE = ${JSON.stringify(precache)};`,
    `const SW_PAGES = ${JSON.stringify(pages)};`,
    source,
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = path.join(WEB, "out");
  const buildId = readFileSync(path.join(WEB, ".next/BUILD_ID"), "utf8").trim();
  if (!buildId) throw new Error(".next/BUILD_ID가 비어 있음");
  const precache = precacheList(outDir, buildId);
  const source = readFileSync(
    path.join(WEB, "scripts/service-worker.js"),
    "utf8",
  );
  writeFileSync(
    path.join(outDir, "sw.js"),
    serviceWorkerSource(buildId, precache, source),
  );
  console.log(`sw.js 만듦: 빌드 ${buildId}, 미리 저장 ${precache.length}개`);
}
