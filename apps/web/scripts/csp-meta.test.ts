import { describe, expect, it } from "vitest";
import {
  buildMetaCspTag,
  extractInlineScriptHashes,
  injectMetaCsp,
  META_SCRIPT_SOURCES,
} from "./csp-meta.mts";

describe("CSP meta 주입 (BRD-118)", () => {
  it("인라인 스크립트의 sha256 해시를 올바른 형식('sha256-<base64>')으로 추출한다", () => {
    const html = `
      <html>
        <head><title>Test</title></head>
        <body>
          <script>console.log("hello");</script>
          <script src="/_next/static/chunks/app.js"></script>
          <script type="text/javascript">var a = 1;</script>
        </body>
      </html>
    `;
    const hashes = extractInlineScriptHashes(html);
    // 외부 스크립트(src=)는 제외되고 2개의 인라인 스크립트만 해시됨
    expect(hashes).toHaveLength(2);
    for (const hash of hashes) {
      expect(hash).toMatch(/^'sha256-[A-Za-z0-9+/=]+'$/);
    }
  });

  it("인라인 스크립트가 없으면 script-src 'self'와 GA 출처만 포함한다", () => {
    const meta = buildMetaCspTag([]);
    expect(meta).toBe(
      '<meta http-equiv="Content-Security-Policy" content="script-src \'self\' https://www.googletagmanager.com">',
    );
  });

  // meta에 넣은 외부 출처가 헤더에 없으면 둘 다 통과해야 하는 브라우저가 막음(BRD-143)
  it("meta CSP의 외부 스크립트 출처는 헤더 CSP(static-server)의 script-src에도 있다", async () => {
    const { buildCspHeader } = await import("../e2e/static-server.mjs");
    const header: string = buildCspHeader();
    const scriptSrc = header
      .split("; ")
      .find((directive) => directive.startsWith("script-src "));
    expect(scriptSrc).toBeDefined();
    for (const source of META_SCRIPT_SOURCES) {
      expect(scriptSrc!.split(" ")).toContain(source);
    }
  });

  it("<head> 태그 직후에 meta CSP 태그를 삽입한다", () => {
    const html = '<html><head><meta charset="utf-8"></head><body><script>var x = 10;</script></body></html>';
    const { html: result, hashes } = injectMetaCsp(html);
    expect(hashes).toHaveLength(1);
    expect(result).toContain(
      `<head><meta http-equiv="Content-Security-Policy" content="script-src 'self' https://www.googletagmanager.com ${hashes[0]}"><meta charset="utf-8">`,
    );
  });

  it("기존에 CSP meta 태그가 있으면 덮어쓴다", () => {
    const html = '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\' \'sha256-old\'"></head><body><script>var y = 20;</script></body></html>';
    const { html: result, hashes } = injectMetaCsp(html);
    expect(result).not.toContain("sha256-old");
    expect(result).toContain(hashes[0]);
  });
});
