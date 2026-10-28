// Next 개발 서버와 개발용 바다 데이터 갱신기를 한 생명주기로 실행함.
// 기본값과 off는 데이터를 만들지 않고 지난 예시를 지움. sample을 명시한 경우에만 예시를 갱신함.
// 모드는 --data=off|sample 인자(운영체제 무관) 또는 BARADUN_DEV_DATA로 정함. 인자가 우선함.
import { spawn, type ChildProcess } from "node:child_process";

import {
  clearDevSampleData,
  devDataOutDir,
  startDevDataRefresh,
} from "./dev-data.mts";

const DATA_FLAG = "--data=";
const args = process.argv.slice(2);
const flag = args.find((arg) => arg.startsWith(DATA_FLAG));
const nextArgs = args.filter((arg) => !arg.startsWith(DATA_FLAG));
const dataMode =
  flag?.slice(DATA_FLAG.length) ?? process.env.BARADUN_DEV_DATA ?? "off";
if (dataMode !== "off" && dataMode !== "sample") {
  throw new Error(`BARADUN_DEV_DATA는 off 또는 sample이어야 해요: ${dataMode}`);
}
const dataEnabled = dataMode === "sample";
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

const outDir = devDataOutDir();
if (dataEnabled) {
  stopRefresh = startDevDataRefresh({
    outDir,
    onPublished: (version) =>
      console.log(`[dev:data] ${version} 예시 데이터를 게시했어요`),
    onError: (error) => stop("SIGTERM", error),
  });
} else {
  const cleared = clearDevSampleData(outDir);
  if (cleared === "unmarked") {
    console.warn(
      "[dev:data] off — 출처 표지가 없는 public/data가 있어 예시로 표시해요. 지우려면 npm run dev:no-data -w apps/web",
    );
  } else {
    console.log(
      cleared === "removed"
        ? "[dev:data] off — 지난 예시 데이터를 지웠어요"
        : "[dev:data] off — 예시 데이터를 만들지 않아요",
    );
  }
}

server = spawn("next", ["dev", ...nextArgs], {
  env: process.env,
  stdio: "inherit",
  // Windows는 next.cmd라 셸을 거쳐야 실행됨.
  shell: process.platform === "win32",
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
