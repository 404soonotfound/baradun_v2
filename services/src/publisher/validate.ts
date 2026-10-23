import schema from "@baradun/contracts/schema.json";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

// 게시 전 계약 검사 (아키텍처 1장 '게시 전 검사'·17.3, BRD-61)
// 파일마다 packages/contracts 스키마의 *File 정의를 통과해야 manifest를 바꿈
// 스키마는 정적 import로 가져옴 → Lambda 묶기(esbuild)에 들어감. createRequire는 묶이지 않고 CJS 묶음에서 import.meta.url이 없음
const ajv = new Ajv2020({
  allowUnionTypes: true,
  strictTypes: false,
  allErrors: true,
});
addFormats(ajv);
ajv.addSchema(schema);

export type ContractFile =
  | "ManifestFile"
  | "BeachesFile"
  | "StatusFile"
  | "HistoryFile"
  | "NationwideWarningsFile";

// 통과하면 빈 배열. 아니면 "파일: 경로 메시지" 목록(로그용, 값 원문은 넣지 않음)
export function contractErrors(file: ContractFile, value: unknown): string[] {
  const check = ajv.getSchema(`${schema.$id}#/$defs/${file}`);
  if (!check) throw new Error(`계약 정의 없음: ${file}`);
  if (check(value)) return [];
  return (check.errors ?? []).map((e) =>
    `${file}: ${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
  );
}
