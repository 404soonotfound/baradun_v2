import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  METRIC_EXPIRY_MS,
  WARNING_CONFIRMATION_TTL_MS,
} from "@baradun/contracts/judgment-policy";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";

import { startServer } from "../e2e/static-server.mjs";
import { hasDevSampleSnapshot } from "../src/lib/dev-sample";
import { WEB_BUILD } from "../src/lib/snapshot/build";
import { clearDevData, DEV_DATA_MODE_FILE } from "./dev-data.mts";
import {
  buildScenario,
  parseScenarioName,
  readScenarioInputs,
  SCENARIO_NAMES,
  writeScenarioData,
  type ScenarioSnapshot,
} from "./dev-scenario.mts";
import { noStationBeachId, SAMPLE_IDS } from "./scenario-data.mts";
import { checkPreviewBuild, readGaMeasurementId } from "./scenario-preview.mts";

// 계약 스키마 검사기(packages/contracts 시험과 같은 설정)
const schema = JSON.parse(
  readFileSync(
    path.join(
      import.meta.dirname,
      "../../../packages/contracts/schemas/contract.schema.json",
    ),
    "utf8",
  ),
);
const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strictTypes: false,
});
addFormats(ajv);
ajv.addSchema(schema);
const FILE_DEF: Record<string, string> = {
  "beaches.json": "BeachesFile",
  "status.json": "StatusFile",
  "history.json": "HistoryFile",
  "nationwide-warnings.json": "NationwideWarningsFile",
  "weather.json": "WeatherFile",
};
function schemaErrors(def: string, body: unknown) {
  const check = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
  if (!check) throw new Error(`정의 없음: ${def}`);
  return check(body) ? [] : (check.errors ?? []);
}

const inputs = readScenarioInputs();
const NOW = Date.parse("2026-11-17T03:00:00Z");

interface StatusEntry {
  category: string;
  reasons: Array<{ code: string }>;
  warning: { state: string; lastConfirmedAt: string | null };
  observation: {
    metrics: Record<string, { state: string; observedAt: string | null }>;
  };
}
function statusOf(built: ScenarioSnapshot | null) {
  const file = built?.files["status.json"] as
    { beaches: Record<string, StatusEntry> } | undefined;
  if (!file) throw new Error("status.json 없음");
  return file.beaches;
}
function build(name: string) {
  return buildScenario(parseScenarioName(name), inputs, NOW);
}

const roots: string[] = [];
const servers: Server[] = [];
function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "baradun-scenario-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise((resolve) => server.close(resolve));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("시나리오 게시본", () => {
  it.each(SCENARIO_NAMES.filter((name) => name !== "empty"))(
    "%s: 모든 파일이 공개 데이터 계약을 통과함",
    (name) => {
      const built = build(name);
      expect(built).not.toBeNull();
      expect(schemaErrors("ManifestFile", built!.manifest)).toEqual([]);
      for (const [file, body] of Object.entries(built!.files)) {
        expect([file, schemaErrors(FILE_DEF[file]!, body)]).toEqual([file, []]);
      }
    },
  );

  it("모르는 시나리오 이름은 고를 수 있는 이름과 함께 거부함", () => {
    expect(() => parseScenarioName("unknown-name")).toThrow(/warning/);
    expect(() => parseScenarioName(undefined)).toThrow(/시나리오 이름/);
  });

  it("warning: 고른 해변만 풍랑주의보로 이용불가, 나머지는 특보 없음", () => {
    const beaches = statusOf(build("warning"));
    expect(beaches[SAMPLE_IDS.warning]?.category).toBe("unavailable");
    expect(beaches[SAMPLE_IDS.warning]?.reasons[0]?.code).toBe("warning");
    const others = Object.entries(beaches).filter(
      ([id]) => id !== SAMPLE_IDS.warning,
    );
    expect(others.every(([, status]) => status.category === "clear")).toBe(
      true,
    );
  });

  it("delayed: 파고 관측 시각이 판단 정책의 유효시간보다 오래됨", () => {
    const status = statusOf(build("delayed"))[SAMPLE_IDS.delayed]!;
    expect(status.category).toBe("undetermined");
    expect(status.reasons[0]?.code).toBe("observation_delayed");
    const wave = status.observation.metrics.waveHeight!;
    expect(wave.state).toBe("delayed");
    expect(NOW - Date.parse(wave.observedAt!)).toBeGreaterThan(
      METRIC_EXPIRY_MS.waveHeight,
    );
  });

  it("unknown: 마지막 특보 확인이 확인 유효시간보다 오래됨", () => {
    const status = statusOf(build("unknown"))[SAMPLE_IDS.unknown]!;
    expect(status.reasons[0]?.code).toBe("warning_unknown");
    expect(status.warning.state).toBe("unknown");
    expect(NOW - Date.parse(status.warning.lastConfirmedAt!)).toBeGreaterThan(
      WARNING_CONFIRMATION_TTL_MS,
    );
  });

  it("no-nearby: 측정소 없는 해변은 지표가 모두 없음이고 분류는 특보 없음", () => {
    const id = noStationBeachId(inputs.beaches, inputs.weatherAreas);
    const status = statusOf(build("no-nearby"))[id]!;
    expect(status.category).toBe("clear");
    expect(
      Object.values(status.observation.metrics).every(
        (item) => item.state === "none",
      ),
    ).toBe(true);
  });

  it("partial-fail: manifest는 날씨·24시간 파고를 가리키지만 파일은 없고, 전국 특보 확인 시각은 없음", () => {
    const built = build("partial-fail")!;
    expect(built.manifest.files.weather).toBeDefined();
    expect(built.manifest.files.history).toBeDefined();
    expect(built.files["weather.json"]).toBeUndefined();
    expect(built.files["history.json"]).toBeUndefined();
    expect(built.files["nationwide-warnings.json"]).toMatchObject({
      lastConfirmedAt: null,
    });
  });

  it("all-fail: 모든 해변이 특보 확인 못 함", () => {
    const beaches = Object.values(statusOf(build("all-fail")));
    expect(
      beaches.every(
        (status) =>
          status.category === "undetermined" &&
          status.reasons[0]?.code === "warning_unknown",
      ),
    ).toBe(true);
  });

  it("maintenance·force-update·notice: manifest 신호가 화면 조건에 맞음", () => {
    expect(build("maintenance")!.manifest.maintenance).toMatchObject({
      active: true,
    });
    expect(build("force-update")!.manifest.minWebBuild).toBeGreaterThan(
      WEB_BUILD,
    );
    const notices = (
      build("notice")!.manifest as { notices?: Array<{ kind: string }> }
    ).notices;
    expect(notices?.length).toBeGreaterThan(0);
    // 게시본에 나올 수 없는 공지(모르는 종류)는 넣지 않음(E2E 전용)
    expect(
      notices?.every((item) =>
        ["maintenance_notice", "general"].includes(item.kind),
      ),
    ).toBe(true);
  });

  it("empty: 게시본을 만들지 않음", () => {
    expect(build("empty")).toBeNull();
  });
});

describe("시나리오 쓰기", () => {
  it("표지 scenario로 게시하고, 화면은 예시 데이터로 보며, 끄면 지움", () => {
    const outDir = path.join(tempRoot(), "data");
    const version = writeScenarioData({
      outDir,
      name: "warning",
      inputs,
      nowMs: NOW,
    });
    expect(version).toMatch(/^\d{8}T\d{6}Z$/);
    expect(readFileSync(path.join(outDir, DEV_DATA_MODE_FILE), "utf8")).toBe(
      "scenario\n",
    );
    expect(existsSync(path.join(outDir, version!, "status.json"))).toBe(true);
    // 빌드·개발 서버의 '예시 데이터' 표시 판단(운영 미러 live만 예시가 아님)
    expect(hasDevSampleSnapshot(outDir)).toBe(true);
    expect(clearDevData(outDir)).toBe("removed");
    expect(existsSync(outDir)).toBe(false);
  });

  it("empty는 지난 시나리오 데이터를 지움", () => {
    const outDir = path.join(tempRoot(), "data");
    writeScenarioData({ outDir, name: "mixed", inputs, nowMs: NOW });
    expect(
      writeScenarioData({ outDir, name: "empty", inputs, nowMs: NOW }),
    ).toBeNull();
    expect(existsSync(outDir)).toBe(false);
  });

  it("empty는 빈 폴더(미리보기 첫 상태)를 그대로 둠", () => {
    const outDir = path.join(tempRoot(), "data");
    mkdirSync(outDir);
    expect(
      writeScenarioData({ outDir, name: "empty", inputs, nowMs: NOW }),
    ).toBeNull();
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("empty는 출처를 모르는 파일이 있으면 지우지 않고 멈춤", () => {
    const outDir = path.join(tempRoot(), "data");
    mkdirSync(outDir);
    writeFileSync(path.join(outDir, "keep.txt"), "x");
    expect(() =>
      writeScenarioData({ outDir, name: "empty", inputs, nowMs: NOW }),
    ).toThrow(/출처를 모르는/);
    expect(readdirSync(outDir)).toEqual(["keep.txt"]);
  });
});

describe("정적 미리보기", () => {
  it("빌드가 없으면 빌드 명령을 안내함", () => {
    expect(checkPreviewBuild(tempRoot(), "G-TEST000")).toMatch(/npm run build/);
  });

  it("운영 주소로 빌드한 결과(GA 측정 ID 포함)는 거부함", () => {
    const out = tempRoot();
    writeFileSync(path.join(out, "index.html"), "<script>G-TEST000</script>");
    expect(checkPreviewBuild(out, "G-TEST000")).toMatch(/운영 주소/);
  });

  it("비운영 빌드는 받아들임", () => {
    const out = tempRoot();
    writeFileSync(path.join(out, "index.html"), "<html></html>");
    expect(checkPreviewBuild(out, "G-TEST000")).toBeNull();
  });

  it("GA 측정 ID를 lib/site-env.ts에서 읽음", () => {
    expect(readGaMeasurementId()).toMatch(/^G-[A-Z0-9]+$/);
  });
});

describe("정적 서버의 /data", () => {
  async function serve(dataDir: string | null) {
    const server = startServer({ port: 0, dataDir }) as Server;
    servers.push(server);
    await new Promise((resolve) => server.once("listening", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("dataDir을 주면 그 폴더의 시나리오 파일을 내보냄", async () => {
    const dataDir = path.join(tempRoot(), "data");
    writeScenarioData({ outDir: dataDir, name: "mixed", inputs, nowMs: NOW });
    const origin = await serve(dataDir);
    const response = await fetch(`${origin}/data/manifest.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).snapshotVersion).toMatch(/^\d{8}T/);
  });

  it("dataDir 밖으로 나가는 주소는 파일을 내주지 않음", async () => {
    const root = tempRoot();
    const dataDir = path.join(root, "data");
    writeScenarioData({ outDir: dataDir, name: "mixed", inputs, nowMs: NOW });
    writeFileSync(path.join(root, "secret.json"), "{}");
    const origin = await serve(dataDir);
    const response = await fetch(`${origin}/data/%2E%2E/secret.json`);
    // 없는 주소는 out/404.html로 답함. 빌드 전(CI 단위 시험)에는 그 파일이 없어 500이 되므로 '파일을 내주지 않음'만 확인
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toBe("{}");
  });

  it("dataDir이 없으면(E2E) /data는 지금처럼 내주지 않음", async () => {
    const origin = await serve(null);
    const response = await fetch(`${origin}/data/manifest.json`);
    expect(response.status).not.toBe(200);
    expect(response.headers.get("content-type")).not.toBe("application/json");
  });
});
