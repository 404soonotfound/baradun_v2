import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// GitHub Actions 워크플로 파일을 글자로 읽어서 배포 가드레일을 검사함 (11장).
const dir = resolve(__dirname, "../../.github/workflows");
const workflows = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ name: f, text: readFileSync(resolve(dir, f), "utf8") }));
const deploy = workflows.find((w) => w.name === "deploy.yml");

// 주석(# 뒤)은 빼고 검사함
const codeLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, ""));

describe("배포 워크플로 가드레일 (11장)", () => {
  it("어떤 워크플로도 pull_request_target을 쓰지 않는다", () => {
    for (const w of workflows) {
      expect(codeLines(w.text).join("\n"), w.name).not.toContain(
        "pull_request_target",
      );
    }
  });

  it("외부 Action은 모두 커밋 SHA(40자)로 고정한다", () => {
    const uses = workflows.flatMap((w) =>
      codeLines(w.text)
        .map((line) => line.match(/^\s*(?:-\s*)?uses:\s*(\S+)/)?.[1])
        .filter((u): u is string => u !== undefined)
        .map((u) => ({ file: w.name, uses: u })),
    );

    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      if (u.uses.startsWith("./")) continue; // 저장소 안의 Action
      expect(u.uses, u.file).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  it("OIDC 토큰(id-token: write)은 배포 워크플로만 받는다", () => {
    for (const w of workflows) {
      const hasIdToken = codeLines(w.text).some((l) =>
        /id-token:\s*write/.test(l),
      );
      expect(hasIdToken, w.name).toBe(w.name === "deploy.yml");
    }
  });

  it("배포는 main push(와 수동 실행)에서만, production environment에서 한다", () => {
    expect(deploy).toBeDefined();
    const text = codeLines(deploy?.text ?? "").join("\n");
    expect(text).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
    expect(text).not.toMatch(/pull_request/);
    expect(text).toMatch(/environment:\s*production/);
  });

  it("사이트 동기화(s3 sync)는 모두 data/를 제외한다", () => {
    const syncs = codeLines(deploy?.text ?? "").filter((l) =>
      l.includes("aws s3 sync"),
    );
    expect(syncs.length).toBeGreaterThan(0);
    for (const line of syncs) expect(line).toContain('--exclude "data/*"');
  });

  it("사이트 빌드에 문의 사진 버킷 이름을 넘기고, 비어 있으면 빌드 전에 멈춘다(BRD-103)", () => {
    const lines = codeLines(deploy?.text ?? "");
    const text = lines.join("\n");
    expect(text).toContain(
      "NEXT_PUBLIC_INQUIRY_PHOTO_BUCKET: ${{ vars.INQUIRY_PHOTO_BUCKET }}",
    );
    const guard = lines.findIndex((l) => l.includes("문의 사진 버킷 이름 확인"));
    const build = lines.findIndex((l) => l.includes("npm run build -w apps/web"));
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(build);
    expect(text).toMatch(/exit 1/);
  });
});

