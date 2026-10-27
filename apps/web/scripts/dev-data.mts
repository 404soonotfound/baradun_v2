// 개발용 예시 바다 데이터 (BRD-26)
// 계약 예시(packages/contracts/examples/valid)의 시각을 지금으로 옮겨 public/data에 씀.
// 저장소에 넣지 않음(.gitignore) · 상태가 있는 해변은 b0001~b0003(강릉 강문·경포·사근진)뿐
//   npm run dev:data -w apps/web            예시 데이터 만들기(약 30분 뒤 만료 → 다시 실행)
//   npm run dev:data -w apps/web -- --clean 지우기
//   --check                                 빌드 전 검사: public/data가 있으면 빌드를 멈춤(예시가 배포되지 않게)
// 실행: Node 22.18 이상은 .mts를 그대로 실행함(타입만 지우고 실행, 저장소 .nvmrc는 22.23)
//   .mts = ES 모듈(import 문법)로 읽는 TypeScript. .ts로 두면 실행할 때마다 모듈 형식 경고가 남
//   타입만 지우는 방식이라 enum·namespace처럼 '지우기만으로 안 되는' 문법은 쓰지 않음
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ManifestFile } from "@baradun/contracts";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(WEB, "public/data");
const EXAMPLES = path.join(WEB, "../../packages/contracts/examples/valid");
const mode = process.argv[2];

if (mode === "--check") {
  if (existsSync(OUT)) {
    console.error(
      "public/data에 개발용 예시 데이터가 있어요. npm run dev:data -w apps/web -- --clean 후 다시 빌드하세요.",
    );
    process.exit(1);
  }
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
if (mode === "--clean") {
  console.log("public/data를 지웠어요");
  process.exit(0);
}

// JSON 파일 읽기. 어떤 모양인지 모르니 unknown으로 받음
function read(name: string): unknown {
  return JSON.parse(readFileSync(path.join(EXAMPLES, name), "utf8"));
}
// 예시 manifest는 계약 검사를 통과한 파일이라 계약 타입으로 봄
const manifest = read("manifest.json") as ManifestFile;

// 예시 게시 시각과 지금의 차이(분 단위)만큼 모든 시각을 옮김
const shiftMs =
  Math.floor((Date.now() - Date.parse(manifest.generatedAt)) / 60_000) * 60_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isoOf(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

// 값 안의 모든 시각 글자를 옮긴 새 값. 배열·객체는 안쪽까지(재귀)
function shift(value: unknown): unknown {
  if (typeof value === "string" && ISO.test(value)) {
    return isoOf(Date.parse(value) + shiftMs);
  }
  if (Array.isArray(value)) return value.map(shift);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, shift(item)]),
    );
  }
  return value;
}

// 게시 버전(20261017T053000Z)도 같은 만큼 옮김
const v = manifest.snapshotVersion;
const versionIso = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}Z`;
const version = isoOf(Date.parse(versionIso) + shiftMs).replace(/[-:]/g, "");

// 파일 경로를 새 버전 폴더로. Record<키, 값> = 키·값 타입이 정해진 객체
const files: Record<string, string> = Object.fromEntries(
  Object.entries(manifest.files).map(([key, file]) => [
    key,
    `/data/${version}/${path.basename(file)}`,
  ]),
);
mkdirSync(path.join(OUT, version), { recursive: true });
for (const file of Object.values(files)) {
  const name = path.basename(file);
  writeFileSync(
    path.join(OUT, version, name),
    JSON.stringify(shift(read(name)), null, 2),
  );
}
writeFileSync(
  path.join(OUT, "manifest.json"),
  JSON.stringify(
    { ...(shift(manifest) as object), snapshotVersion: version, files },
    null,
    2,
  ),
);
console.log(`public/data/${version}에 예시 데이터를 썼어요`);
