// 운영자 사이트 빌드 결과 검사 (BRD-147, 아키텍처 18.7)
// - 모든 HTML: 검색 노출 차단 meta(noindex·nofollow), 인라인 스크립트 해시 CSP meta
// - robots.txt: 전체 차단
// - 모든 파일: 비밀값 모양(접근 키·개인 키·비밀값 대입) 0건. 저장소가 공개라 화면 코드도 공개라는 전제
// - 모든 파일: 로컬 개발 서버 전용 테스트 로그인 코드 0건(BRD-172). 배포 빌드에 들어가면 비밀번호 없이 들어갈 길이 생김
// 실행:
//   node scripts/check-out.mts --write  CSP meta를 넣은 뒤 검사(postbuild)
//   node scripts/check-out.mts          고치지 않고 검사만(CI)
// CSP meta는 apps/web/scripts/csp-meta.mts와 같은 방식. 앱끼리는 packages/contracts로만 공유하므로 따로 둠
// (CloudFront 헤더 CSP의 script-src 'self' 'unsafe-inline'과 함께 적용되어 해시가 맞는 인라인만 실행됨)
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ADMIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(ADMIN, "out");

export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

// 인라인 <script> 본문의 sha256 목록('sha256-<base64>'). src가 있는 스크립트는 빼고 'self'로 허용
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const match of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
  )) {
    if (/\bsrc\s*=/i.test(match[1] ?? "")) continue;
    const hash = createHash("sha256")
      .update(match[2] ?? "", "utf8")
      .digest("base64");
    hashes.add(`'sha256-${hash}'`);
  }
  return [...hashes].sort();
}

const META_CSP =
  /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(?:"([^"]*)"|'([^']*)')\s*\/?>/i;

// 외부 스크립트 출처 없음(분석 도구를 넣지 않음). 'self'와 이 페이지 인라인 해시만
export function injectMetaCsp(html: string): string {
  const clean = html.replace(META_CSP, "");
  const head = /<head\b[^>]*>/i.exec(clean);
  if (!head) throw new Error("<head> 태그를 찾지 못함");
  const tag = `<meta http-equiv="Content-Security-Policy" content="${[
    "script-src 'self'",
    ...inlineScriptHashes(clean),
  ].join(" ")}">`;
  const at = head.index + head[0].length;
  return clean.slice(0, at) + tag + clean.slice(at);
}

const ROBOTS_META =
  /<meta\s+name=["']robots["']\s+content=["'][^"']*noindex[^"']*nofollow[^"']*["']/i;

// 비밀값 모양. 오탐이 나면 패턴을 좁히고, 실제 값을 넣어 통과시키지 않음
const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["AWS 접근 키", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["개인 키", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    "비밀값 대입",
    /\b(?:client_?secret|secret_?access_?key|api_?key|password)["']?\s*[:=]\s*["'][A-Za-z0-9+/=_-]{8,}["']/i,
  ],
];

export function secretFindings(text: string): string[] {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(
    ([name]) => name,
  );
}

// 로컬 테스트 로그인 표시. src/lib/auth/local-dev.ts LOCAL_MARKER와 같음(local-dev.test.ts가 확인)
export const LOCAL_DEV_MARKER = "baradun-local-dev";

const TEXT_FILE = /\.(?:html|js|mjs|css|txt|json|map|svg|xml)$/i;

// 문제 목록(없으면 빈 배열). 파일 경로는 out 기준 상대 경로
export function checkOut(outDir: string): string[] {
  const files = listFiles(outDir);
  const html = files.filter((f) => f.endsWith(".html"));
  if (html.length === 0) return [`HTML 파일이 없음: ${outDir}`];
  const problems: string[] = [];
  const rel = (f: string) => path.relative(outDir, f);

  for (const file of html) {
    const body = readFileSync(file, "utf8");
    if (!ROBOTS_META.test(body)) {
      problems.push(
        `${rel(file)}: 검색 노출 차단 meta(noindex, nofollow) 없음`,
      );
    }
    const meta = META_CSP.exec(body);
    if (!meta) {
      problems.push(`${rel(file)}: CSP meta 없음`);
    } else {
      const content = meta[1] ?? meta[2] ?? "";
      for (const hash of inlineScriptHashes(body)) {
        if (!content.includes(hash)) {
          problems.push(
            `${rel(file)}: 인라인 스크립트 해시 ${hash}가 CSP meta에 없음`,
          );
        }
      }
    }
  }

  const robots = path.join(outDir, "robots.txt");
  const robotsBody = existsSync(robots) ? readFileSync(robots, "utf8") : "";
  if (!/User-agent:\s*\*\s*\n\s*Disallow:\s*\/\s*$/im.test(robotsBody)) {
    problems.push("robots.txt: 전체 차단(User-agent: * / Disallow: /)이 아님");
  }

  for (const file of files.filter((f) => TEXT_FILE.test(f))) {
    for (const name of secretFindings(readFileSync(file, "utf8"))) {
      problems.push(`${rel(file)}: ${name} 모양이 있음`);
    }
    if (readFileSync(file, "utf8").includes(LOCAL_DEV_MARKER)) {
      problems.push(
        `${rel(file)}: 로컬 개발 서버 전용 테스트 로그인 코드가 있음`,
      );
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outDir = DEFAULT_OUT;
  if (process.argv.includes("--write")) {
    for (const file of listFiles(outDir).filter((f) => f.endsWith(".html"))) {
      writeFileSync(file, injectMetaCsp(readFileSync(file, "utf8")), "utf8");
    }
  }
  const problems = checkOut(outDir);
  if (problems.length > 0) {
    console.error(problems.map((p) => `- ${p}`).join("\n"));
    process.exit(1);
  }
  console.log(
    "운영자 사이트 빌드 결과 검사 통과(검색 차단·CSP meta·비밀값·로컬 로그인 0건)",
  );
}
