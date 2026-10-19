// 문구 키 검사 (BRD-22): ko·en 키가 같은지, 변수 이름이 같은지 확인함.
// 화면은 ko.json을 기준으로 타입 검사하니, en.json에 빠지거나 남는 키를 여기서 막음.
import { readFileSync } from "node:fs";

const load = (locale) =>
  JSON.parse(
    readFileSync(
      new URL(`../messages/${locale}.json`, import.meta.url),
      "utf8",
    ),
  );

function flatten(node, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else flatten(value, path, out);
  }
  return out;
}

// ICU 변수 이름만 뽑음: "{minutes}분 전" → ["minutes"]
const vars = (text) =>
  [...text.matchAll(/\{\s*([a-zA-Z0-9_]+)/g)].map((m) => m[1]).sort();

const ko = flatten(load("ko"));
const en = flatten(load("en"));
const problems = [];

for (const key of Object.keys(ko)) {
  if (!(key in en)) problems.push(`en에 없음: ${key}`);
  else if (vars(ko[key]).join() !== vars(en[key]).join())
    problems.push(
      `변수가 다름: ${key} (ko: ${vars(ko[key])} / en: ${vars(en[key])})`,
    );
}
for (const key of Object.keys(en)) {
  if (!(key in ko)) problems.push(`ko에 없음: ${key}`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n문구 키 검사 실패 ${problems.length}건`);
  process.exit(1);
}
console.log(`문구 키 검사 통과 (${Object.keys(ko).length}개)`);
