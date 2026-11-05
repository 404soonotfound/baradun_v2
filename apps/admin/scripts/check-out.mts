// 운영자 사이트 빌드 결과 검사 (BRD-147, 아키텍처 18.7)
// - 모든 HTML: 검색 노출 차단 meta(noindex·nofollow), 인라인 스크립트 해시 CSP meta, Trusted Types 정책(BRD-180)
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
import { parse, type DefaultTreeAdapterTypes } from "parse5";

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
// 앱끼리 코드를 공유하지 않아(ADR 0001) apps/web/scripts/csp-meta.mts extractInlineScriptHashes와 같은 순회를 따로 둠. 한쪽을 고치면 다른 쪽도 같이 고침
export function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  const document = parse(html);
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    if ("tagName" in node && node.tagName === "script") {
      if (node.attrs.some((attr) => attr.name === "src")) return;
      // 브라우저는 원문이 아니라 파서가 만든 본문(CRLF→LF·NUL 치환·SVG 문자 참조 해석 뒤)으로 해시함
      const body = node.childNodes
        .map((child) => ("value" in child ? child.value : ""))
        .join("");
      const hash = createHash("sha256").update(body, "utf8").digest("base64");
      hashes.add(`'sha256-${hash}'`);
    }
    if ("childNodes" in node) {
      for (const child of node.childNodes) visit(child);
    }
    // <template> 안 스크립트는 content에 있음(복제해 넣으면 실행되므로 해시 대상)
    if ("content" in node) visit(node.content);
  };
  visit(document);
  return [...hashes].sort();
}

const META_CSP =
  /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(?:"([^"]*)"|'([^']*)')\s*\/?>/i;

// Trusted Types(BRD-180): DOM에 문자열로 HTML·스크립트·스크립트 주소를 넣는 곳을 브라우저가 막음
// - 정책은 'default' 하나만 만들 수 있고, 페이지 맨 앞의 인라인 스크립트가 먼저 만듦(다른 스크립트가 정책을 만들지 못함)
// - default 정책은 Next가 JS 조각을 불러올 때 쓰는 같은 주소의 /_next/static/ 스크립트 주소만 그대로 통과시킴
//   (절대 주소로 바꿔 돌려주면 Next가 불러온 조각을 알아보지 못해 화면 이동이 멈춤)
// - 그 밖의 주소(읽을 수 없는 주소 포함)는 값을 돌려주지 않음 → 브라우저가 막고 CSP 위반으로 콘솔에 남김(E2E가 위반으로 잡음)
//   정책 안에서 throw하면 위반으로 남지 않으므로 주소 해석 오류도 삼킴
// - HTML·스크립트 문자열은 정책에 없으므로 늘 막힘(운영자 사이트 코드는 innerHTML을 쓰지 않음, 린트로도 막음)
export const TRUSTED_TYPES =
  "require-trusted-types-for 'script'; trusted-types default";
export const TRUSTED_TYPES_POLICY =
  'if(window.trustedTypes&&trustedTypes.createPolicy){trustedTypes.createPolicy("default",{createScriptURL:function(u){try{var x=new URL(u,location.href);if(x.origin===location.origin&&x.pathname.indexOf("/_next/static/")===0)return u}catch(e){}}})}';
export const POLICY_TAG = `<script id="baradun-trusted-types">${TRUSTED_TYPES_POLICY}</script>`;
const POLICY_SCRIPT = /<script id="baradun-trusted-types">[\s\S]*?<\/script>/i;

// 외부 스크립트 출처 없음(분석 도구를 넣지 않음). 'self'와 이 페이지 인라인 해시만 + Trusted Types
// head 첫머리에 CSP meta → 정책 스크립트 순서로 넣음(정책이 Next 스크립트보다 먼저 만들어지게)
// 첫머리가 charset meta면 그 뒤에 넣음. S3가 charset 없는 text/html로 주므로 charset meta가 앞 1024바이트 안에 있어야 함
export function injectMetaCsp(html: string): string {
  const clean = html.replace(META_CSP, "").replace(POLICY_SCRIPT, "");
  const head =
    /<head\b[^>]*>(?:<meta\s+charset=["']?[\w-]+["']?\s*\/?>)?/i.exec(clean);
  if (!head) throw new Error("<head> 태그를 찾지 못함");
  const scripts = [
    "script-src 'self'",
    ...inlineScriptHashes(clean + POLICY_TAG),
  ].join(" ");
  const tag = `<meta http-equiv="Content-Security-Policy" content="${scripts}; ${TRUSTED_TYPES}">`;
  const at = head.index + head[0].length;
  return clean.slice(0, at) + tag + POLICY_TAG + clean.slice(at);
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
      if (!content.includes(TRUSTED_TYPES)) {
        problems.push(`${rel(file)}: CSP meta에 Trusted Types 없음`);
      }
      if (!body.includes(POLICY_TAG)) {
        problems.push(`${rel(file)}: Trusted Types 정책 스크립트 없음`);
      } else if (body.search(/<script\b/i) !== body.indexOf(POLICY_TAG)) {
        // 정책이 Next 스크립트보다 먼저 만들어져야 함(늦으면 Next가 조각을 못 불러오거나 다른 정책이 먼저 생김)
        problems.push(
          `${rel(file)}: Trusted Types 정책 스크립트가 맨 앞 스크립트가 아님`,
        );
      }
      // S3가 charset 없는 text/html로 주므로 charset meta가 앞 1024바이트 안에 있어야 함(CSP meta를 앞에 넣어도 밀리지 않게)
      const charset = /<meta\s+charset=/i.exec(body);
      if (
        !charset ||
        Buffer.byteLength(body.slice(0, charset.index + charset[0].length)) >
          1024
      ) {
        problems.push(`${rel(file)}: charset meta가 앞 1024바이트 안에 없음`);
      }
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
