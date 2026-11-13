import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Playwright 설치를 빌드와 함께 돌리는 도구(.github/scripts/playwright-setup.sh)의 실패 경로 검사
// 가짜 npx를 PATH 맨 앞에 두고 돌림(실제 설치·네트워크 없음)
const script = path.resolve(
  __dirname,
  "../../.github/scripts/playwright-setup.sh",
);
const temps: string[] = [];
// 설치를 기다리는 테스트는 vitest 기본 제한(5초)보다 길게 둠(CI 실행기가 느릴 때 흔들리지 않게)
const SLOW = 30_000;

const sandbox = (npxBody: string) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "baradun-pw-setup-"));
  temps.push(root);
  const bin = path.join(root, "bin");
  const runnerTemp = path.join(root, "runner");
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  writeFileSync(path.join(bin, "npx"), `#!/usr/bin/env bash\n${npxBody}\n`);
  chmodSync(path.join(bin, "npx"), 0o755);
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        RUNNER_TEMP: runnerTemp,
        ...env,
      },
    });
  return { run, runnerTemp, state: path.join(runnerTemp, "playwright-setup") };
};

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Playwright 설치 도구", () => {
  it(
    "설치가 성공하면 wait가 로그를 보여 주고 0으로 끝난다",
    () => {
      const { run } = sandbox('echo "설치함: $*"');
      const start = run(["start", "install-deps", "chromium"]);
      expect(start.status).toBe(0);
      const wait = run(["wait"]);
      expect(wait.status).toBe(0);
      expect(wait.stdout).toContain(
        "설치함: --no-install playwright install-deps chromium",
      );
    },
    SLOW,
  );

  it(
    "start는 설치가 끝나기를 기다리지 않고, wait가 끝날 때까지 기다린다",
    () => {
      // 가짜 설치는 release 파일이 생길 때까지 끝나지 않음(걸린 시간을 재지 않아 느린 실행기에서도 흔들리지 않음)
      const { run, runnerTemp, state } = sandbox(
        'until [ -f "$RUNNER_TEMP/release" ]; do sleep 0.1; done; echo "늦게 끝남"',
      );
      expect(run(["start", "install-deps", "chromium"]).status).toBe(0);
      expect(existsSync(path.join(state, "exit"))).toBe(false);
      writeFileSync(path.join(runnerTemp, "release"), "");
      const wait = run(["wait"]);
      expect(wait.status).toBe(0);
      expect(wait.stdout).toContain("늦게 끝남");
    },
    SLOW,
  );

  it(
    "설치가 실패하면 wait도 실패하고 로그와 종료 코드를 알린다",
    () => {
      const { run } = sandbox('echo "apt 실패" >&2; exit 3');
      expect(run(["start", "install-deps", "chromium"]).status).toBe(0);
      const wait = run(["wait"]);
      expect(wait.status).toBe(1);
      expect(wait.stdout).toContain("apt 실패");
      expect(wait.stdout).toContain("::error::");
      expect(wait.stdout).toContain("종료 코드 3");
    },
    SLOW,
  );

  it("설치를 시작한 기록이 없으면 wait가 실패한다", () => {
    const { run } = sandbox("exit 0");
    const wait = run(["wait"]);
    expect(wait.status).toBe(1);
    expect(wait.stdout).toContain("::error::");
  });

  it(
    "설치가 종료 코드를 남기지 않고 죽으면 wait가 실패한다",
    () => {
      // 감싼 셸까지 함께 죽여 종료 코드 파일이 생기지 않게 함
      const { run } = sandbox('kill -9 "$PPID"; sleep 5');
      expect(run(["start", "install-deps", "chromium"]).status).toBe(0);
      const wait = run(["wait"]);
      expect(wait.status).toBe(1);
      expect(wait.stdout).toContain("::error::");
    },
    SLOW,
  );

  it(
    "제한 시간 안에 끝나지 않으면 wait가 실패한다",
    () => {
      const { run } = sandbox("sleep 20");
      expect(run(["start", "install-deps", "chromium"]).status).toBe(0);
      const wait = run(["wait"], { PLAYWRIGHT_SETUP_TIMEOUT: "2" });
      expect(wait.status).toBe(1);
      expect(wait.stdout).toContain("::error::");
      expect(wait.stdout).toContain("2초");
    },
    SLOW,
  );

  it(
    "제한 시간 값이 숫자가 아니면 wait가 기다리지 않고 실패한다",
    () => {
      const { run } = sandbox("sleep 20");
      expect(run(["start", "install-deps", "chromium"]).status).toBe(0);
      const wait = run(["wait"], { PLAYWRIGHT_SETUP_TIMEOUT: "10분" });
      expect(wait.status).toBe(1);
      expect(wait.stdout).toContain("::error::");
      expect(wait.stdout).toContain("PLAYWRIGHT_SETUP_TIMEOUT");
    },
    SLOW,
  );

  it(
    "종료 코드 파일이 숫자가 아니면 wait가 실패한다",
    () => {
      const { run, state } = sandbox("exit 0");
      expect(run(["start", "install-deps", "chromium"]).status).toBe(0);
      expect(run(["wait"]).status).toBe(0);
      writeFileSync(path.join(state, "exit"), "\n");
      const wait = run(["wait"]);
      expect(wait.status).toBe(1);
      expect(wait.stdout).toContain("::error::");
    },
    SLOW,
  );

  it("인자가 없거나 모르는 명령이면 실패한다", () => {
    const { run } = sandbox("exit 0");
    expect(run(["start"]).status).toBe(1);
    expect(run([]).status).toBe(1);
    expect(run(["stop"]).status).toBe(1);
  });
});
