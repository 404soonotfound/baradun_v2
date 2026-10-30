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

// 작업 하나(jobs 아래 두 칸 들여쓴 이름)의 코드 줄만 꺼냄
const jobLines = (text: string, job: string) => {
  const lines = codeLines(text);
  const start = lines.indexOf(`  ${job}:`);
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
  return lines.slice(start, end < 0 ? undefined : end);
};

// 웹 빌드 단계의 env에 적힌 NEXT_PUBLIC_SITE_URL 값. 단계가 없거나 값이 없으면 undefined
const webBuildSiteUrl = (lines: string[]) => {
  const at = lines.findIndex((l) =>
    /^\s*-\s*run:\s*npm run build -w apps\/web\s*$/.test(l),
  );
  if (at < 0) return undefined;
  const next = lines.findIndex((l, i) => i > at && /^\s*-\s/.test(l));
  return lines
    .slice(at + 1, next < 0 ? undefined : next)
    .map((l) => l.match(/^\s*NEXT_PUBLIC_SITE_URL:\s*(.+?)\s*$/)?.[1])
    .find((v) => v !== undefined);
};

describe("PR 필수 웹 검사 (BRD-102 결정 41·42)", () => {
  const ci = workflows.find((w) => w.name === "ci.yml");

  it("web 작업은 타입 검사와, 사이트 주소를 명시한 정적 빌드를 돌린다", () => {
    const web = jobLines(ci?.text ?? "", "web");
    expect(web).toContainEqual(
      expect.stringMatching(/^\s*-\s*run:\s*npm run typecheck -w apps\/web$/),
    );
    expect(webBuildSiteUrl(web)).toMatch(/^https?:\/\/\S+$/);
  });

  it("e2e 작업의 빌드도 사이트 주소를 명시한다", () => {
    expect(webBuildSiteUrl(jobLines(ci?.text ?? "", "e2e"))).toMatch(
      /^https?:\/\/\S+$/,
    );
  });

  it("web·e2e 결과는 ci-ok에 모인다", () => {
    const needs = jobLines(ci?.text ?? "", "ci-ok")
      .join("\n")
      .match(/needs:\s*\[([^\]]*)\]/)?.[1]
      .split(",")
      .map((n) => n.trim());
    expect(needs).toEqual(expect.arrayContaining(["web", "e2e"]));
  });

  it("배포 빌드는 저장소 변수 SITE_URL을 사이트 주소로 넣는다", () => {
    expect(webBuildSiteUrl(codeLines(deploy?.text ?? ""))).toBe(
      "${{ vars.SITE_URL }}",
    );
  });

  it("워크플로는 secrets.*나 API 키 환경 변수를 쓰지 않고, 웹 빌드에는 공개 변수만 넘긴다 (BRD-67)", () => {
    for (const w of workflows) {
      const text = codeLines(w.text).join("\n");
      expect(text, w.name).not.toMatch(/\bsecrets\./);
      expect(text, w.name).not.toMatch(
        /\b(KMA_APIHUB_AUTH_KEY|DATA_GO_KR_SERVICE_KEY)\b/,
      );
      const nextPublicKeys = [
        ...text.matchAll(/\b(NEXT_PUBLIC_[A-Z0-9_]+)\s*:/g),
      ].map((m) => m[1]);
      for (const key of nextPublicKeys) {
        expect(
          ["NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_INQUIRY_PHOTO_BUCKET"],
          `${w.name}: ${key}`,
        ).toContain(key);
      }
    }
  });
});
