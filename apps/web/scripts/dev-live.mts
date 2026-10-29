// 운영 snapshot 읽기 전용 미러 (BRD-109)
// BARADUN_DEV_DATA_ORIGIN(운영 CloudFront)의 /data/manifest.json과 버전 파일을 받아 public/data에 씀.
// 공개 정적 파일만 읽음: 인증 헤더·쿠키·비밀값을 보내지 않고, 사용자 위치도 보내지 않음.
// 받아오기 실패·시간 초과·형식 불일치는 게시하지 않고 기존 파일을 그대로 둠(화면은 만료·실패 경로로 보임).
//   npm run live (주소는 apps/web/.env.local 또는 셸 환경변수 BARADUN_DEV_DATA_ORIGIN)
import { existsSync } from "node:fs";
import path from "node:path";

import type { ManifestFile } from "@baradun/contracts";

import {
  VERSION_DIR,
  currentVersion,
  publishSnapshot,
  readDevDataMode,
} from "./dev-data.mts";

export const LIVE_ORIGIN_ENV = "BARADUN_DEV_DATA_ORIGIN";
// 운영 manifest를 확인하는 간격. 버전이 바뀐 경우에만 파일을 받음
export const LIVE_CHECK_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
// 한 파일 크기 상한. 운영 status는 수백 KB 수준이라 넉넉히 둠
const MAX_BYTES = 20 * 1024 * 1024;
const REQUIRED_FILES = [
  "beaches",
  "status",
  "history",
  "nationwideWarnings",
] as const;
const FILE_NAME = /^[a-z0-9-]+\.json$/;

type Fetch = typeof fetch;

interface LiveOptions {
  origin: string;
  outDir: string;
  fetchImpl?: Fetch;
  timeoutMs?: number;
  // 멈춘 뒤 늦게 끝난 요청이 public/data에 쓰지 않게 함
  signal?: AbortSignal;
}

/**
 * 운영 주소를 검사해 정규화함. https만 허용(시험용 localhost는 http 허용).
 * 사용자 정보가 든 주소·경로·쿼리가 있는 주소는 거부함(비밀값이 섞이지 않게).
 */
export function parseLiveOrigin(value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${LIVE_ORIGIN_ENV}에 운영 CloudFront 주소를 넣어야 해요(예: https://d123.cloudfront.net)`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${LIVE_ORIGIN_ENV}가 주소 형식이 아니에요: ${value}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(`${LIVE_ORIGIN_ENV}는 https 주소여야 해요: ${value}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      `${LIVE_ORIGIN_ENV}에 사용자 정보·쿼리를 넣지 마세요(공개 정적 주소만 써요)`,
    );
  }
  if (url.pathname !== "/") {
    throw new Error(
      `${LIVE_ORIGIN_ENV}는 경로 없이 도메인까지만 써요(/data/manifest.json은 붙여서 읽어요)`,
    );
  }
  return url.origin;
}

async function fetchText(
  fetchImpl: Fetch,
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, {
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`${url} 응답 ${response.status}`);
  }
  // 본문을 받기 전에 알려진 크기로 먼저 거름. 크기를 알리지 않는 응답은 받은 뒤 바이트로 확인함
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_BYTES) {
    throw new Error(`${url} 응답이 너무 커요(${declared}바이트)`);
  }
  const text = await response.text();
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_BYTES) {
    throw new Error(`${url} 응답이 너무 커요(${bytes}바이트)`);
  }
  return text;
}

/** 버전 경로가 /data/{snapshotVersion}/{이름}.json 꼴인지 확인하고 파일 이름을 돌려줌. */
function fileNameOf(file: unknown, version: string): string | null {
  if (typeof file !== "string") return null;
  const prefix = `/data/${version}/`;
  if (!file.startsWith(prefix)) return null;
  const name = file.slice(prefix.length);
  return FILE_NAME.test(name) ? name : null;
}

/**
 * 운영 manifest를 읽어 새 버전이면 파일을 받아 게시함. 같은 버전이면 아무것도 쓰지 않음.
 * 하나라도 실패하면 throw하고 public/data는 건드리지 않음.
 */
export async function mirrorLiveSnapshot({
  origin,
  outDir,
  fetchImpl = fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
  signal,
}: LiveOptions): Promise<{ version: string; changed: boolean }> {
  const base = parseLiveOrigin(origin);
  const manifestText = await fetchText(
    fetchImpl,
    `${base}/data/manifest.json`,
    timeoutMs,
    signal,
  );
  const manifest = JSON.parse(manifestText) as Partial<ManifestFile>;
  const version = manifest.snapshotVersion;
  if (typeof version !== "string" || !VERSION_DIR.test(version)) {
    throw new Error(`운영 manifest의 snapshotVersion을 읽을 수 없어요`);
  }
  const files = (manifest.files ?? {}) as Record<string, unknown>;
  const names = REQUIRED_FILES.map((key) => fileNameOf(files[key], version));
  if (names.some((name) => name === null)) {
    throw new Error(
      `운영 manifest의 파일 경로가 /data/${version}/… 꼴이 아니에요`,
    );
  }

  if (
    readDevDataMode(outDir) === "live" &&
    currentVersion(outDir) === version &&
    existsSync(path.join(outDir, version))
  ) {
    return { version, changed: false };
  }

  // 모두 받아 JSON인지 확인한 뒤에 게시함. 받은 내용은 바꾸지 않고 그대로 씀
  const bodies = await Promise.all(
    (names as string[]).map(async (name) => {
      const content = await fetchText(
        fetchImpl,
        `${base}/data/${version}/${name}`,
        timeoutMs,
        signal,
      );
      JSON.parse(content);
      return { name, content };
    }),
  );
  signal?.throwIfAborted();

  publishSnapshot({
    outDir,
    mode: "live",
    version,
    files: bodies,
    manifest: manifestText,
  });
  return { version, changed: true };
}

/**
 * 시작할 때 한 번 미러하고 이후 intervalMs마다 운영 manifest를 확인함. 반환 함수로 멈춤.
 * 실패해도 개발 서버를 끄지 않음(운영 장애·네트워크 끊김도 화면의 실패 경로로 확인).
 */
export function startLiveMirror({
  origin,
  outDir,
  fetchImpl,
  timeoutMs,
  intervalMs = LIVE_CHECK_INTERVAL_MS,
  onPublished,
  onError,
}: LiveOptions & {
  intervalMs?: number;
  onPublished?: (version: string) => void;
  onError?: (error: unknown) => void;
}): () => void {
  let running = false;
  const stopper = new AbortController();
  const check = async () => {
    // 느린 응답이 겹쳐 같은 버전을 두 번 쓰지 않게 한 번에 하나만 돌림
    if (running || stopper.signal.aborted) return;
    running = true;
    try {
      const result = await mirrorLiveSnapshot({
        origin,
        outDir,
        signal: stopper.signal,
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      if (result.changed) onPublished?.(result.version);
    } catch (error) {
      if (!stopper.signal.aborted) onError?.(error);
    } finally {
      running = false;
    }
  };
  void check();
  const timer = setInterval(() => void check(), intervalMs);
  return () => {
    stopper.abort();
    clearInterval(timer);
  };
}
