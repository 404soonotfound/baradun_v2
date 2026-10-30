// HTML 파일에 페이지별 인라인 스크립트 해시 CSP meta 태그 넣기 (BRD-118)
// Next.js 정적 내보내기는 요청 시점 Nonce를 쓸 수 없어, 빌드 뒤(postbuild) 각 HTML의 인라인 <script>
// 내용을 sha256으로 계산해 <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'sha256-…' …">를
// <head> 첫머리에 넣음. CloudFront 헤더의 script-src 'self' 'unsafe-inline'과 함께 적용돼
// (두 정책 모두 통과해야 실행) 실제로는 해시가 맞는 인라인만 실행됨.
// 실행:
//   node scripts/csp-meta.mts          out의 모든 HTML에 meta CSP 주입 및 검증
//   node scripts/csp-meta.mts --check  수정 없이 모든 HTML의 meta CSP 해시 일치 검사만 수행
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(WEB, "out");

// HTML 파일 목록 재귀 탐색
export function listHtmlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return listHtmlFiles(full);
    }
    return entry.name.endsWith(".html") ? [full] : [];
  });
}

// 인라인 <script> 본문들의 sha256 해시 목록 계산 ('sha256-<base64>' 형식)
export function extractInlineScriptHashes(html: string): string[] {
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const hashes = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";
    // 외부 스크립트(src="...")는 인라인 해시 대상이 아님
    if (/\bsrc\s*=/i.test(attrs)) {
      continue;
    }
    // 인라인 스크립트 본문 원문 그대로 sha256 해시 계산
    const hash = createHash("sha256").update(body, "utf8").digest("base64");
    hashes.add(`'sha256-${hash}'`);
  }

  return [...hashes].sort();
}

// 메타 CSP 태그 생성
export function buildMetaCspTag(hashes: readonly string[]): string {
  const directives = ["script-src 'self'", ...hashes];
  return `<meta http-equiv="Content-Security-Policy" content="${directives.join(" ")}">`;
}

export const META_CSP_REGEX =
  /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(?:"([^"]*)"|'([^']*)')\s*\/?>/i;

// HTML에 meta CSP 태그 주입 또는 갱신 (<head> 첫머리에 배치)
export function injectMetaCsp(html: string): { html: string; hashes: string[] } {
  // 이미 존재하는 CSP meta 태그가 있으면 먼저 제거
  const cleanHtml = html.replace(META_CSP_REGEX, "");

  // 인라인 스크립트 해시 추출
  const hashes = extractInlineScriptHashes(cleanHtml);
  const metaTag = buildMetaCspTag(hashes);

  // <head> 태그 직후에 메타 태그 삽입
  const headMatch = /<head\b([^>]*)>/i.exec(cleanHtml);
  if (!headMatch) {
    throw new Error("<head> 태그를 찾지 못함");
  }

  const insertIndex = headMatch.index + headMatch[0].length;
  const updatedHtml =
    cleanHtml.slice(0, insertIndex) + metaTag + cleanHtml.slice(insertIndex);

  return { html: updatedHtml, hashes };
}

// out 디렉터리의 모든 HTML 파일에 meta CSP 적용
export function applyMetaCsp(outDir: string = DEFAULT_OUT): number {
  const files = listHtmlFiles(outDir);
  if (files.length === 0) {
    throw new Error(`HTML 파일이 없음: ${outDir}`);
  }

  let count = 0;
  for (const file of files) {
    const original = readFileSync(file, "utf8");
    const { html: updated } = injectMetaCsp(original);
    if (updated !== original) {
      writeFileSync(file, updated, "utf8");
      count++;
    }
  }

  return count;
}

// out 디렉터리의 모든 HTML 파일의 meta CSP 해시 일치 여부 검증
export function verifyMetaCsp(outDir: string = DEFAULT_OUT): void {
  const files = listHtmlFiles(outDir);
  if (files.length === 0) {
    throw new Error(`HTML 파일이 없음: ${outDir}`);
  }

  for (const file of files) {
    const html = readFileSync(file, "utf8");
    const metaMatch = META_CSP_REGEX.exec(html);
    if (!metaMatch) {
      throw new Error(`${file}: CSP meta 태그가 없음`);
    }

    const content = metaMatch[1] ?? metaMatch[2] ?? "";
    const expectedHashes = extractInlineScriptHashes(html);

    for (const hash of expectedHashes) {
      if (!content.includes(hash)) {
        throw new Error(
          `${file}: 인라인 스크립트 해시 ${hash}가 CSP meta에 누락됨`,
        );
      }
    }
  }
}

// CLI 실행
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const isCheck = process.argv.includes("--check");
  if (isCheck) {
    verifyMetaCsp();
    console.log("모든 HTML 파일의 CSP meta 해시가 일치해요.");
  } else {
    const updated = applyMetaCsp();
    verifyMetaCsp();
    console.log(
      `HTML 파일 ${updated}곳에 CSP meta를 적용하고 검증을 마쳤어요.`,
    );
  }
}
