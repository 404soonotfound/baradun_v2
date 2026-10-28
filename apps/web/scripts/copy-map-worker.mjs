// 지도 작업자 파일 복사 (BRD-65). MapLibre GL JS 6은 작업자(worker)를 별도 파일로 불러옴
// 번들러가 이 파일을 내보내지 않으므로 dev·build·storybook 전에 public/vendor로 복사함(커밋하지 않음)
// 파일 이름에 판 번호를 붙여 판을 올리면 브라우저가 새 파일을 받게 함(engine.ts가 같은 이름을 씀)
// 확장자는 .js(정적 호스팅이 .mjs 형식을 모를 수 있어 JavaScript로 확실히 내보냄)
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pkgPath = require.resolve("maplibre-gl/package.json");
const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
const from = join(dirname(pkgPath), "dist", "maplibre-gl-worker.mjs");
const outDir = new URL("../public/vendor/", import.meta.url);

mkdirSync(outDir, { recursive: true });
copyFileSync(from, new URL(`maplibre-gl-worker-${version}.js`, outDir));
console.log(`maplibre-gl-worker-${version}.js 복사함`);
