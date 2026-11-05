// 운영자 사이트 E2E용 정적 서버 (BRD-148). 빌드 결과(apps/admin/out)만 내보냄. Node 내장 http만 씀
// CloudFront와 같게: 폴더 주소는 index.html, 없는 파일은 403(S3 OAC). /ops/*는 내보내지 않음(테스트가 page.route로 채움)
// 로컬에서 실제 계정으로 볼 때만 OPS_PROXY(운영자 사이트 주소)를 주면 /ops/*를 그 주소로 넘김
// 응답 헤더 CSP·X-Robots-Tag는 infra/lib/admin/admin-site.ts와 같음(infra/test/admin-site.test.ts가 비교)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../out");
const PORT = Number(process.env.E2E_PORT ?? 3110);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

export const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self' https://cognito-idp.ap-northeast-2.amazonaws.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const ADMIN_HEADERS = {
  "content-security-policy": ADMIN_CSP,
  "x-robots-tag": "noindex, nofollow, noarchive",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

async function fileFor(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    // 잘못된 퍼센트 인코딩(/%zz)은 없는 파일과 같게 403. 예외가 서버를 끝내지 않게 함
    return null;
  }
  if (rel.endsWith("/")) rel += "index.html";
  else if (!path.basename(rel).includes(".")) rel += "/index.html";
  const full = path.join(OUT, rel);
  if (!full.startsWith(OUT)) return null;
  try {
    return (await stat(full)).isFile() ? full : null;
  } catch {
    return null;
  }
}

export function validateOpsProxyOrigin(raw) {
  if (!raw) return null;
  const proxy = new URL(raw);
  if (!["http:", "https:"].includes(proxy.protocol)) {
    throw new Error("OPS_PROXY는 http 또는 https 주소여야 함");
  }
  if (
    proxy.username ||
    proxy.password ||
    proxy.pathname !== "/" ||
    proxy.search ||
    proxy.hash
  ) {
    throw new Error("OPS_PROXY는 인증 정보·경로·쿼리가 없는 origin이어야 함");
  }
  return proxy.origin;
}

export function buildOpsProxyTarget(rawUrl, proxyOrigin) {
  if (!proxyOrigin) return null;
  let incoming;
  try {
    incoming = new URL(rawUrl ?? "/", "http://localhost");
  } catch {
    return null;
  }
  // origin-form·absolute-form 요청 모두 pathname만 사용함. URL 정규화 뒤 /ops 밖이거나
  // 인코딩·경로 순회 가능성이 있는 문자는 프록시하지 않음
  if (!/^\/ops(?:\/[A-Za-z0-9._~-]+)+\/?$/.test(incoming.pathname)) {
    return null;
  }
  const target = new URL(proxyOrigin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  return target;
}

// redirect: "manual"이라 3xx를 그대로 돌려주므로 Location도 넘김. OPS_PROXY 주소로 가는 Location은
// 이 서버 기준 경로로 바꿈(그대로 두면 브라우저가 다른 출처로 가서 CORS로 막힘). 다른 출처면 그대로 둠
export function proxyLocation(location, proxyOrigin) {
  if (!location) return null;
  let url;
  try {
    url = new URL(location, proxyOrigin);
  } catch {
    return null;
  }
  return url.origin === proxyOrigin
    ? `${url.pathname}${url.search}${url.hash}`
    : url.href;
}

async function proxyOps(req, res, target) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = { ...req.headers };
  delete headers.host;
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    redirect: "manual",
  });
  // 본문을 다 읽은 뒤 헤더를 보냄(읽다 실패하면 아직 헤더 전이라 502로 바꿀 수 있음)
  const body = Buffer.from(await upstream.arrayBuffer());
  const location = proxyLocation(
    upstream.headers.get("location"),
    target.origin,
  );
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
    ...(location ? { location } : {}),
  });
  res.end(body);
}

// 테스트가 헤더 값만 가져갈 때는 서버를 띄우지 않음(infra/test/admin-site.test.ts)
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// 서버를 띄울 때만 검사함(헤더 값만 가져가는 테스트가 개발자 환경의 OPS_PROXY 값 때문에 깨지지 않게)
const OPS_PROXY = isMain ? validateOpsProxyOrigin(process.env.OPS_PROXY) : null;

if (isMain)
  createServer(async (req, res) => {
    const proxyTarget = buildOpsProxyTarget(req.url, OPS_PROXY);
    if (proxyTarget) {
      await proxyOps(req, res, proxyTarget).catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      return;
    }
    // 프록시를 켰는데 넘기지 않은 /ops 요청은 정적 파일 403(권한 문제처럼 보임)이 아니라 400으로 알림
    if (OPS_PROXY && req.url?.startsWith("/ops")) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("OPS_PROXY로 넘기지 않는 /ops 경로");
      return;
    }
    const file = await fileFor(req.url ?? "/");
    if (!file) {
      res.writeHead(403, {
        ...ADMIN_HEADERS,
        "content-type": "application/xml",
      });
      res.end("<Error><Code>AccessDenied</Code></Error>");
      return;
    }
    res.writeHead(200, {
      ...ADMIN_HEADERS,
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    });
    res.end(await readFile(file));
  }).listen(PORT, "127.0.0.1", () =>
    console.log(`admin static http://127.0.0.1:${PORT}`),
  );
