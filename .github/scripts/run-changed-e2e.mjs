import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const app = process.argv[2];
if (app !== "web" && app !== "admin") {
  throw new Error("앱은 web 또는 admin이어야 합니다.");
}

const changed = JSON.parse(process.env.CHANGED_E2E_SPECS ?? "null");
if (
  !Array.isArray(changed) ||
  !changed.every((file) => typeof file === "string")
) {
  throw new Error("변경된 E2E spec 목록을 읽지 못했습니다.");
}

const appDir = path.resolve(`apps/${app}`);
const prefix = `apps/${app}/e2e/`;
if (
  changed.some(
    (file) =>
      !file.startsWith(prefix) ||
      !file.endsWith(".spec.ts") ||
      file.split("/").includes(".."),
  )
) {
  throw new Error("E2E spec 목록에 허용되지 않은 경로가 있습니다.");
}
const files = changed
  .map((file) => file.slice(`apps/${app}/`.length))
  .filter((file) => existsSync(path.join(appDir, file)));

if (files.length === 0) {
  console.log("실행할 변경 E2E spec이 없습니다.");
  process.exit(0);
}

const regexPaths = files.map(
  (file) => `${file.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`,
);
const result = spawnSync(
  "npx",
  [
    "--no-install",
    "playwright",
    "test",
    "--grep-invert",
    "@smoke",
    "--pass-with-no-tests",
    ...regexPaths,
  ],
  { cwd: appDir, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
