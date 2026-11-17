// Next 개발 서버와 개발용 바다 데이터 갱신기를 한 생명주기로 실행함.
// 기본값(sample)은 계약 예시로 만든 더미 데이터를 먼저 게시하고 20분마다 갱신함.
// live는 BARADUN_DEV_DATA_ORIGIN(운영 CloudFront)의 snapshot을 읽기 전용으로 미러함(npm run live, BRD-109).
// off는 데이터를 만들지 않고 지난 개발 데이터를 지움(데이터 없음 상태 확인용).
// scenario는 상태별 시나리오(특보 발효·관측 지연·점검 등)를 게시하고 20분마다 시각을 옮겨 다시 게시함(#550, --scenario=<이름>).
// 모드는 --data=off|sample|live 인자(운영체제 무관) 또는 BARADUN_DEV_DATA로 정함. 인자가 우선함. --scenario=를 주면 scenario 모드.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseEnv } from "node:util";

import {
  clearDevData,
  devDataOutDir,
  readDevDataMode,
  startDevDataRefresh,
} from "./dev-data.mts";
import {
  LIVE_ORIGIN_ENV,
  parseLiveOrigin,
  startLiveMirror,
} from "./dev-live.mts";
import {
  describeScenario,
  NO_DATA_VERSION,
  parseScenarioName,
  publishedMessage,
  readScenarioInputs,
  writeScenarioData,
} from "./dev-scenario.mts";

const DATA_FLAG = "--data=";
const SCENARIO_FLAG = "--scenario=";
const args = process.argv.slice(2);
const flag = args.find((arg) => arg.startsWith(DATA_FLAG));
const scenarioFlag = args.find((arg) => arg.startsWith(SCENARIO_FLAG));
const nextArgs = args.filter(
  (arg) => !arg.startsWith(DATA_FLAG) && !arg.startsWith(SCENARIO_FLAG),
);
// `BARADUN_DEV_DATA= npm run dev`처럼 빈 값으로 지운 환경 변수는 지정하지 않은 것으로 봄(기본 sample)
const dataMode =
  flag?.slice(DATA_FLAG.length) ??
  (scenarioFlag ? "scenario" : process.env.BARADUN_DEV_DATA || "sample");
if (
  dataMode !== "off" &&
  dataMode !== "sample" &&
  dataMode !== "live" &&
  dataMode !== "scenario"
) {
  throw new Error(
    `BARADUN_DEV_DATA는 off·sample·live·scenario 중 하나여야 해요: ${dataMode}`,
  );
}
// 시나리오 이름이 없거나 틀리면 개발 서버를 띄우기 전에 멈춤(고를 수 있는 이름을 알려 줌)
const scenarioName =
  dataMode === "scenario"
    ? parseScenarioName(scenarioFlag?.slice(SCENARIO_FLAG.length))
    : null;
if (scenarioFlag && dataMode !== "scenario") {
  throw new Error("--scenario=는 --data=scenario와만 함께 쓸 수 있어요");
}
// live 주소는 셸 환경변수, 없으면 apps/web/.env.local(git 제외)에서 찾음. 빈 값은 지정하지 않은 것으로 봄.
// 파일에서는 이 값만 꺼내고 process.env에 넣지 않음(Next가 .env.* 파일을 자기 순서대로 읽게 둠).
// BARADUN_DEV_ENV_FILE은 테스트가 개발자의 .env.local을 피할 때만 씀.
function readLocalLiveOrigin(): string | undefined {
  const file =
    process.env.BARADUN_DEV_ENV_FILE ??
    path.join(import.meta.dirname, "..", ".env.local");
  if (!existsSync(file)) return undefined;
  return parseEnv(readFileSync(file, "utf8"))[LIVE_ORIGIN_ENV];
}
// live 주소가 없거나 틀리면 개발 서버를 띄우기 전에 멈춤
const liveOrigin =
  dataMode === "live"
    ? parseLiveOrigin(process.env[LIVE_ORIGIN_ENV] || readLocalLiveOrigin())
    : null;
let server: ChildProcess | null = null;
let stopRefresh = () => {};
let stopping = false;
let failed = false;
let forceTimer: ReturnType<typeof setTimeout> | null = null;

function stop(signal: NodeJS.Signals): void {
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

// 다른 모드가 남긴 데이터는 먼저 지움. 예시와 운영 데이터가 섞여 보이지 않게 함
function clearOtherMode(): void {
  const previous = readDevDataMode(outDir);
  if (previous !== null && previous !== dataMode) clearDevData(outDir);
}

if (dataMode === "sample") {
  clearOtherMode();
  stopRefresh = startDevDataRefresh({
    outDir,
    onPublished: (version) =>
      console.log(`[dev:data] ${version} 예시 데이터를 게시했어요`),
    // 주기 갱신 한 번의 실패(편집 중인 예시 JSON 등)로 개발 서버를 끄지 않음. 1분 뒤 다시 시도함
    onError: (error) =>
      console.error(
        "[dev:data] 예시 갱신에 실패했어요. 1분 뒤 다시 시도해요.",
        error,
      ),
  });
} else if (scenarioName) {
  clearOtherMode();
  const inputs = readScenarioInputs();
  const write = (nowMs: number) =>
    writeScenarioData({ outDir, name: scenarioName, inputs, nowMs }) ??
    NO_DATA_VERSION;
  // next dev 주소 안내용 포트(-p·--port를 넘기지 않으면 3000)
  const portIndex = nextArgs.findIndex(
    (arg) => arg === "-p" || arg === "--port",
  );
  const port =
    nextArgs.find((arg) => arg.startsWith("--port="))?.slice(7) ??
    (portIndex >= 0 ? nextArgs[portIndex + 1] : undefined) ??
    "3000";
  for (const line of describeScenario(
    scenarioName,
    inputs,
    `http://localhost:${port}`,
  )) {
    console.log(line);
  }
  stopRefresh = startDevDataRefresh({
    outDir,
    write,
    onPublished: (version) =>
      console.log(publishedMessage(scenarioName, version)),
    onError: (error) =>
      console.error(
        "[scenario] 시나리오 갱신에 실패했어요. 1분 뒤 다시 시도해요.",
        error,
      ),
  });
} else if (liveOrigin) {
  clearOtherMode();
  console.log(
    `[dev:live] ${liveOrigin}의 운영 snapshot을 읽기 전용으로 미러해요`,
  );
  stopRefresh = startLiveMirror({
    origin: liveOrigin,
    outDir,
    onPublished: (version) =>
      console.log(`[dev:live] ${version} 운영 snapshot을 받았어요`),
    // 운영 장애·네트워크 끊김에도 개발 서버는 유지함. 화면은 만료·실패 경로로 보임
    onError: (error) =>
      console.error(
        "[dev:live] 운영 snapshot을 받지 못했어요. 1분 뒤 다시 확인해요.",
        error,
      ),
  });
} else {
  const cleared = clearDevData(outDir);
  if (cleared === "foreign") {
    console.warn(
      "[dev:data] off — public/data에 개발 데이터가 아닌 파일이 있어 지우지 않았어요. 확인 후 직접 정리하세요",
    );
  } else if (cleared === "unmarked") {
    console.warn(
      "[dev:data] off — 출처 표지가 없는 public/data를 지우지 않았어요. manifest가 있으면 화면은 예시로 표시해요. 지우려면 npm run dev:no-data -w apps/web",
    );
  } else {
    console.log(
      cleared === "removed"
        ? "[dev:data] off — 지난 개발 데이터를 지웠어요"
        : "[dev:data] off — 개발 데이터를 만들지 않아요",
    );
  }
}

// next 실행 파일(JS)을 node로 바로 실행함. 셸·next.cmd를 거치지 않아 운영체제와 관계없이 인자가 그대로 전달됨.
// BARADUN_NEXT_BIN은 테스트가 가짜 next로 바꿔 끼울 때만 씀.
const nextBin =
  process.env.BARADUN_NEXT_BIN ??
  createRequire(import.meta.url).resolve("next/dist/bin/next");
server = spawn(process.execPath, [nextBin, "dev", ...nextArgs], {
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
  } else if (signal === "SIGKILL") {
    // 멈추라는 신호를 5초 안에 따르지 않아 강제 종료한 경우. 정상 종료로 보이지 않게 함
    process.exitCode = 1;
  }
});
