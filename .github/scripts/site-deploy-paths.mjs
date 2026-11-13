import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const target = new URL("../site-deploy-paths.json", import.meta.url);

// CI의 shared 참조와 따옴표 경로만 허용함. 규칙이 바뀌면 경로 누락 대신 생성 실패.
export function siteDeployPaths(text) {
  const lines = text.split("\n").map((line) => line.replace(/\s+#.*$/, ""));
  const paths = (name, includeShared) => {
    const start = lines.findIndex((line) =>
      new RegExp(`^${name}: &${name}\\s*$`).test(line),
    );
    if (start < 0) throw new Error(`CI filter missing: ${name}`);
    const tail = lines.slice(start + 1);
    const end = tail.findIndex(
      (line) => /^\S/.test(line) && !line.startsWith("#"),
    );
    const entries = tail
      .slice(0, end < 0 ? undefined : end)
      .filter((line) => !/^\s*(?:#.*)?$/.test(line));
    if (includeShared && entries.shift() !== "  - *shared") {
      throw new Error(`CI shared filter missing: ${name}`);
    }
    if (!entries.length) throw new Error(`CI filter empty: ${name}`);
    return entries.map((line) => {
      const match = /^  - (["'])([\w./-]+)(\/\*\*)?\1\s*$/.exec(line);
      if (!match) throw new Error(`Unsupported CI filter: ${name}`);
      return match[2];
    });
  };
  const shared = paths("shared", false).filter(
    (path) => path !== ".github/workflows/ci.yml",
  );
  return {
    site: [...shared, ...paths("web", true)],
    admin: [...shared, ...paths("admin", true)],
  };
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const filters = readFileSync(
    new URL("../ci-filters.yml", import.meta.url),
    "utf8",
  );
  writeFileSync(
    target,
    JSON.stringify(siteDeployPaths(filters), null, 2) + "\n",
  );
}
