import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// 개발용 예시 특보·관측값이 깔려 있는지 (BRD-26). 빌드·개발 서버에서만 실행
// public/data는 dev:data·개발 서버(scripts/dev-data.mts·dev-live.mts)만 만들고, 배포 빌드는 prebuild의 --check가 막음.
// 운영 snapshot 미러(npm run live, 표지 live)는 실제 확인 결과라 예시가 아님(BRD-109).
// 그 밖에 manifest가 있으면(표지 sample·표지 없는 옛 예시) 화면의 특보·관측값은 예시로 봄
export function hasDevSampleSnapshot(
  dataDir: string = path.join(process.cwd(), "public/data"),
): boolean {
  if (!existsSync(path.join(dataDir, "manifest.json"))) return false;
  try {
    return (
      readFileSync(path.join(dataDir, ".dev-data-mode"), "utf8").trim() !==
      "live"
    );
  } catch {
    return true;
  }
}
