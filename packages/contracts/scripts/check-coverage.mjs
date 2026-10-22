// BeachCoverageMatrix 검사 (BRD-59): data/beaches ↔ data/beach-coverage.csv ↔ data/beach-meta.json
// 필수 칸 누락·근거 없는 매핑·제외 사유 없는 행이면 실패
// 실행: npm run check:coverage -w packages/contracts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DATA = process.argv[2] ?? "../../data";
import { validateCoverage } from "./coverage-rules.mjs";
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
errors.push(...validateCoverage({ beaches, matrix, meta }));

if (errors.length) {
  console.error(`매트릭스 검사 실패 ${errors.length}건`);
  for (const e of errors.slice(0, 50)) console.error(`  - ${e}`);
  process.exit(1);
}
const hiddenCount = beaches.filter((b) => b.hidden).length;
console.log(`매트릭스 검사 통과: 공개 ${beaches.length - hiddenCount}곳${hiddenCount ? `(숨김 ${hiddenCount}곳 별도)` : ""}, 매트릭스 ${matrix.length}행`);
