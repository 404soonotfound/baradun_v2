import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ManifestFile, StatusFile } from "@baradun/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEV_DATA_REFRESH_INTERVAL_MS,
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
  for (const child of runningChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
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
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.FAKE_NEXT_READY, "ready");
const stop = () => {
  fs.writeFileSync(process.env.FAKE_NEXT_STOPPED, "stopped");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1_000);
`,
  );
  chmodSync(executable, 0o755);
  return { bin, ready, stopped };
}

function startDevCommand({
  root,
  outDir,
  disabled = false,
}: {
  root: string;
  outDir: string;
  disabled?: boolean;
}): { child: ChildProcess; ready: string; stopped: string } {
  const fake = fakeNext(root);
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "dev.mts")],
    {
      cwd: path.join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        PATH: `${fake.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        BARADUN_DEV_DATA: disabled ? "off" : undefined,
        BARADUN_DEV_DATA_DIR: outDir,
        FAKE_NEXT_READY: fake.ready,
        FAKE_NEXT_STOPPED: fake.stopped,
      },
      stdio: "ignore",
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
  it("계약 예시의 b0001~b0003만 새 버전 경로에 게시함", () => {
    const { examplesDir, outDir } = fixture();

    writeDevData({
      examplesDir,
      outDir,
      nowMs: Date.parse("2026-10-28T06:00:12Z"),
    });

    const manifest = manifestAt(outDir);
    expect(manifest.snapshotVersion).toBe("20261028T060000Z");
    expect(manifest.files.status).toBe(
      "/data/20261028T060000Z/status.json",
    );
    const status = readJson<StatusFile>(
      path.join(outDir, manifest.snapshotVersion, "status.json"),
    );
    expect(Object.keys(status.beaches)).toEqual(["b0001", "b0002", "b0003"]);
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
});

describe("개발 서버 실행", () => {
  it("예시 데이터를 먼저 만들고 종료할 때 개발 서버 자식도 종료함", async () => {
    const { outDir } = fixture();
    const root = path.dirname(outDir);
    const { child, ready, stopped } = startDevCommand({ root, outDir });

    await waitForFile(ready);
    expect(existsSync(path.join(outDir, "manifest.json"))).toBe(true);

    await stopChild(child);
    expect(existsSync(stopped)).toBe(true);
  });

  it("BARADUN_DEV_DATA=off이면 예시 데이터 없이 개발 서버만 실행함", async () => {
    const { outDir } = fixture();
    const root = path.dirname(outDir);
    const { child, ready, stopped } = startDevCommand({
      root,
      outDir,
      disabled: true,
    });

    await waitForFile(ready);
    expect(existsSync(outDir)).toBe(false);

    await stopChild(child);
    expect(existsSync(stopped)).toBe(true);
  });
});
