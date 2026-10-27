import { existsSync } from "node:fs";
import path from "node:path";

// 개발용 예시 특보·관측값이 깔려 있는지 (BRD-26). 빌드·개발 서버에서만 실행
// public/data는 dev:data(scripts/dev-data.mts)만 만들고, 배포 빌드는 prebuild의 --check가 막음.
// 그래서 manifest가 있으면 화면의 특보·관측값은 실제 확인 결과가 아니라 예시임
export function hasDevSampleSnapshot(): boolean {
  return existsSync(path.join(process.cwd(), "public/data/manifest.json"));
}
