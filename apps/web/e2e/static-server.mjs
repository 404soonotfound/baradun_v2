// E2E용 정적 서버 (BRD-39). 빌드 결과(apps/web/out)만 내보냄. 의존성 없이 Node 내장 http만 씀
// 정적 배포(CloudFront + S3, G3)와 같게: 폴더 주소는 index.html, 없는 주소는 404.html(상태 404)
// /data/**는 내보내지 않음(테스트가 page.route 가짜 응답으로 채움). 라우트가 빠지면 404가 나서 실패 경로로 보임
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../out");
const PORT = Number(process.env.E2E_PORT ?? 3109);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

// CloudFront 보안 응답 헤더 (BRD-118 · SiteDelivery/InquiryBackend와 동일)
function buildCspHeader(photoBucket) {
  const connectSources = ["'self'", "https://tiles.openfreemap.org"];
  if (photoBucket) {
    connectSources.push(`https://${photoBucket}.s3.ap-northeast-2.amazonaws.com`);
  }
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self'",
    "img-src 'self' blob: https://tiles.openfreemap.org https://tong.visitkorea.or.kr",
    "font-src 'self'",
    `connect-src ${connectSources.join(" ")}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(self)",
};

async function resolveFile(pathname) {
  const file = path.join(OUT, pathname);
  // out 밖으로 나가는 주소(../, 이름이 out으로 시작하는 형제 폴더 out2/ 등)는 막음
  if (file !== OUT && !file.startsWith(OUT + path.sep)) return null;
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      const index = path.join(file, "index.html");
      await stat(index);
      return index;
    }
    return file;
  } catch {
    return null;
  }
}

// 잘못된 % 인코딩(%E0%A4%A 등)은 예외로 서버가 죽지 않게 없는 주소(404)로 봄
function decodePath(url) {
  try {
    return decodeURIComponent(new URL(url ?? "/", "http://x").pathname);
  } catch {
    return null;
  }
}

function startServer() {
  return createServer(async (req, res) => {
    const pathname = decodePath(req.url);
    const file =
      pathname === null || pathname.startsWith("/data/")
        ? null
        : await resolveFile(pathname);
    const status = file ? 200 : 404;
    const target = file ?? path.join(OUT, "404.html");
    try {
      const body = await readFile(target);
      const photoBucket =
        process.env.NEXT_PUBLIC_INQUIRY_PHOTO_BUCKET ||
        process.env.CSP_PHOTO_BUCKET;
      res.writeHead(status, {
        ...SECURITY_HEADERS,
        "content-security-policy": buildCspHeader(photoBucket),
        "content-type":
          TYPES[path.extname(target)] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(500);
      res.end();
    }
  }).listen(PORT, "127.0.0.1", () => {
    console.log(`e2e static server: http://127.0.0.1:${PORT}`);
  });
}

const isMain =
  process.argv[1] &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith("/static-server.mjs"));

if (isMain) {
  startServer();
}

export { buildCspHeader, SECURITY_HEADERS, startServer };
