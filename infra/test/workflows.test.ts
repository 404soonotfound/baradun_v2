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

  it("배포는 main push CI가 끝난 뒤(와 수동 실행)에서만, production environment에서 한다 (BRD-133)", () => {
    expect(deploy).toBeDefined();
    const text = codeLines(deploy?.text ?? "").join("\n");
    expect(text).toMatch(
      /workflow_run:\s*\n\s*workflows:\s*\[ci\]\s*\n\s*types:\s*\[completed\]\s*\n\s*branches:\s*\[main\]/,
    );
    // push로 바로 배포하면 CI와 동시에 돌아 CI 실패 커밋이 나갈 수 있음
    expect(text).not.toMatch(/^\s{2}push:/m);
    expect(text).not.toMatch(/pull_request/);
    expect(text).toMatch(/environment:\s*production/);
  });

  it("자동 배포는 이 저장소 main push CI가 성공했을 때만, CI가 검사한 커밋을 올린다 (BRD-133)", () => {
    const lines = codeLines(deploy?.text ?? "");
    const text = lines.join("\n");
    expect(text).toContain("github.event.workflow_run.event == 'push'");
    expect(text).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(text).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(text).toMatch(
      /SHA:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha \|\| github\.sha\s*\}\}/,
    );
    expect(text).toMatch(/ref:\s*\$\{\{\s*env\.SHA\s*\}\}/);
    // 배포 그룹은 작업 수준: 조건에서 건너뛰는 실행이 대기 중인 배포를 취소하지 않게 함
    expect(text).not.toMatch(/^concurrency:/m);
    expect(jobLines(deploy?.text ?? "", "site").join("\n")).toMatch(
      /^\s{4}concurrency:\s*\n\s{6}group:\s*deploy-production/m,
    );
  });

  it("수동 실행은 체크아웃 전에 그 커밋의 ci-ok 성공을 확인하고, 아니면 멈춘다 (BRD-133)", () => {
    const lines = codeLines(deploy?.text ?? "");
    const guard = lines.findIndex((l) => l.includes("check_name=ci-ok"));
    const checkout = lines.findIndex((l) =>
      /uses:\s*actions\/checkout@/.test(l),
    );
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(checkout);
    expect(lines.slice(guard, checkout).join("\n")).toMatch(
      /"\$conclusion" != "success"[\s\S]*exit 1/,
    );
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

  it("e2e 빌드도 사이트 주소를 명시한다", () => {
    expect(webBuildSiteUrl(jobLines(ci?.text ?? "", "e2e-build"))).toMatch(
      /^https?:\/\/\S+$/,
    );
  });

  // 빌드 한 번 + 4개 샤드(BRD-134): 샤드가 빠지거나 빌드 결과 없이 돌면 검사가 줄어듦
  it("e2e는 e2e-build 결과를 받아 1/4~4/4 샤드로 모두 돌린다", () => {
    const e2e = jobLines(ci?.text ?? "", "e2e").join("\n");
    expect(e2e).toMatch(/needs:\s*\[changes, e2e-build\]/);
    expect(e2e).toMatch(/shard:\s*\[1, 2, 3, 4\]/);
    expect(e2e).toMatch(/fail-fast:\s*false/);
    expect(e2e).toContain("--shard=${{ matrix.shard }}/4");
    expect(e2e).toMatch(/name:\s*e2e-site\s*\n\s*path:\s*apps\/web\/out/);
    expect(jobLines(ci?.text ?? "", "e2e-build").join("\n")).toMatch(
      /name:\s*e2e-site\s*\n\s*path:\s*apps\/web\/out/,
    );
  });

  // main CI 성공이 배포 조건이라, main push에서는 바뀐 영역과 상관없이 웹 전체를 검사해야 함 (BRD-133)
  it("main push에서는 web·e2e를 늘 돌린다", () => {
    for (const job of ["web", "e2e-build", "e2e"]) {
      const cond = jobLines(ci?.text ?? "", job)
        .map((l) => l.match(/^\s{4}if:\s*(.+)$/)?.[1])
        .find((v) => v !== undefined);
      expect(cond, job).toContain("github.event_name == 'push'");
    }
  });

  it("web·e2e 결과는 ci-ok에 모인다", () => {
    const needs = jobLines(ci?.text ?? "", "ci-ok")
      .join("\n")
      .match(/needs:\s*\[([^\]]*)\]/)?.[1]
      .split(",")
      .map((n) => n.trim());
    expect(needs).toEqual(expect.arrayContaining(["web", "e2e-build", "e2e"]));
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
