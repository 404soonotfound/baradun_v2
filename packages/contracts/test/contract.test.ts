// 예시 검사: valid는 통과, invalid는 거부
// 실행: npm run test -w packages/contracts
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

// 이 테스트 파일 기준 상대 경로로 JSON 읽기
const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

// 검사기 준비: 2020-12판 + 날짜·URL 형식
const schema = read("../schemas/contract.schema.json");
const ajv = new Ajv2020({
  allErrors: true, // 첫 오류에서 멈추지 않고 전부 수집
  allowUnionTypes: true, // ["number", "null"] 허용
  strictTypes: false, // if/then 안 type 생략 경고 끔
});
addFormats(ajv);
ajv.addSchema(schema);

// 파일 이름 앞부분 → 검사할 정의 (예: status.xxx.json → StatusFile)
const DEF: Record<string, string> = {
  manifest: "ManifestFile",
  beaches: "BeachesFile",
  status: "StatusFile",
  history: "HistoryFile",
  "nationwide-warnings": "NationwideWarningsFile",
};

// 예시 파일 하나 검사 → { ok, errors }
function validate(dir: "valid" | "invalid", file: string) {
  const def = DEF[file.split(".")[0] ?? ""];
  if (!def) throw new Error(`이름으로 정의를 찾을 수 없음: ${file}`);
  const check = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
  if (!check) throw new Error(`정의 없음: ${def}`);
  const ok = check(read(`../examples/${dir}/${file}`));
  return { ok, errors: check.errors };
}

// 폴더의 .json 파일 목록
const list = (dir: string) =>
  readdirSync(new URL(`../examples/${dir}/`, import.meta.url)).filter((f) =>
    f.endsWith(".json"),
  );

// 정상 예시: 오류 0개
describe("정상 예시는 통과", () => {
  it.each(list("valid"))("%s", (file) => {
    const { ok, errors } = validate("valid", file);
    expect(errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });
});

// 거부 예시: 반드시 실패
describe("거부 예시는 실패", () => {
  it.each(list("invalid"))("%s", (file) => {
    expect(validate("invalid", file).ok).toBe(false);
  });
});
