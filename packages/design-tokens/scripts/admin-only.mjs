// 운영자 사이트 전용 토큰(결정 E6·BRD-165). 표시는 원본 tokens.json의 $extensions.baradun.adminOnly 하나뿐
// build-tokens: --admin일 때만 CSS로 내보냄. check-tokens: 초록 금지 검사에서 빼고, 사용자 사이트가 쓰는지 검사함
import { readFileSync } from "node:fs";

const tokens = JSON.parse(
  readFileSync(new URL("../tokens.json", import.meta.url), "utf8"),
);

// adminOnly 표시가 붙은 그룹·토큰의 경로(예: ["color", "success"])
function collect(node, path, out) {
  if (!node || typeof node !== "object") return out;
  if (node.$extensions?.baradun?.adminOnly === true) {
    out.push(path);
    return out;
  }
  for (const [key, child] of Object.entries(node)) {
    if (!key.startsWith("$")) collect(child, [...path, key], out);
  }
  return out;
}

export const ADMIN_ONLY_PATHS = collect(tokens, [], []);

export const isAdminOnly = (path) =>
  ADMIN_ONLY_PATHS.some((prefix) => prefix.every((key, i) => path[i] === key));
