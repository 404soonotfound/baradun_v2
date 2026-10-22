// 생성기와 저장소 검사에서 같은 Beach 계약을 사용함.
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { checkList } from "./beach-rules.mjs";

const schema = JSON.parse(readFileSync(new URL("../schemas/contract.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strictTypes: false });
addFormats(ajv);
ajv.addSchema(schema);
const validate = ajv.getSchema(`${schema.$id}#/$defs/Beach`);

export function validateBeaches(items) {
  const errors = [];
  for (const { file, beach } of items) {
    if (!validate(beach))
      for (const e of validate.errors ?? []) errors.push(`${file}: ${e.instancePath || "(전체)"} ${e.message}`);
  }
  return [...errors, ...checkList(items)];
}
