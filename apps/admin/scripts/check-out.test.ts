import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkOut,
  injectMetaCsp,
  inlineScriptHashes,
  LOCAL_DEV_MARKER,
  POLICY_TAG,
  secretFindings,
  TRUSTED_TYPES,
  TRUSTED_TYPES_POLICY,
} from "./check-out.mts";

// 운영자 사이트 빌드 결과 검사 (BRD-147)

const NOINDEX = '<meta name="robots" content="noindex, nofollow, nocache"/>';
const CHARSET = '<meta charSet="utf-8"/>';
const page = (head = NOINDEX, body = "<script>self.x=1</script>") =>
  `<!DOCTYPE html><html><head>${CHARSET}${head}</head><body>${body}</body></html>`;

let dirs: string[] = [];
function out(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "admin-out-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const ROBOTS = "User-agent: *\nDisallow: /\n";

describe("injectMetaCsp", () => {
  it("인라인 스크립트 해시와 Trusted Types를 담은 CSP meta와 정책 스크립트를 charset meta 바로 뒤에 넣고, 다시 넣어도 하나씩만 둔다", () => {
    const html = injectMetaCsp(injectMetaCsp(page()));
    const hashes = inlineScriptHashes(page() + POLICY_TAG).join(" ");
    expect(html.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(html.split(POLICY_TAG)).toHaveLength(2);
    expect(html).toContain(
      `<head>${CHARSET}<meta http-equiv="Content-Security-Policy" content="script-src 'self' ${hashes}; ${TRUSTED_TYPES}">${POLICY_TAG}`,
    );
  });

  it("charset meta가 없으면 head 첫머리에 넣는다", () => {
    const html = injectMetaCsp(page().replace(CHARSET, ""));
    expect(html).toContain('<head><meta http-equiv="Content-Security-Policy"');
  });

  it("정책은 읽을 수 없는 주소에서도 던지지 않고 값을 돌려주지 않는다(브라우저가 위반으로 남기게)", () => {
    let rules: { createScriptURL: (u: string) => string | undefined } | null =
      null;
    const window = {
      trustedTypes: {
        createPolicy: (_: string, r: typeof rules) => (rules = r),
      },
    };
    const location = {
      href: "https://admin.example/login/",
      origin: "https://admin.example",
    };
    new Function("window", "trustedTypes", "location", TRUSTED_TYPES_POLICY)(
      window,
      window.trustedTypes,
      location,
    );
    const check = rules!.createScriptURL;
    expect(check("/_next/static/chunks/a.js")).toBe(
      "/_next/static/chunks/a.js",
    );
    expect(check("https://evil.example/_next/static/a.js")).toBeUndefined();
    expect(check("/other.js")).toBeUndefined();
    expect(check("http://[")).toBeUndefined();
  });

  it("src가 있는 스크립트는 해시에 넣지 않는다", () => {
    expect(inlineScriptHashes('<script src="/_next/a.js"></script>')).toEqual(
      [],
    );
  });
});

describe("checkOut", () => {
  it("검색 차단·CSP meta·robots.txt가 맞고 비밀값이 없으면 통과", () => {
    const dir = out({
      "index.html": injectMetaCsp(page()),
      "robots.txt": ROBOTS,
      "_next/static/a.js": "console.log(1)",
    });
    expect(checkOut(dir)).toEqual([]);
  });

  it("noindex meta가 없거나 CSP 해시가 빠진 페이지를 알린다", () => {
    const dir = out({
      "index.html": injectMetaCsp(page("")),
      "a/index.html": page(),
      "robots.txt": ROBOTS,
    });
    expect(checkOut(dir)).toEqual([
      "a/index.html: CSP meta 없음",
      "index.html: 검색 노출 차단 meta(noindex, nofollow) 없음",
    ]);
  });

  it("CSP meta에 Trusted Types가 없거나, 정책 스크립트가 없거나 맨 앞이 아니면 알린다(BRD-180)", () => {
    const built = injectMetaCsp(page());
    const dir = out({
      "index.html": built.replace(`; ${TRUSTED_TYPES}`, ""),
      "a/index.html": built.replace(POLICY_TAG, ""),
      "b/index.html": built
        .replace(POLICY_TAG, "")
        .replace("</head>", `${POLICY_TAG}</head>`)
        .replace("<head>", '<head><script src="/_next/static/a.js"></script>'),
      "robots.txt": ROBOTS,
    });
    expect(checkOut(dir)).toEqual([
      "a/index.html: Trusted Types 정책 스크립트 없음",
      "b/index.html: Trusted Types 정책 스크립트가 맨 앞 스크립트가 아님",
      "index.html: CSP meta에 Trusted Types 없음",
    ]);
  });

  it("charset meta가 앞 1024바이트 안에 없으면 알린다", () => {
    const dir = out({
      "index.html": injectMetaCsp(page()).replace(
        CHARSET,
        `<!--${"가".repeat(400)}-->${CHARSET}`,
      ),
      "robots.txt": ROBOTS,
    });
    expect(checkOut(dir)).toEqual([
      "index.html: charset meta가 앞 1024바이트 안에 없음",
    ]);
  });

  it("robots.txt가 전체 차단이 아니면 알린다", () => {
    const dir = out({
      "index.html": injectMetaCsp(page()),
      "robots.txt": "User-agent: *\nAllow: /\n",
    });
    expect(checkOut(dir)).toEqual([
      "robots.txt: 전체 차단(User-agent: * / Disallow: /)이 아님",
    ]);
  });

  it("화면 파일에 비밀값 모양이 있으면 알린다", () => {
    const dir = out({
      "index.html": injectMetaCsp(page()),
      "robots.txt": ROBOTS,
      "_next/static/b.js": 'const c={clientSecret:"abcdefgh1234"}',
    });
    expect(checkOut(dir)).toEqual([
      "_next/static/b.js: 비밀값 대입 모양이 있음",
    ]);
  });

  it("로컬 개발 서버 전용 테스트 로그인 코드가 남아 있으면 알린다(BRD-172)", () => {
    const dir = out({
      "index.html": injectMetaCsp(page()),
      "robots.txt": ROBOTS,
      "_next/static/c.js": `const m="${LOCAL_DEV_MARKER}"`,
    });
    expect(checkOut(dir)).toEqual([
      "_next/static/c.js: 로컬 개발 서버 전용 테스트 로그인 코드가 있음",
    ]);
  });

  it("HTML이 없으면 실패(빈 빌드를 통과로 보지 않음)", () => {
    expect(checkOut(out({ "robots.txt": ROBOTS }))[0]).toMatch(
      /HTML 파일이 없음/,
    );
  });
});

describe("secretFindings", () => {
  it("AWS 접근 키·개인 키를 찾고, Cognito 앱 클라이언트 ID 같은 공개 값은 막지 않는다", () => {
    expect(secretFindings("AKIA" + "A".repeat(16))).toEqual(["AWS 접근 키"]);
    expect(secretFindings("-----BEGIN RSA PRIVATE KEY-----")).toEqual([
      "개인 키",
    ]);
    expect(secretFindings('clientId:"0a1b2c3d4e5f6g7h8i9j0k1l2m"')).toEqual([]);
    // 문구 키의 한국어 값(띄어쓰기 없음)은 비밀값으로 보지 않음
    expect(secretFindings('"password":"비밀번호를입력하세요"')).toEqual([]);
  });
});
