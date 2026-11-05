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
  let rel = decodeURIComponent(urlPath.split("?")[0]);
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
  if (!/^\/ops(?:\/[A-Za-z0-9._~-]+)*\/?$/.test(incoming.pathname)) {
    return null;
  }
  const target = new URL(proxyOrigin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  return target;
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
  // redirect: "manual"이라 3xx를 그대로 돌려주므로 Location도 함께 넘김(없으면 브라우저가 갈 곳을 모름)
  const location = upstream.headers.get("location");
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
    ...(location ? { location } : {}),
  });
  res.end(Buffer.from(await upstream.arrayBuffer()));
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
        res.writeHead(502);
        res.end();
      });
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
