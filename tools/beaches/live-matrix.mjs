// GH-253 실응답 지표 매트릭스(responses/metric-matrix.json)의 지표 칸을 저장된 응답 원문에서 다시 만듦
// 기본 응답(sources, 1차 시도)으로 칸을 채우고, 보충 응답(supplements, 뒤 시도)은 기본 칸이 VALUE_PRESENT가 아닐 때만 VALUE_PRESENT로 올림
// 보충이 기본 값을 덮거나 결측으로 낮추지 않음(결측을 정상으로 바꾸지 않고, 확인된 값을 지우지도 않음)
// 사용: node tools/beaches/live-matrix.mjs --check (저장본이 규칙대로인지 확인) | --write (sources·supplements·지표 칸을 다시 씀)
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { COVERAGE_DIR } from "./regions.mjs";

// 지표별 출처와 원문 칸. 값이 -99 이하이면 결측(기상청 결측 표기)
const METRICS = {
  waveHeight: { source: "sea_obs", cols: ["WH"] },
  wavePeriod: { source: "kma_buoy", cols: ["WP"] },
  waveDirection: { source: "kma_buoy", cols: ["WO"] },
  waterTemp: { source: "sea_obs", cols: ["TW"] },
  wind: { source: "sea_obs", cols: ["WD", "WS"] },
};
// sea_obs: 쉼표 구분(구분, TM, STN, 이름, LON, LAT, WH, WD, WS, GST, TW, TA, PA, HM). kma_buoy: 공백 구분(TM, STN, WD1, WS1, GST1, WD2, WS2, GST2, PA, HM, TA, TW, WH 최대·유의·평균, WP, WO)
const LAYOUT = {
  sea_obs: { split: (l) => l.split(",").map((s) => s.trim()), tm: 1, stn: 2, cols: { WH: 6, WD: 7, WS: 8, TW: 10 } },
  kma_buoy: { split: (l) => l.trim().split(/\s+/), tm: 0, stn: 1, cols: { WP: 15, WO: 16 } },
};
const SOURCE_KEYS = Object.keys(LAYOUT);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const kstToUtc = (tm) => {
  if (!/^\d{12}$/.test(tm)) throw new Error(`응답 시각 형식 오류: ${tm}`);
  return new Date(`${tm.slice(0, 4)}-${tm.slice(4, 6)}-${tm.slice(6, 8)}T${tm.slice(8, 10)}:${tm.slice(10, 12)}:00+09:00`).toISOString().replace(".000Z", "Z");
};

// 응답 원문 → 관측소별 마지막(가장 늦은 TM) 행
export function parseResponse(source, text) {
  const lay = LAYOUT[source];
  if (!text.startsWith("#START7777") || !text.trimEnd().endsWith("#7777END")) throw new Error(`${source} 응답 시작·끝 표시 없음`);
  const rows = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const f = lay.split(line);
    const tm = f[lay.tm];
    const stn = f[lay.stn];
    if (!/^\d+$/.test(stn ?? "")) throw new Error(`${source} 관측소 번호 형식 오류: ${line}`);
    const prev = rows.get(stn);
    if (!prev || tm > prev.tm) rows.set(stn, { tm, f });
  }
  return rows;
}

function metricCell(metric, attempt, rows, stn) {
  const { source, cols } = METRICS[metric];
  const base = { source, state: "ROW_ABSENT", observed_at_utc: null, value: null, response_file: attempt.response_file, response_sha256: attempt.sha256 };
  const row = rows.get(stn);
  if (!row) return base;
  const raw = cols.map((c) => row.f[LAYOUT[source].cols[c]]);
  const nums = raw.map(Number);
  const missing = nums.some((n) => raw.includes("") || !Number.isFinite(n) || n <= -99);
  const value = missing ? null : metric === "wind" ? { direction_deg: nums[0], speed_ms: nums[1] } : nums[0];
  return { ...base, state: missing ? "MISSING" : "VALUE_PRESENT", observed_at_utc: kstToUtc(row.tm), value, raw_values: raw };
}

// call-ledger의 HTTP 200 응답을 시도 순서로 묶음. 1차 시도가 기본, 뒤 시도는 보충
function attemptsFrom(coverageDir) {
  const ledger = JSON.parse(readFileSync(join(coverageDir, "responses/call-ledger.json"), "utf8"));
  const out = new Map();
  for (const a of ledger.attempts) {
    if (!SOURCE_KEYS.includes(a.source)) continue;
    if (a.outcome !== "RESPONSE_RECEIVED" || a.http_status !== 200) throw new Error(`실응답 시도 ${a.source} ${a.attempt}회차가 HTTP 200 수신 아님`);
    const text = readFileSync(join(coverageDir, a.response_file));
    const entry = { status: "RECEIVED", response_file: a.response_file, sha256: sha256(text), request_url: a.request_url, http_status: a.http_status, fetched_at_utc: a.finished_at_utc };
    if (!out.has(a.attempt)) out.set(a.attempt, {});
    out.get(a.attempt)[a.source] = { entry, rows: parseResponse(a.source, text.toString("utf8")) };
  }
  const order = [...out.keys()].sort((x, y) => x - y);
  for (const n of order) if (!SOURCE_KEYS.every((k) => out.get(n)[k])) throw new Error(`실응답 ${n}회차에 ${SOURCE_KEYS.join("·")} 응답이 모두 있지 않음`);
  if (!order.length) throw new Error("실응답 시도 없음");
  return order.map((n) => out.get(n));
}

// 관측소 목록(이름·좌표·가까운 해변)은 저장본 그대로 두고 지표 칸과 출처만 다시 만듦
export function rebuildMatrix(matrix, coverageDir = COVERAGE_DIR) {
  const [primary, ...supplements] = attemptsFrom(coverageDir);
  const stations = matrix.stations.map((s) => {
    const metrics = {};
    for (const metric of Object.keys(METRICS)) {
      const src = METRICS[metric].source;
      let cell = metricCell(metric, primary[src].entry, primary[src].rows, s.stn_id);
      for (const sup of supplements) {
        if (cell.state === "VALUE_PRESENT") break;
        const next = metricCell(metric, sup[src].entry, sup[src].rows, s.stn_id);
        if (next.state === "VALUE_PRESENT") cell = next;
      }
      metrics[metric] = cell;
    }
    return { ...s, metrics };
  });
  const pick = (a) => Object.fromEntries(SOURCE_KEYS.map((k) => [k, a[k].entry]));
  return {
    sources: pick(primary),
    supplements: supplements.map(pick),
    supplement_rule: "기본(sources) 칸이 VALUE_PRESENT가 아닐 때만 보충(supplements) 응답의 VALUE_PRESENT로 올림. tools/beaches/live-matrix.mjs",
    stations,
  };
}

export const serializeMatrix = (m) => `${JSON.stringify(m, null, 2)}\n`;

// 저장본의 지표 칸이 응답 원문 + 병합 규칙과 같은지 확인. 다르면 칸 목록을 돌려줌
export function diffMatrix(stored, coverageDir = COVERAGE_DIR) {
  const rebuilt = rebuildMatrix(stored, coverageDir);
  const diffs = [];
  rebuilt.stations.forEach((s, i) => {
    for (const metric of Object.keys(METRICS))
      if (JSON.stringify(s.metrics[metric]) !== JSON.stringify(stored.stations[i].metrics?.[metric])) diffs.push(`${s.stn_id} ${metric}`);
  });
  for (const k of ["sources", "supplements", "supplement_rule"])
    if (JSON.stringify(rebuilt[k]) !== JSON.stringify(stored[k])) diffs.push(k);
  return { rebuilt, diffs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = join(COVERAGE_DIR, "responses/metric-matrix.json");
  const stored = JSON.parse(readFileSync(path, "utf8"));
  const { rebuilt, diffs } = diffMatrix(stored);
  if (process.argv.includes("--write")) {
    writeFileSync(path, serializeMatrix(rebuilt));
    console.log(`다시 씀: ${path} (바뀐 칸 ${diffs.length}개) sha256 ${sha256(serializeMatrix(rebuilt))}`);
  } else if (process.argv.includes("--check")) {
    if (diffs.length) {
      console.error(`저장본이 응답 원문·병합 규칙과 다름: ${diffs.join(", ")}`);
      process.exit(1);
    }
    console.log(`저장본 일치: 관측소 ${stored.stations.length}곳, 보충 ${stored.supplements.length}회`);
  } else {
    console.error("사용: --check | --write");
    process.exit(2);
  }
}
