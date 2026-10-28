// 개발용 예시 바다 데이터 (BRD-26)
// 계약 예시(packages/contracts/examples/valid)의 시각을 지금으로 옮겨 public/data에 씀.
// 저장소에 넣지 않음(.gitignore) · 계약 예시의 상태별 해변만 게시하고 나머지는 채우지 않음
//   npm run dev:data -w apps/web            예시 데이터 한 번 만들기 (같은 분에 다시 실행하면 원본 변경을 반영함)
//                                           npm run dev(예시 끔)는 시작할 때 이 예시를 지움. 화면에서 보려면 dev:sample
//   npm run dev:data -w apps/web -- --clean 지우기
//   --check                                 빌드 전 검사: public/data가 있으면 빌드를 멈춤
// 실행: Node 22.18 이상은 .mts를 그대로 실행함(타입만 지우고 실행, 저장소 .nvmrc는 22.23)
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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
const VERSION_DIR = /^\d{8}T\d{6}Z$/;

export const DEV_DATA_REFRESH_INTERVAL_MS = 20 * 60_000;
export const DEV_DATA_MODE_FILE = ".dev-data-mode";
// 갱신 시각을 확인하는 간격. 잠자기로 타이머가 밀려도 깨어난 뒤 1분 안에 따라잡음
const REFRESH_CHECK_MS = 60_000;
// 탐색기·Finder가 폴더를 열면 저절로 만드는 파일. 사용자 데이터가 아니라 예시 폴더 판단에서 뺌
const OS_METADATA = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
// 중간에 죽은 실행이 남긴 임시 폴더를 지우는 기준. 쓰는 중인 다른 갱신기의 임시 폴더는 몇 초 안에 끝나므로 넉넉히 둠
const STALE_TEMP_MS = 10 * 60_000;
const TEMP_ENTRY = /^\..*\.tmp$/;

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
      Object.entries(value).map(([key, item]) => [key, shifted(item, shiftMs)]),
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

function isAlreadyPublished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  // Windows는 이미 있는 폴더 이름으로 옮기면 EPERM을 냄. 다른 운영체제의 EPERM은 실제 권한 오류라 그대로 던짐.
  return (
    code === "EEXIST" ||
    code === "ENOTEMPTY" ||
    (code === "EPERM" && process.platform === "win32")
  );
}

/** 같은 버전 폴더가 이미 있으면 내용이 같을 때만 유지하고, 다르면 새 내용으로 바꿈. */
function publishVersion(
  staged: string,
  published: string,
  bodies: Array<{ name: string }>,
): void {
  try {
    renameSync(staged, published);
    return;
  } catch (error) {
    // 다른 갱신기가 같은 분에 먼저 게시한 경우도 여기로 옴. 서버를 멈출 오류가 아님.
    if (!isAlreadyPublished(error)) throw error;
  }

  const same = bodies.every(({ name }) => {
    try {
      return (
        readFileSync(path.join(staged, name), "utf8") ===
        readFileSync(path.join(published, name), "utf8")
      );
    } catch {
      return false;
    }
  });
  if (same) {
    rmSync(staged, { recursive: true });
    return;
  }

  // 같은 분 안에 원본 예시를 고친 경우. 옛 폴더를 비켜 두고 새 내용으로 교체함.
  // 교체에 실패하면 옛 폴더를 되돌려 manifest가 가리키는 버전이 사라지지 않게 함.
  const replaced = temporaryPath(path.dirname(published), "replaced");
  renameSync(published, replaced);
  try {
    renameSync(staged, published);
  } catch (error) {
    renameSync(replaced, published);
    throw error;
  }
  rmSync(replaced, { recursive: true, force: true });
}

// 이 스크립트가 만드는 이름만 public/data에 있는지. 다른 파일이 섞인 폴더는 덮어쓰거나 지우지 않음.
function isOwnEntry(name: string): boolean {
  return (
    name === "manifest.json" ||
    name === DEV_DATA_MODE_FILE ||
    VERSION_DIR.test(name) ||
    (name.startsWith(".") && name.endsWith(".tmp")) ||
    OS_METADATA.has(name)
  );
}

function foreignEntries(outDir: string): string[] {
  return existsSync(outDir)
    ? readdirSync(outDir).filter((name) => !isOwnEntry(name))
    : [];
}

function currentVersion(outDir: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(outDir, "manifest.json"), "utf8"),
    ) as Partial<ManifestFile>;
    return typeof manifest.snapshotVersion === "string"
      ? manifest.snapshotVersion
      : null;
  } catch {
    return null;
  }
}

// 이전 manifest를 읽은 브라우저가 그 버전 파일을 받는 중일 수 있어 직전 버전까지만 남김.
// 10분 넘은 임시 폴더(중간에 죽은 실행의 흔적)도 함께 지움.
function pruneVersions(
  outDir: string,
  keep: Array<string | null>,
  nowMs: number,
): void {
  for (const entry of readdirSync(outDir)) {
    const target = path.join(outDir, entry);
    if (VERSION_DIR.test(entry) && !keep.includes(entry)) {
      rmSync(target, { recursive: true, force: true });
    } else if (TEMP_ENTRY.test(entry)) {
      try {
        if (nowMs - statSync(target).mtimeMs > STALE_TEMP_MS) {
          rmSync(target, { recursive: true, force: true });
        }
      } catch {
        // 다른 갱신기가 막 옮기거나 지운 경우
      }
    }
  }
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
  const version = snapshotVersionAt(sourceManifest.snapshotVersion, shiftMs);
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

  const foreign = foreignEntries(outDir);
  if (foreign.length > 0) {
    throw new Error(
      `${outDir}에 예시 데이터가 아닌 파일이 있어 쓰지 않았어요(${foreign.join(", ")}). 그 파일을 옮기거나 지운 뒤 다시 실행하세요`,
    );
  }

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

    publishVersion(stagedVersion, publishedVersion, bodies);

    const previousVersion = currentVersion(outDir);
    writeFileSync(path.join(outDir, DEV_DATA_MODE_FILE), "sample\n");
    writeFileSync(stagedManifest, JSON.stringify(manifest, null, 2));
    renameSync(stagedManifest, path.join(outDir, "manifest.json"));
    pruneVersions(outDir, [version, previousVersion], Date.now());
  } catch (error) {
    rmSync(stagedVersion, { recursive: true, force: true });
    rmSync(stagedManifest, { force: true });
    throw error;
  }

  return version;
}

/**
 * 예시를 끈 개발 서버가 지난 예시를 계속 서빙하지 않도록 정리함.
 * 표지가 sample이고 이 스크립트가 만든 이름만 있는 폴더만 지움.
 * 그 밖의 폴더는 출처를 모르므로 남기고 알림(화면은 manifest가 있으면 예시로 표시함).
 */
export function clearDevSampleData(
  outDir: string = DEFAULT_OUT,
): "removed" | "unmarked" | "foreign" | "none" {
  if (!existsSync(outDir)) return "none";
  let mode: string | null = null;
  try {
    mode = readFileSync(path.join(outDir, DEV_DATA_MODE_FILE), "utf8").trim();
  } catch {
    mode = null;
  }
  if (foreignEntries(outDir).length > 0) return "foreign";
  if (mode === "sample") {
    rmSync(outDir, { recursive: true, force: true });
    return "removed";
  }
  return "unmarked";
}

/**
 * 시작 즉시 한 번 만들고, 이후 벽시계 기준 intervalMs마다 갱신함. 반환 함수로 타이머를 멈춤.
 * setInterval만 쓰면 노트북 잠자기 동안 타이머가 멈춰 깨어난 뒤 예시가 만료된 채 남음.
 */
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
  let lastPublishedMs = now();
  const publish = () => {
    try {
      const nowMs = now();
      const version = writeDevData({ outDir, examplesDir, nowMs });
      // 실패하면 시각을 넘기지 않아 다음 확인(1분 뒤)에 다시 시도함
      lastPublishedMs = nowMs;
      onPublished?.(version);
    } catch (error) {
      onError(error);
    }
  };
  // 첫 생성 실패는 개발 서버를 시작하기 전에 호출자에게 그대로 알림.
  const firstVersion = writeDevData({
    outDir,
    examplesDir,
    nowMs: lastPublishedMs,
  });
  onPublished?.(firstVersion);
  const timer = setInterval(
    () => {
      if (now() - lastPublishedMs >= intervalMs) publish();
    },
    Math.min(intervalMs, REFRESH_CHECK_MS),
  );
  return () => clearInterval(timer);
}

export function devDataOutDir(): string {
  // 테스트는 실제 public/data와 격리함. 일반 개발에서는 지정하지 않아 기본 경로를 씀.
  return process.env.BARADUN_DEV_DATA_DIR ?? DEFAULT_OUT;
}

function main(): void {
  const mode = process.argv[2];
  const outDir = devDataOutDir();

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
    const foreign = foreignEntries(outDir);
    if (foreign.length > 0) {
      console.error(
        `public/data에 예시 데이터가 아닌 파일이 있어 지우지 않았어요(${foreign.join(", ")}). 확인 후 직접 정리하세요.`,
      );
      process.exitCode = 1;
      return;
    }
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
