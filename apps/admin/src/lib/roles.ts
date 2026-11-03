import { messages } from "./messages";

// 권한 이름(화면 표시만). 판단은 서버가 요청마다 다시 함(D16-A7)
export function roleLabel(
  pool: "operator" | "demo",
  groups: readonly string[],
): string | null {
  const t = messages.home;
  if (pool === "demo") return t.roleDemo;
  if (groups.includes("publisher")) return t.rolePublisher;
  if (groups.includes("editor")) return t.roleEditor;
  if (groups.includes("viewer")) return t.roleViewer;
  return null;
}
