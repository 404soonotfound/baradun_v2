// 시나리오 정적 미리보기 (#550, 결정 기록 D30-5)
// 운영과 같은 정적 빌드 결과(out/)를 그대로 내보내고, /data/**만 out 밖 임시 폴더의 시나리오 데이터로 채움
// out/에는 아무것도 쓰지 않으므로 시나리오 데이터가 배포물에 섞이지 않음. 서버를 멈추면 임시 폴더를 지움
//   NEXT_PUBLIC_SITE_URL=https://example.test npm run build -w apps/web   (먼저 한 번, 운영 주소로 빌드하지 않음)
//   npm run scenario:preview -w apps/web -- --scenario=warning            (http://127.0.0.1:3110)
//   npm run scenario:preview -w apps/web -- --scenario=warning --lan      (같은 Wi-Fi 휴대폰에서 열기)
// 한계: 빌드 때 데이터가 없어 화면의 '예시 데이터' 표시가 나오지 않음(개발 서버 npm run dev -- --scenario=…는 나옴).
//       같은 Wi-Fi 주소는 http라 서비스 워커·홈 화면 추가는 이 경로에서 확인하지 않음(운영 주소에서 확인)
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startServer } from "../e2e/static-server.mjs";
import { startDevDataRefresh } from "./dev-data.mts";
import {
  describeScenario,
  NO_DATA_VERSION,
  parseScenarioName,
  publishedMessage,
  readScenarioInputs,
  writeScenarioData,
} from "./dev-scenario.mts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PREVIEW_PORT = 3110;
// 운영 빌드에만 들어가는 GA 측정 ID(lib/site-env.ts의 상수를 글자로 읽음, 별칭 경로를 Node가 못 풀어서 가져오지 않음)
// 이 ID가 첫 화면 HTML에 있으면 운영 주소로 빌드한 결과
export function readGaMeasurementId(webDir: string = WEB): string {
  const source = readFileSync(path.join(webDir, "src/lib/site-env.ts"), "utf8");
  const id = /GA_MEASUREMENT_ID\s*=\s*"(G-[A-Z0-9]+)"/.exec(source)?.[1];
  if (!id) throw new Error("lib/site-env.ts에서 GA 측정 ID를 찾지 못했어요");
  return id;
}

/** 미리보기에 쓸 수 있는 빌드인지. 문제가 있으면 이유, 없으면 null */
export function checkPreviewBuild(
  outDir: string,
  gaId: string = readGaMeasurementId(),
): string | null {
  const index = path.join(outDir, "index.html");
  if (!existsSync(index)) {
    return "빌드 결과(out/index.html)가 없어요. 먼저 NEXT_PUBLIC_SITE_URL=https://example.test npm run build -w apps/web 를 실행하세요";
  }
  // 운영 빌드는 GA를 불러서 시나리오 화면이 실제 이용 통계에 섞일 수 있음 → 미리보기를 거부함
  if (readFileSync(index, "utf8").includes(gaId)) {
    return "운영 주소로 빌드한 결과라 미리보기를 띄우지 않아요(이용 통계가 섞일 수 있음). NEXT_PUBLIC_SITE_URL=https://example.test 로 다시 빌드하세요";
  }
  return null;
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter(
      (item): item is NonNullable<typeof item> =>
        !!item && item.family === "IPv4" && !item.internal,
    )
    .map((item) => item.address);
}

function readFlag(args: string[], name: string): string | undefined {
  return args
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

function main(): void {
  const args = process.argv.slice(2);
  const name = parseScenarioName(readFlag(args, "scenario"));
  const port = Number(readFlag(args, "port") ?? DEFAULT_PREVIEW_PORT);
  const lan = args.includes("--lan");
  const outDir = path.join(WEB, "out");

  const problem = checkPreviewBuild(outDir);
  if (problem) {
    console.error(`[scenario] ${problem}`);
    process.exitCode = 1;
    return;
  }

  const dataDir = mkdtempSync(path.join(tmpdir(), "baradun-scenario-"));
  const inputs = readScenarioInputs();
  const stopRefresh = startDevDataRefresh({
    outDir: dataDir,
    write: (nowMs) =>
      writeScenarioData({ outDir: dataDir, name, inputs, nowMs }) ??
      NO_DATA_VERSION,
    onPublished: (version) => console.log(publishedMessage(name, version)),
    onError: (error) =>
      console.error(
        "[scenario] 시나리오 갱신에 실패했어요. 1분 뒤 다시 시도해요.",
        error,
      ),
  });
  const server = startServer({
    port,
    host: lan ? "0.0.0.0" : "127.0.0.1",
    dataDir,
  });

  for (const line of describeScenario(name, inputs, `http://127.0.0.1:${port}`))
    console.log(line);
  if (lan) {
    for (const address of lanAddresses())
      console.log(`  같은 Wi-Fi 기기: http://${address}:${port}/`);
    console.log(
      "  같은 Wi-Fi 주소는 http라 서비스 워커·홈 화면 추가는 여기서 확인하지 않아요",
    );
  }
  console.log(
    "  이 미리보기에는 '예시 데이터' 표시가 나오지 않아요. 화면 값은 모두 시나리오 예시예요(가짜 구역 이름은 '시험 …')",
  );

  const stop = () => {
    stopRefresh();
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      stop();
      process.exit(0);
    });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
