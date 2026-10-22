// data/beaches 검사 (BRD-45): 계약 Beach 모양 + slug 규칙 + main과 비교
// 실행: npm run check:beaches -w packages/contracts
// 비교 기준: BASE_REF 환경 변수 (없으면 origin/main)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareWithBase } from "./beach-rules.mjs";
import { validateBeaches } from "./validate-beaches.mjs";

const DIR = process.argv[2] ?? "../../data/beaches"; // 검사할 폴더 (packages/contracts 기준)
const REPO_PATH = "data/beaches"; // git 안에서의 경로
const BASE_REF = process.env.BASE_REF || "origin/main";

// 1) 지금 파일 읽기 (README 등 .json 아닌 파일은 건너뜀)
const files = existsSync(DIR)
  ? readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
  : [];
const items = files.map((file) => ({
  file,
  beach: JSON.parse(readFileSync(join(DIR, file), "utf8")),
}));

// 2) 계약과 목록 규칙 검사 (생성기의 최종 객체 검사와 같음)
const errors = validateBeaches(items);

// 4) main과 비교: slug 변경·삭제·재사용 금지
const base = readBase();
if (base === null)
  console.log(`비교 생략: ${BASE_REF}에 ${REPO_PATH}가 없어요 (처음 추가)`);
else
  errors.push(
    ...compareWithBase(
      base,
      items.map((i) => i.beach),
    ),
  );

// 결과
if (errors.length) {
  console.error(`해변 목록 검사 실패 ${errors.length}건`);
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}
console.log(`해변 목록 검사 통과: ${items.length}곳`);

// BASE_REF 시점의 data/beaches/*.json 읽기. 폴더가 없으면 null
function readBase() {
  const git = (...args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  let names;
  try {
    names = git(
      "ls-tree",
      "--full-tree",
      "--name-only",
      `${BASE_REF}:${REPO_PATH}`,
    )
      .split("\n")
      .filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  return names.map((f) =>
    JSON.parse(git("show", `${BASE_REF}:${REPO_PATH}/${f}`)),
  );
}
