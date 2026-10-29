import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ManifestFile, StatusFile } from "@baradun/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEV_DATA_REFRESH_INTERVAL_MS,
  DEV_DATA_MODE_FILE,
  clearDevData,
  startDevDataRefresh,
  writeDevData,
} from "./dev-data.mts";

const SOURCE_EXAMPLES = path.join(
  import.meta.dirname,
  "../../../packages/contracts/examples/valid",
);

const temporaryRoots: string[] = [];
const runningChildren: ChildProcess[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "baradun-dev-data-"));
  temporaryRoots.push(root);
  const examplesDir = path.join(root, "examples");
  const outDir = path.join(root, "public-data");
  cpSync(SOURCE_EXAMPLES, examplesDir, { recursive: true });
  return { examplesDir, outDir };
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function manifestAt(outDir: string): ManifestFile {
  return readJson(path.join(outDir, "manifest.json"));
}

afterEach(() => {
  vi.useRealTimers();
  // dev.mts를 SIGKILL하면 stop()이 돌지 않아 가짜 next가 남음. 프로세스 그룹째 끝냄.
  for (const child of runningChildren.splice(0)) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // 이미 모두 종료됨
    }
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${file} 생성 대기 시간 초과`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function fakeNext(root: string) {
  const bin = path.join(root, "bin");
  const ready = path.join(root, "next-ready");
  const stopped = path.join(root, "next-stopped");
  mkdirSync(bin);
  const executable = path.join(bin, "next");
  writeFileSync(
    executable,
    `const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_NEXT_READY, process.argv.slice(2).join(" "));
const stop = () => {
  fs.writeFileSync(process.env.FAKE_NEXT_STOPPED, "stopped");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1_000);
`,
  );
  return { bin, ready, stopped };
}

function startDevCommand({
  root,
  outDir,
  mode,
  args = [],
}: {
  root: string;
  outDir: string;
  mode?: "off" | "sample";
  args?: string[];
}): { child: ChildProcess; ready: string; stopped: string } {
  const fake = fakeNext(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BARADUN_NEXT_BIN: path.join(fake.bin, "next"),
    BARADUN_DEV_DATA_DIR: outDir,
    FAKE_NEXT_READY: fake.ready,
    FAKE_NEXT_STOPPED: fake.stopped,
  };
  if (mode) env.BARADUN_DEV_DATA = mode;
  else delete env.BARADUN_DEV_DATA;
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "dev.mts"), ...args],
    {
      cwd: path.join(import.meta.dirname, ".."),
      env,
      stdio: "ignore",
      // 자식(가짜 next)까지 한 프로세스 그룹으로 묶어 afterEach에서 함께 끝냄
      detached: true,
    },
  );
  runningChildren.push(child);
  return { child, ready: fake.ready, stopped: fake.stopped };
}

async function stopChild(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.kill("SIGTERM");
  await exited;
}

describe("개발용 예시 데이터 생성", () => {
  it("계약 예시에 명시한 상태별 해변만 새 버전 경로에 게시함", () => {
    const { examplesDir, outDir } = fixture();

    writeDevData({
      examplesDir,
      outDir,
      nowMs: Date.parse("2026-10-28T06:00:12Z"),
    });

    const manifest = manifestAt(outDir);
    expect(readFileSync(path.join(outDir, DEV_DATA_MODE_FILE), "utf8")).toBe(
      "sample\n",
    );
    expect(manifest.snapshotVersion).toBe("20261028T060000Z");
    expect(manifest.files.status).toBe("/data/20261028T060000Z/status.json");
    const status = readJson<StatusFile>(
      path.join(outDir, manifest.snapshotVersion, "status.json"),
    );
    expect(Object.keys(status.beaches)).toEqual([
      "b0001",
      "b0002",
      "b0003",
      "b0094",
      "b0107",
      "b0120",
      "b0157",
      "b0165",
      "b0272",
    ]);
  });

  it("새 버전을 완성하지 못하면 기존 manifest와 버전을 그대로 둠", () => {
    const { examplesDir, outDir } = fixture();
    writeDevData({
      examplesDir,
      outDir,
      nowMs: Date.parse("2026-10-28T06:00:12Z"),
    });
    const published = readFileSync(path.join(outDir, "manifest.json"), "utf8");

    rmSync(path.join(examplesDir, "history.json"));
    expect(() =>
      writeDevData({
        examplesDir,
        outDir,
        nowMs: Date.parse("2026-10-28T06:20:12Z"),
      }),
    ).toThrow();

    expect(readFileSync(path.join(outDir, "manifest.json"), "utf8")).toBe(
      published,
    );
    expect(existsSync(path.join(outDir, "20261028T062000Z"))).toBe(false);
    expect(readdirSync(outDir).some((name) => name.includes(".tmp"))).toBe(
      false,
    );
  });

  it("같은 분에 다시 실행하면 같은 내용은 유지하고 고친 원본은 반영함", () => {
    const { examplesDir, outDir } = fixture();
    const nowMs = Date.parse("2026-10-28T06:00:12Z");
    const statusFile = path.join(outDir, "20261028T060000Z", "status.json");

    writeDevData({ examplesDir, outDir, nowMs });
    const first = readFileSync(statusFile, "utf8");
    expect(() => writeDevData({ examplesDir, outDir, nowMs })).not.toThrow();
    expect(readFileSync(statusFile, "utf8")).toBe(first);

    const sourceFile = path.join(examplesDir, "status.json");
    const source = readJson<StatusFile>(sourceFile);
    source.beaches.b0001!.validUntil = "2026-10-17T06:10:00Z";
    writeFileSync(sourceFile, JSON.stringify(source));
    writeDevData({ examplesDir, outDir, nowMs: nowMs + 30_000 });

    expect(readFileSync(statusFile, "utf8")).not.toBe(first);
    expect(readdirSync(outDir).some((name) => name.includes(".tmp"))).toBe(
      false,
    );
  });

  it("현재와 직전 버전만 남기고 더 오래된 버전 폴더는 지움", () => {
    const { examplesDir, outDir } = fixture();
    const start = Date.parse("2026-10-28T06:00:12Z");
    for (const minutes of [0, 20, 40]) {
      writeDevData({ examplesDir, outDir, nowMs: start + minutes * 60_000 });
    }

    expect(
      readdirSync(outDir)
        .filter((name) => /^\d{8}T\d{6}Z$/.test(name))
        .sort(),
    ).toEqual(["20261028T062000Z", "20261028T064000Z"]);
  });
});

describe("중간에 죽은 실행의 임시 폴더", () => {
  it("10분 넘은 임시 폴더는 다음 게시 때 지우고, 쓰는 중일 수 있는 새 임시 폴더는 남김", () => {
    const { examplesDir, outDir } = fixture();
    writeDevData({ examplesDir, outDir });
    const stale = path.join(outDir, ".20261028T060000Z.1.abc.tmp");
    const fresh = path.join(outDir, ".20261028T060000Z.2.def.tmp");
    mkdirSync(stale);
    mkdirSync(fresh);
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(stale, old, old);

    writeDevData({ examplesDir, outDir });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("예시를 끈 개발 서버의 지난 예시 정리", () => {
  it("sample 표지가 있는 폴더만 지움", () => {
    const { examplesDir, outDir } = fixture();
    writeDevData({ examplesDir, outDir });

    expect(clearDevData(outDir)).toBe("removed");
    expect(existsSync(outDir)).toBe(false);
    expect(clearDevData(outDir)).toBe("none");
  });

  it("표지 없는 폴더는 출처를 모르므로 지우지 않음", () => {
    const { outDir } = fixture();
    mkdirSync(outDir);
    writeFileSync(path.join(outDir, "manifest.json"), "{}");

    expect(clearDevData(outDir)).toBe("unmarked");
    expect(existsSync(path.join(outDir, "manifest.json"))).toBe(true);
  });

  it("sample 표지가 있어도 다른 파일이 섞이면 지우지 않음", () => {
    const { examplesDir, outDir } = fixture();
    writeDevData({ examplesDir, outDir });
    writeFileSync(path.join(outDir, "mirror.json"), "{}");

    expect(clearDevData(outDir)).toBe("foreign");
    expect(existsSync(path.join(outDir, "mirror.json"))).toBe(true);
  });

  it("Finder가 만든 .DS_Store는 예시가 아닌 파일로 보지 않음", () => {
    const { examplesDir, outDir } = fixture();
    writeDevData({ examplesDir, outDir });
    writeFileSync(path.join(outDir, ".DS_Store"), "");

    expect(() => writeDevData({ examplesDir, outDir })).not.toThrow();
    expect(clearDevData(outDir)).toBe("removed");
  });

  it("--clean도 예시가 아닌 파일이 있으면 지우지 않고 실패함", () => {
    const { examplesDir, outDir } = fixture();
    writeDevData({ examplesDir, outDir });
    writeFileSync(path.join(outDir, "mirror.json"), "{}");
    const clean = () =>
      spawnSync(
        process.execPath,
        [path.join(import.meta.dirname, "dev-data.mts"), "--clean"],
        { env: { ...process.env, BARADUN_DEV_DATA_DIR: outDir } },
      );

    expect(clean().status).toBe(1);
    expect(existsSync(path.join(outDir, "mirror.json"))).toBe(true);

    rmSync(path.join(outDir, "mirror.json"));
    expect(clean().status).toBe(0);
    expect(existsSync(outDir)).toBe(false);
  });

  it("예시가 아닌 파일이 있는 폴더에는 예시를 쓰지 않음", () => {
    const { examplesDir, outDir } = fixture();
    mkdirSync(outDir);
    writeFileSync(path.join(outDir, "mirror.json"), "{}");

    expect(() => writeDevData({ examplesDir, outDir })).toThrow(/mirror\.json/);
    expect(existsSync(path.join(outDir, DEV_DATA_MODE_FILE))).toBe(false);
    expect(existsSync(path.join(outDir, "manifest.json"))).toBe(false);
  });
});

describe("개발용 예시 데이터 자동 갱신", () => {
  it("시작할 때 만들고 20분마다 시각과 snapshotVersion을 갱신하며 중지할 수 있음", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-28T06:00:12Z");
    const { examplesDir, outDir } = fixture();

    const stop = startDevDataRefresh({ examplesDir, outDir });
    expect(manifestAt(outDir).snapshotVersion).toBe("20261028T060000Z");
    const firstStatus = readJson<StatusFile>(
      path.join(outDir, "20261028T060000Z", "status.json"),
    );

    await vi.advanceTimersByTimeAsync(DEV_DATA_REFRESH_INTERVAL_MS);
    expect(manifestAt(outDir).snapshotVersion).toBe("20261028T062000Z");
    expect(manifestAt(outDir).generatedAt).toBe("2026-10-28T06:20:12Z");
    const nextStatus = readJson<StatusFile>(
      path.join(outDir, "20261028T062000Z", "status.json"),
    );
    expect(nextStatus.beaches.b0001?.validUntil).not.toBe(
      firstStatus.beaches.b0001?.validUntil,
    );
    // 직전에 manifest를 읽은 브라우저가 status를 받는 동안 404가 나지 않게 이전 버전도 유지함.
    expect(existsSync(path.join(outDir, "20261028T060000Z"))).toBe(true);

    stop();
    await vi.advanceTimersByTimeAsync(DEV_DATA_REFRESH_INTERVAL_MS);
    expect(manifestAt(outDir).snapshotVersion).toBe("20261028T062000Z");
  });

  it("주기 갱신이 실패해도 멈추지 않고 1분 뒤 다시 시도함", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-28T06:00:12Z");
    const { examplesDir, outDir } = fixture();
    const onError = vi.fn();
    const stop = startDevDataRefresh({ examplesDir, outDir, onError });

    // 편집기가 저장하는 중이라 예시 JSON을 읽지 못하는 순간
    const statusFile = path.join(examplesDir, "status.json");
    const original = readFileSync(statusFile, "utf8");
    writeFileSync(statusFile, "{");
    await vi.advanceTimersByTimeAsync(DEV_DATA_REFRESH_INTERVAL_MS);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(manifestAt(outDir).snapshotVersion).toBe("20261028T060000Z");

    writeFileSync(statusFile, original);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manifestAt(outDir).snapshotVersion).toBe("20261028T062100Z");

    stop();
  });

  it("잠자기로 타이머가 밀려도 벽시계가 지났으면 1분 안에 갱신함", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-28T06:00:12Z");
    const { examplesDir, outDir } = fixture();
    const stop = startDevDataRefresh({ examplesDir, outDir });

    // 잠자는 동안 타이머는 돌지 않고 벽시계만 2시간 지남
    vi.setSystemTime("2026-10-28T08:00:12Z");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manifestAt(outDir).snapshotVersion).toBe("20261028T080100Z");

    stop();
  });
});

// 프로세스를 띄우는 테스트는 waitForFile(5초)보다 넉넉한 제한 시간을 둠
describe("개발 서버 실행", { timeout: 20_000 }, () => {
  it("sample을 명시하면 예시 데이터를 먼저 만들고 종료할 때 개발 서버 자식도 종료함", async () => {
    const { outDir } = fixture();
    const root = path.dirname(outDir);
    const { child, ready, stopped } = startDevCommand({
      root,
      outDir,
      mode: "sample",
    });

    await waitForFile(ready);
    expect(existsSync(path.join(outDir, "manifest.json"))).toBe(true);

    await stopChild(child);
    expect(existsSync(stopped)).toBe(true);
  });

  it("기본값이면 예시 데이터를 먼저 만들고 개발 서버를 실행함", async () => {
    const { outDir } = fixture();
    const root = path.dirname(outDir);
    const { child, ready, stopped } = startDevCommand({ root, outDir });

    await waitForFile(ready);
    expect(existsSync(path.join(outDir, "manifest.json"))).toBe(true);

    await stopChild(child);
    expect(existsSync(stopped)).toBe(true);
  });

  it("--data=off 인자가 환경 변수보다 우선하고, 이 인자는 next에 넘기지 않음", async () => {
    const { outDir } = fixture();
    const root = path.dirname(outDir);
    const { child, ready, stopped } = startDevCommand({
      root,
      outDir,
      mode: "sample",
      args: ["--data=off"],
    });

    await waitForFile(ready);
    expect(existsSync(outDir)).toBe(false);
    expect(readFileSync(ready, "utf8")).toBe("dev");

    await stopChild(child);
    expect(existsSync(stopped)).toBe(true);
  });

  it("off면 지난 sample 예시를 지우고 시작함", async () => {
    const { examplesDir, outDir } = fixture();
    writeDevData({ examplesDir, outDir });
    const root = path.dirname(outDir);
    const { child, ready } = startDevCommand({ root, outDir, mode: "off" });

    await waitForFile(ready);
    expect(existsSync(outDir)).toBe(false);

    await stopChild(child);
  });

  it("BARADUN_DEV_DATA=off면 예시 데이터를 만들지 않음", async () => {
    const { outDir } = fixture();
    const root = path.dirname(outDir);
    const { child, ready, stopped } = startDevCommand({
      root,
      outDir,
      mode: "off",
    });

    await waitForFile(ready);
    expect(existsSync(outDir)).toBe(false);

    await stopChild(child);
    expect(existsSync(stopped)).toBe(true);
  });
});

describe("개발 실행 스크립트", () => {
  it("dev:no-data도 npm run dev를 거쳐 predev(토큰·지도 워커)를 실행함", () => {
    const { scripts } = readJson<{ scripts: Record<string, string> }>(
      path.join(import.meta.dirname, "../package.json"),
    );

    expect(scripts.predev).toContain("npm run tokens");
    // 셸에 BARADUN_DEV_DATA=sample이 남아 있어도 정리 직후 예시를 다시 만들지 않게 off를 명시함
    expect(scripts["dev:no-data"]).toMatch(/&& npm run dev -- --data=off$/);
  });
});
