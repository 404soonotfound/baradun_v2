// 개발용 예시 바다 데이터 (BRD-26)
// 계약 예시(packages/contracts/examples/valid)의 시각을 지금으로 옮겨 public/data에 씀.
// 저장소에 넣지 않음(.gitignore) · 상태가 있는 해변은 b0001~b0003뿐
//   npm run dev:data -w apps/web            예시 데이터 한 번 만들기
//   npm run dev:data -w apps/web -- --clean 지우기
//   --check                                 빌드 전 검사: public/data가 있으면 빌드를 멈춤
// 실행: Node 22.18 이상은 .mts를 그대로 실행함(타입만 지우고 실행, 저장소 .nvmrc는 22.23)
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ManifestFile } from "@baradun/contracts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(WEB, "public/data");
const DEFAULT_EXAMPLES = path.join(
  WEB,
  "../../packages/contracts/examples/valid",
);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const DEV_DATA_REFRESH_INTERVAL_MS = 20 * 60_000;

interface DevDataPaths {
  outDir?: string;
  examplesDir?: string;
}

interface WriteDevDataOptions extends DevDataPaths {
  nowMs?: number;
}

interface RefreshOptions extends DevDataPaths {
  now?: () => number;
  intervalMs?: number;
  onPublished?: (version: string) => void;
  onError?: (error: unknown) => void;
}

function read(examplesDir: string, name: string): unknown {
  return JSON.parse(readFileSync(path.join(examplesDir, name), "utf8"));
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function shifted(value: unknown, shiftMs: number): unknown {
  if (typeof value === "string" && ISO.test(value)) {
    return isoOf(Date.parse(value) + shiftMs);
  }
  if (Array.isArray(value)) return value.map((item) => shifted(item, shiftMs));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        shifted(item, shiftMs),
      ]),
    );
  }
  return value;
}

function snapshotVersionAt(version: string, shiftMs: number): string {
  const versionIso = `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}T${version.slice(9, 11)}:${version.slice(11, 13)}:${version.slice(13, 15)}Z`;
  return isoOf(Date.parse(versionIso) + shiftMs).replace(/[-:]/g, "");
}

function temporaryPath(parent: string, label: string): string {
  return path.join(
    parent,
    `.${label}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
}

/** 완성된 버전 디렉터리를 먼저 게시한 뒤 manifest를 원자적으로 교체함. */
export function writeDevData({
  outDir = DEFAULT_OUT,
  examplesDir = DEFAULT_EXAMPLES,
  nowMs = Date.now(),
}: WriteDevDataOptions = {}): string {
  const sourceManifest = read(examplesDir, "manifest.json") as ManifestFile;
  const shiftMs =
    Math.floor((nowMs - Date.parse(sourceManifest.generatedAt)) / 60_000) *
    60_000;
  const version = snapshotVersionAt(
    sourceManifest.snapshotVersion,
    shiftMs,
  );
  const files: Record<string, string> = Object.fromEntries(
    Object.entries(sourceManifest.files).map(([key, file]) => [
      key,
      `/data/${version}/${path.basename(file)}`,
    ]),
  );

  // 쓰기 전에 모두 읽어 두면 원본 하나가 없거나 JSON이 깨졌을 때 게시 폴더를 전혀 건드리지 않음.
  const bodies = Object.values(files).map((file) => {
    const name = path.basename(file);
    return { name, body: shifted(read(examplesDir, name), shiftMs) };
  });
  const manifest = {
    ...(shifted(sourceManifest, shiftMs) as object),
    snapshotVersion: version,
    files,
  };

  mkdirSync(outDir, { recursive: true });
  const stagedVersion = temporaryPath(outDir, version);
  const publishedVersion = path.join(outDir, version);
  const stagedManifest = temporaryPath(outDir, "manifest.json");

  try {
    mkdirSync(stagedVersion);
    for (const { name, body } of bodies) {
      writeFileSync(
        path.join(stagedVersion, name),
        JSON.stringify(body, null, 2),
      );
    }

    if (existsSync(publishedVersion)) {
      // 같은 분 안에서 다시 실행하면 내용과 버전이 같음. 완성본을 유지함.
      rmSync(stagedVersion, { recursive: true });
    } else {
      renameSync(stagedVersion, publishedVersion);
    }

    // 이전 manifest를 읽은 브라우저가 그 버전 파일을 받는 중일 수 있어 옛 버전은 지우지 않음.
    writeFileSync(stagedManifest, JSON.stringify(manifest, null, 2));
    renameSync(stagedManifest, path.join(outDir, "manifest.json"));
  } catch (error) {
    rmSync(stagedVersion, { recursive: true, force: true });
    rmSync(stagedManifest, { force: true });
    throw error;
  }

  return version;
}

/** 시작 즉시 한 번 만들고, 이후 고정 간격으로 갱신함. 반환 함수로 타이머를 멈춤. */
export function startDevDataRefresh({
  outDir = DEFAULT_OUT,
  examplesDir = DEFAULT_EXAMPLES,
  now = Date.now,
  intervalMs = DEV_DATA_REFRESH_INTERVAL_MS,
  onPublished,
  onError = (error) => {
    throw error;
  },
}: RefreshOptions = {}): () => void {
  const publish = () => {
    try {
      const version = writeDevData({ outDir, examplesDir, nowMs: now() });
      onPublished?.(version);
    } catch (error) {
      onError(error);
    }
  };
  // 첫 생성 실패는 개발 서버를 시작하기 전에 호출자에게 그대로 알림.
  const firstVersion = writeDevData({ outDir, examplesDir, nowMs: now() });
  onPublished?.(firstVersion);
  const timer = setInterval(publish, intervalMs);
  return () => clearInterval(timer);
}

function cliOutDir(): string {
  // 테스트는 실제 public/data와 격리함. 일반 개발에서는 지정하지 않아 기본 경로를 씀.
  return process.env.BARADUN_DEV_DATA_DIR ?? DEFAULT_OUT;
}

function main(): void {
  const mode = process.argv[2];
  const outDir = cliOutDir();

  if (mode === "--check") {
    if (existsSync(outDir)) {
      console.error(
        "public/data에 개발용 예시 데이터가 있어요. npm run dev:data -w apps/web -- --clean 후 다시 빌드하세요.",
      );
      process.exitCode = 1;
    }
    return;
  }

  if (mode === "--clean") {
    rmSync(outDir, { recursive: true, force: true });
    console.log("public/data를 지웠어요");
    return;
  }

  const version = writeDevData({ outDir });
  console.log(`public/data/${version}에 예시 데이터를 썼어요`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
