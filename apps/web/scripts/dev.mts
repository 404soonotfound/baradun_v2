// Next 개발 서버와 개발용 바다 데이터 갱신기를 한 생명주기로 실행함.
// BARADUN_DEV_DATA=off이면 실패·오프라인·만료 화면 개발을 위해 데이터를 만들지 않음.
import { spawn, type ChildProcess } from "node:child_process";

import { startDevDataRefresh } from "./dev-data.mts";

const dataEnabled = process.env.BARADUN_DEV_DATA !== "off";
let server: ChildProcess | null = null;
let stopRefresh = () => {};
let stopping = false;
let failed = false;
let forceTimer: ReturnType<typeof setTimeout> | null = null;

function stop(signal: NodeJS.Signals = "SIGTERM", error?: unknown): void {
  if (error) {
    failed = true;
    console.error("개발용 예시 데이터 갱신을 멈췄어요.", error);
  }
  if (stopping) return;
  stopping = true;
  stopRefresh();

  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill(signal);
    forceTimer = setTimeout(() => {
      if (server && server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
      }
    }, 5_000);
    forceTimer.unref();
  }
}

if (dataEnabled) {
  const outDir = process.env.BARADUN_DEV_DATA_DIR;
  stopRefresh = startDevDataRefresh({
    ...(outDir ? { outDir } : {}),
    onPublished: (version) =>
      console.log(`[dev:data] ${version} 예시 데이터를 게시했어요`),
    onError: (error) => stop("SIGTERM", error),
  });
} else {
  console.log("[dev:data] BARADUN_DEV_DATA=off — 예시 데이터를 만들지 않아요");
}

server = spawn("next", ["dev", ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => stop(signal));
}

server.once("error", (error) => {
  failed = true;
  process.exitCode = 1;
  console.error("Next 개발 서버를 시작하지 못했어요.", error);
  stopRefresh();
});

server.once("exit", (code, signal) => {
  stopRefresh();
  if (forceTimer) clearTimeout(forceTimer);
  if (failed) {
    process.exitCode = 1;
  } else if (!stopping) {
    process.exitCode = code ?? (signal ? 1 : 0);
  }
});
