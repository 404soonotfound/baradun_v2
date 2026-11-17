// 화면 상태 시나리오 데이터 (#550, 결정 기록 D30-5)
// 특보 발효·관측 지연·확인된 판단 없음·점검처럼 운영에서 원할 때 볼 수 없는 상태를 개발 서버·정적 미리보기에서 띄움
// 값은 E2E 픽스처와 같은 원본(scripts/scenario-data.mts)으로 만듦. 해변 목록·측정소·날씨 대응표만 실제 data/를 읽음
// 게시는 dev-data.mts의 publishSnapshot을 그대로 써서 표지 'scenario'를 남김(화면은 예시 데이터로 표시, 운영 빌드는 prebuild --check가 막음)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Beach } from "@baradun/contracts";

import { clearDevData, publishSnapshot } from "./dev-data.mts";
import {
  historyFile,
  iso,
  manifestFile,
  MIN,
  nationwideFile,
  noStationBeachId,
  noticesOf,
  SAMPLE_IDS,
  statusFile,
  weatherFile,
  type StatusMarks,
  type StatusOptions,
  type WeatherAreas,
} from "./scenario-data.mts";

const REPO = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export interface ScenarioInputs {
  beaches: Beach[];
  weatherAreas: WeatherAreas;
}

export function readScenarioInputs(repo: string = REPO): ScenarioInputs {
  const dir = path.join(repo, "data/beaches");
  const beaches = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map(
      (file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Beach,
    );
  const weatherAreas = JSON.parse(
    readFileSync(path.join(repo, "data/weather-areas.json"), "utf8"),
  ).beaches as WeatherAreas;
  return { beaches, weatherAreas };
}

// 시나리오 하나가 만드는 게시본. files에 없는 파일은 쓰지 않음(manifest가 가리켜도 404 → 화면의 받기 실패 경로)
export interface ScenarioSnapshot {
  manifest: ReturnType<typeof manifestFile>;
  files: Record<string, unknown>;
}

interface ScenarioDef {
  // 콘솔 안내용 한 줄(무엇을 보는 시나리오인지)
  summary: string;
  // 먼저 볼 해변 id(상세 주소 안내용). 없으면 홈부터
  focus: (inputs: ScenarioInputs) => string[];
  // null이면 데이터를 하나도 두지 않음(데이터 없음)
  build: ((inputs: ScenarioInputs, now: number) => ScenarioSnapshot) | null;
}

const ALL_FILES = [
  "beaches",
  "status",
  "history",
  "nationwideWarnings",
  "weather",
] as const;
type FileKey = (typeof ALL_FILES)[number];

function snapshot(
  inputs: ScenarioInputs,
  now: number,
  {
    marks = {},
    status = {},
    manifest = {},
    omit = [],
    nationwideConfirmed = true,
  }: {
    marks?: StatusMarks;
    status?: StatusOptions;
    manifest?: Record<string, unknown>;
    omit?: readonly FileKey[];
    nationwideConfirmed?: boolean;
  } = {},
): ScenarioSnapshot {
  const bodies: Record<FileKey, () => unknown> = {
    beaches: () => ({ beaches: inputs.beaches }),
    status: () =>
      statusFile(
        inputs.beaches,
        now,
        { ripCurrent: SAMPLE_IDS.clear, ...marks },
        status,
      ),
    history: () => historyFile(inputs.beaches, now),
    nationwideWarnings: () =>
      nationwideFile(now, { confirmed: nationwideConfirmed }),
    weather: () => weatherFile(inputs.weatherAreas, now, "ok"),
  };
  const manifestBody = manifestFile(now, manifest);
  const files: Record<string, unknown> = {};
  for (const key of ALL_FILES) {
    if (omit.includes(key)) continue;
    files[path.basename(manifestBody.files[key])] = bodies[key]();
  }
  return { manifest: manifestBody, files };
}

export const SCENARIOS = {
  mixed: {
    summary:
      "강릉 4곳에 특보 발효·관측 지연·특보 확인 못 함을 나눠 줌, 나머지는 특보 없음(E2E 정상 상태와 같음)",
    focus: () => [
      SAMPLE_IDS.clear,
      SAMPLE_IDS.warning,
      SAMPLE_IDS.delayed,
      SAMPLE_IDS.unknown,
    ],
    build: (inputs, now) =>
      snapshot(inputs, now, {
        marks: {
          warning: [SAMPLE_IDS.warning],
          delayed: [SAMPLE_IDS.delayed],
          unknown: [SAMPLE_IDS.unknown],
        },
      }),
  },
  warning: {
    summary:
      "강릉 해변 1곳에 풍랑주의보 발효(이용불가), 나머지는 특보 없음 → 사유 먼저 배지·결론 문장·대안 해변",
    focus: () => [SAMPLE_IDS.warning],
    build: (inputs, now) =>
      snapshot(inputs, now, { marks: { warning: [SAMPLE_IDS.warning] } }),
  },
  unknown: {
    summary: "강릉 해변 1곳만 특보 확인 못 함(판단불가), 나머지는 특보 없음",
    focus: () => [SAMPLE_IDS.unknown],
    build: (inputs, now) =>
      snapshot(inputs, now, { marks: { unknown: [SAMPLE_IDS.unknown] } }),
  },
  delayed: {
    summary:
      "강릉 해변 1곳의 파고 측정이 유효시간을 넘김(관측 지연, 판단불가), 나머지는 특보 없음",
    focus: () => [SAMPLE_IDS.delayed],
    build: (inputs, now) =>
      snapshot(inputs, now, { marks: { delayed: [SAMPLE_IDS.delayed] } }),
  },
  "no-nearby": {
    summary:
      "모든 해변 특보 없음. 측정소가 없는 해변은 값 자리에 '가까운 관측 없음'(분류는 그대로)",
    focus: (inputs) => [noStationBeachId(inputs.beaches, inputs.weatherAreas)],
    build: (inputs, now) => snapshot(inputs, now),
  },
  "partial-fail": {
    summary:
      "판단은 받았지만 날씨·24시간 파고 파일을 못 받고(404), 전국 해상 특보는 확인 시각이 없음",
    focus: () => [SAMPLE_IDS.clear],
    build: (inputs, now) =>
      snapshot(inputs, now, {
        omit: ["weather", "history"],
        nationwideConfirmed: false,
      }),
  },
  "all-fail": {
    summary: "모든 해변 특보 확인 못 함(확인된 판단 없음 배너)",
    focus: () => [SAMPLE_IDS.clear],
    build: (inputs, now) =>
      snapshot(inputs, now, {
        status: { allUnknown: true },
        nationwideConfirmed: false,
      }),
  },
  empty: {
    summary: "데이터를 하나도 두지 않음(manifest 없음 → 처음 열 때 못 받음)",
    focus: () => [],
    build: null,
  },
  maintenance: {
    summary: "점검 중(전체 화면이 점검 안내로 덮임, 90분 뒤 끝날 예정)",
    focus: () => [],
    build: (inputs, now) =>
      snapshot(inputs, now, {
        manifest: {
          maintenance: { active: true, until: iso(now + 90 * MIN) },
        },
      }),
  },
  "force-update": {
    summary: "화면 빌드가 최소 화면 버전보다 낮음(강제 업데이트 화면)",
    focus: () => [],
    build: (inputs, now) =>
      snapshot(inputs, now, { manifest: { minWebBuild: 9999 } }),
  },
  notice: {
    summary:
      "운영자 공지: 점검 예고·일반 공지·끝난 공지 → 홈에는 점검 예고 하나만",
    focus: () => [],
    build: (inputs, now) =>
      snapshot(inputs, now, { manifest: { notices: noticesOf(now) } }),
  },
} satisfies Record<string, ScenarioDef>;

export type ScenarioName = keyof typeof SCENARIOS;
export const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[];

export function parseScenarioName(raw: string | undefined): ScenarioName {
  if (raw && raw in SCENARIOS) return raw as ScenarioName;
  throw new Error(
    `시나리오 이름이 없거나 틀렸어요: ${raw ?? "(없음)"}. 다음 중 하나를 고르세요: ${SCENARIO_NAMES.join(", ")}`,
  );
}

/** 시나리오 게시본을 만듦(쓰지 않음). 데이터 없음 시나리오는 null */
export function buildScenario(
  name: ScenarioName,
  inputs: ScenarioInputs,
  nowMs: number,
): ScenarioSnapshot | null {
  const def: ScenarioDef = SCENARIOS[name];
  return def.build ? def.build(inputs, nowMs) : null;
}

/**
 * 시나리오를 outDir(public/data 또는 미리보기 임시 폴더)에 게시함. 반환값은 게시 버전, 데이터 없음이면 null.
 * 데이터 없음은 지난 개발 데이터를 지우기만 함(개발 데이터가 아닌 파일이 있으면 멈춤).
 */
export function writeScenarioData({
  outDir,
  name,
  inputs = readScenarioInputs(),
  nowMs = Date.now(),
}: {
  outDir: string;
  name: ScenarioName;
  inputs?: ScenarioInputs;
  nowMs?: number;
}): string | null {
  const built = buildScenario(name, inputs, nowMs);
  if (!built) {
    // 빈 폴더(미리보기 임시 폴더 처음 상태)는 지울 것이 없음
    if (existsSync(outDir) && readdirSync(outDir).length === 0) return null;
    const cleared = clearDevData(outDir);
    if (cleared === "foreign" || cleared === "unmarked") {
      throw new Error(
        `${outDir}에 출처를 모르는 파일이 있어 지우지 않았어요. 확인 후 직접 정리하세요`,
      );
    }
    return null;
  }
  const version = built.manifest.snapshotVersion;
  publishSnapshot({
    outDir,
    mode: "scenario",
    version,
    files: Object.entries(built.files).map(([name, body]) => ({
      name,
      content: JSON.stringify(body, null, 2),
    })),
    manifest: JSON.stringify(built.manifest, null, 2),
  });
  return version;
}

// 데이터 없음 시나리오의 게시 결과 표시(갱신기는 버전 글자를 받아 알림)
export const NO_DATA_VERSION = "(데이터 없음)";

/** 콘솔 알림 한 줄: 게시한 버전 또는 데이터 없음 상태 */
export function publishedMessage(name: ScenarioName, version: string): string {
  return version === NO_DATA_VERSION
    ? `[scenario] ${name} 데이터를 두지 않았어요(데이터 없음 상태)`
    : `[scenario] ${name} ${version} 게시했어요`;
}

/** 콘솔 안내: 무엇을 보는 시나리오인지와 먼저 열 주소 */
export function describeScenario(
  name: ScenarioName,
  inputs: ScenarioInputs,
  origin: string,
): string[] {
  const def: ScenarioDef = SCENARIOS[name];
  const lines = [`[scenario] ${name} — ${def.summary}`, `  홈: ${origin}/`];
  for (const id of def.focus(inputs)) {
    const beach = inputs.beaches.find((item) => item.id === id);
    if (beach) lines.push(`  ${beach.name.ko}: ${origin}/spots/${beach.slug}/`);
  }
  return lines;
}
