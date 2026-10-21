// BeachCoverageMatrix 검사 (BRD-59): data/beaches ↔ data/beach-coverage.csv ↔ data/beach-meta.json
// 필수 칸 누락·근거 없는 매핑·제외 사유 없는 행이면 실패
// 실행: npm run check:coverage -w packages/contracts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DATA = process.argv[2] ?? "../../data";
const errors = [];
const fail = (m) => errors.push(m);

// CSV 읽기(따옴표·쉼표·줄바꿈 포함 칸 처리)
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((k, i) => [k.replace(/^﻿/, ""), r[i] ?? ""])));
}

const dir = join(DATA, "beaches");
const beaches = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
  : [];
if (!beaches.length) {
  console.log("해변 0곳: 매트릭스 검사 건너뜀");
  process.exit(0);
}
const matrixPath = join(DATA, "beach-coverage.csv");
const metaPath = join(DATA, "beach-meta.json");
if (!existsSync(matrixPath)) fail("data/beach-coverage.csv 없음");
if (!existsSync(metaPath)) fail("data/beach-meta.json 없음");
const matrix = existsSync(matrixPath) ? parseCsv(readFileSync(matrixPath, "utf8")) : [];
const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : { beaches: {} };
const byId = new Map(matrix.filter((r) => r.id).map((r) => [r.id, r]));

// 1) 공개 해변: 매트릭스 행이 있고 근거 칸이 채워져 있어야 함
const REQUIRED = ["sea_zone", "sea_basis", "sea_rule_url", "sea_checked_at_kst", "land_zone", "land_basis", "land_rule_url", "land_checked_at_kst", "coords_source", "station_basis", "response_check"];
const METRICS = ["waveHeight", "wavePeriod", "waveDirection", "waterTemp", "wind"];
for (const b of beaches) {
  const r = byId.get(b.id);
  if (!r) {
    fail(`${b.id}: 매트릭스 행 없음`);
    continue;
  }
  if (r.stage !== "SOURCE_CANDIDATE") fail(`${b.id}: 매트릭스 단계가 공개 대상 아님(${r.stage})`);
  for (const c of REQUIRED) if (!r[c]) fail(`${b.id}: 매트릭스 ${c} 비어 있음`);
  if (r.sea_status !== "검증" || r.land_status !== "검증") fail(`${b.id}: 구역 근거 미검증(S1 ${r.sea_status}, L1 ${r.land_status})`);
  if (r.exclusion) fail(`${b.id}: 제외 사유가 있는데 공개됨`);
  if (b.slug !== r.slug) fail(`${b.id}: slug 불일치(${b.slug} ≠ ${r.slug})`);
  if (b.warningZones.sea !== r.sea_zone || (b.warningZones.land ?? "") !== r.land_zone) fail(`${b.id}: 특보구역이 매트릭스 근거와 다름`);
  for (const m of METRICS) {
    const s = b.stations[m];
    const cell = r[`st_${m}`] ?? "";
    if (s && !cell.startsWith(`${s.id} `)) fail(`${b.id} ${m}: 관측소 ${s.id}가 매트릭스 근거(${cell})와 다름`);
    if (!s && cell !== "null(가까운 관측 없음)") fail(`${b.id} ${m}: null인데 '가까운 관측 없음' 근거 없음(${cell})`);
  }
  const mt = meta.beaches?.[b.id];
  if (!mt) fail(`${b.id}: beach-meta.json 항목 없음`);
  else {
    if (!Array.isArray(mt.aliases)) fail(`${b.id}: 별칭 목록 없음`);
    if (!mt.season || !("2026" in mt.season)) fail(`${b.id}: 2026 운영 기간 칸 없음(없으면 null)`);
  }
}
// 2) 공개되지 않은 행: 보류·자동 제외 사유가 있어야 함
const ids = new Set(beaches.map((b) => b.id));
for (const r of matrix) {
  if (r.id && ids.has(r.id)) continue;
  if (!["보류", "자동 제외"].includes(r.stage)) fail(`${r.id || r.source_name}: 공개 안 된 행의 단계가 보류·자동 제외 아님(${r.stage})`);
  if (!r.exclusion) fail(`${r.id || r.source_name}: 보류·제외 사유 없음`);
}
// 3) meta에 없는 해변 id
for (const id of Object.keys(meta.beaches ?? {})) if (!ids.has(id)) fail(`beach-meta.json: 없는 해변 ${id}`);

if (errors.length) {
  console.error(`매트릭스 검사 실패 ${errors.length}건`);
  for (const e of errors.slice(0, 50)) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`매트릭스 검사 통과: 공개 ${beaches.length}곳, 매트릭스 ${matrix.length}행`);
