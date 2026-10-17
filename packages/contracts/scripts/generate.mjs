// 스키마 → TypeScript 타입 생성 (결과: src/generated/contract.ts)
// 실행: npm run generate -w packages/contracts
import { mkdir, writeFile } from "node:fs/promises";
import { compileFromFile } from "json-schema-to-typescript";

const ts = await compileFromFile("schemas/contract.schema.json", {
  // 생성 파일 맨 위 경고 문구
  bannerComment:
    "// 자동 생성 파일: 직접 고치지 말고 schemas/를 고친 뒤 `npm run generate`",
  // $defs 전부 타입으로 내보냄 (Metric·Reason 등)
  unreachableDefinitions: true,
  // 스키마에 없는 필드는 타입에도 없음
  additionalProperties: false,
  // 따옴표 스타일 고정 (CI 비교용)
  style: { singleQuote: true },
});

// 폴더 없으면 생성 후 저장
await mkdir("src/generated", { recursive: true });
await writeFile("src/generated/contract.ts", ts);
console.log("src/generated/contract.ts 생성 완료");
