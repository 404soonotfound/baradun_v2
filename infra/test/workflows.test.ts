import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// GitHub Actions 워크플로 파일을 글자로 읽어서 배포 가드레일을 검사함 (11장).
const dir = resolve(__dirname, "../../.github/workflows");
const workflows = readdirSync(dir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ name: f, text: readFileSync(resolve(dir, f), "utf8") }));
const deploy = workflows.find((w) => w.name === "deploy.yml");
const ci = workflows.find((w) => w.name === "ci.yml");
// 한국 지도 파일 만들기(결정 기록 D19-1 · #392)
const mapTiles = workflows.find((w) => w.name === "map-tiles.yml");
const mapUpload = readFileSync(
  resolve(__dirname, "../../tools/map-tiles/upload.sh"),
  "utf8",
);
// 배포 판단 스크립트(BRD-178). deploy.yml의 site·admin 작업이 함께 씀
const plan = readFileSync(
  resolve(__dirname, "../../.github/scripts/deploy-plan.sh"),
  "utf8",
);

// Project 스냅샷(아침 보고용): 비밀값 금지의 유일한 예외
const PROJECT_SNAPSHOT = "project-snapshot.yml";
const PROJECT_TOKEN_REF = "${{ secrets.PROJECT_READ_TOKEN }}";
const projectSnapshot = workflows.find((w) => w.name === PROJECT_SNAPSHOT);

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

  // 고정한 SHA가 낡지 않게 Dependabot이 Action 버전 갱신 PR을 냄(#303)
  it("Dependabot이 github-actions를 매주 갱신하고 새 버전은 7일 기다린다", () => {
    const dependabot = codeLines(
      readFileSync(resolve(__dirname, "../../.github/dependabot.yml"), "utf8"),
    ).join("\n");
    expect(dependabot).toMatch(/^version:\s*2$/m);
    // 다른 생태계 항목이 생겨도 github-actions 항목 안에서만 검사함. 따옴표는 있어도 없어도 같은 값
    const q = (value: string) => `["']?${value}["']?\\s*$`;
    const actions = dependabot
      .split(/^\s*-\s*package-ecosystem:/m)
      .find((entry) =>
        new RegExp(`^\\s*${q("github-actions")}`, "m").test(
          entry.split("\n")[0],
        ),
      );
    expect(actions).toBeDefined();
    expect(actions).toMatch(new RegExp(`^\\s*directory:\\s*${q("/")}`, "m"));
    expect(actions).toMatch(
      new RegExp(`^\\s*schedule:\\s*\\n\\s+interval:\\s*${q("weekly")}`, "m"),
    );
    expect(actions).toMatch(/^\s*cooldown:\s*\n\s+default-days:\s*7\s*$/m);
    // 갱신이 조용히 꺼지는 설정: PR 상한 0, 전체 무시
    expect(actions).not.toMatch(/^\s*open-pull-requests-limit:\s*0\s*$/m);
    expect(actions).not.toMatch(
      new RegExp(`dependency-name:\\s*${q("\\*")}`, "m"),
    );
  });

  it("OIDC 토큰(id-token: write)은 배포 워크플로와 지도 파일 워크플로만 받는다", () => {
    for (const w of workflows) {
      const hasIdToken = codeLines(w.text).some((l) =>
        /id-token:\s*write/.test(l),
      );
      expect(hasIdToken, w.name).toBe(
        w.name === "deploy.yml" || w.name === "map-tiles.yml",
      );
    }
  });

  it("지도 파일 워크플로는 main 수동 실행만, 외부 도구를 돌리는 작업은 토큰 없이, 올리기만 production에서 토큰을 받는다 (D19-1)", () => {
    expect(mapTiles).toBeDefined();
    const text = codeLines(mapTiles?.text ?? "").join("\n");
    // 트리거는 수동 실행 하나(on: 블록 안의 키가 workflow_dispatch뿐)
    const onBlock = text.match(/^on:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m)?.[1] ?? "";
    const triggers = onBlock
      .split("\n")
      .map((l) => l.match(/^ {2}([a-z_]+):/)?.[1])
      .filter((t): t is string => t !== undefined);
    expect(triggers).toEqual(["workflow_dispatch"]);
    // 워크플로 맨 위 권한은 읽기만(토큰은 올리기 작업에서만 받음)
    const top = text.slice(0, text.indexOf("\njobs:"));
    expect(top).not.toMatch(/id-token/);
    const jobs = text.split(/^  (?=[a-z-]+:\s*$)/m);
    const build = jobs.find((j) => j.startsWith("build:")) ?? "";
    const upload = jobs.find((j) => j.startsWith("upload:")) ?? "";
    expect(build).toContain("tools/map-tiles/build.sh");
    expect(build).not.toMatch(/id-token:/);
    expect(build).not.toMatch(/configure-aws-credentials/);
    expect(build).toMatch(/github\.ref == 'refs\/heads\/main'/);
    expect(upload).toMatch(/needs:\s*build/);
    expect(upload).toMatch(/github\.ref == 'refs\/heads\/main'/);
    expect(upload).toMatch(/environment:\s*production/);
    expect(upload).toMatch(/id-token:\s*write/);
    expect(upload).toContain("tools/map-tiles/upload.sh");
    // 이미 있는 판 폴더는 덮어쓰지 않음(1년 캐시와 충돌하지 않게)
    expect(mapUpload).toMatch(
      /list-objects-v2[^\n]*--prefix "\$PREFIX\/"[\s\S]*?KeyCount[\s\S]*?exit 1/,
    );
    // 완료 표시(READY.txt)는 모든 파일을 올린 뒤 마지막에 둠
    expect(mapUpload.lastIndexOf("aws s3 cp")).toBe(
      mapUpload.indexOf('aws s3 cp - "s3://$BUCKET/$PREFIX/READY.txt"'),
    );
    // 변수가 비면 건너뛰지 않고 실패
    expect(upload).toMatch(/-z "\$ROLE_ARN"[\s\S]*?exit 1/);
    // 만든 뒤 형식·자산 확인, 올린 뒤 CloudFront 경로 확인(토큰 없이 공개 주소 읽기)
    expect(build).toMatch(/build\.sh[\s\S]*?verify\.mjs --dir/);
    const verify = jobs.find((j) => j.startsWith("verify:")) ?? "";
    expect(verify).toMatch(/needs:\s*upload/);
    expect(verify).toContain(
      'node tools/map-tiles/verify.mjs --site "$SITE_URL" --version "$VERSION"',
    );
    expect(verify).not.toMatch(
      /id-token|configure-aws-credentials|environment:/,
    );
    expect(verify).toMatch(/-z "\$SITE_URL"[\s\S]*?exit 1/);
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
      /HEAD_SHA:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha \|\| github\.sha\s*\}\}/,
    );
    // 올릴 커밋은 main push CI 실행 결과만 보고 정함(PR 실행 결과를 main 검증으로 쓰지 않음, BRD-178)
    expect(plan).toContain(
      "actions/workflows/ci.yml/runs?branch=main&event=push",
    );
    // 검사는 push 단위(여러 커밋 머지는 맨 위 커밋만 실행)라, 그 실행에서 이 앱 빌드 작업이 성공했는지로 고름
    expect(plan).toContain("actions/runs/$id/jobs");
    expect(plan).toMatch(/if checked "\$c"; then/);
    expect(plan).not.toMatch(/touches\(\)/);
    // 조회 실패는 실패로 멈춤(빈 결과를 '성공 없음'으로 읽지 않음)
    expect(plan).toMatch(/if ! runs=\$\(gh api[\s\S]*?exit 1/);
    for (const job of ["site", "admin"]) {
      const lines = jobLines(deploy?.text ?? "", job).join("\n");
      expect(lines, job).toContain("ref: main");
      expect(lines, job).toContain("fetch-depth: 0");
      expect(lines, job).toContain(".github/scripts/deploy-plan.sh");
      expect(lines, job).toContain("actions: read");
    }
    // 배포 그룹은 작업 수준: 조건에서 건너뛰는 실행이 대기 중인 배포를 취소하지 않게 함
    expect(text).not.toMatch(/^concurrency:/m);
    expect(jobLines(deploy?.text ?? "", "site").join("\n")).toMatch(
      /^\s{4}concurrency:\s*\n\s{6}group:\s*deploy-production/m,
    );
  });

  // 결정 기록 D20-6·7: 웹은 지금 판단 정책만 읽음 → 운영 게시본 정책을 새 빌드가 읽지 못하면 올리지 않음(publisher 먼저)
  it("사이트 배포는 빌드 뒤·파일 올리기 전에 운영 게시본의 판단 정책 버전을 확인한다", () => {
    const lines = jobLines(deploy?.text ?? "", "site").join("\n");
    const build = lines.indexOf("run: npm run build -w apps/web");
    const check = lines.indexOf(
      'run: node scripts/check-live-policy.mts "$URL"',
    );
    const upload = lines.indexOf("name: 사이트 파일 올리기");
    expect(build).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(build);
    expect(upload).toBeGreaterThan(check);
    expect(lines).toMatch(
      /name: 판단 정책 버전 확인\s*\n\s*working-directory: apps\/web\s*\n\s*env:\s*\n\s*URL: \$\{\{ vars\.SITE_URL \}\}/,
    );
  });

  it("배포 판단의 CI_JOB은 ci.yml에서 그 앱 영역이 바뀔 때만 도는 빌드 작업이다", () => {
    for (const [job, ciJob, area] of [
      ["site", "e2e-build", "web"],
      ["admin", "admin-build", "admin"],
    ] as const) {
      const lines = jobLines(deploy?.text ?? "", job).join("\n");
      expect(lines, job).toMatch(new RegExp(`^\\s+CI_JOB: ${ciJob}$`, "m"));
      expect(jobIf(ci?.text ?? "", ciJob), ciJob).toBe(
        `needs.changes.outputs.${area} == 'true'`,
      );
      // 작업 API는 표시 이름(name)으로 찾으므로, name을 따로 두면 작업 키와 달라져 배포가 늘 건너뜀
      expect(
        jobLines(ci?.text ?? "", ciJob).some((l) => /^\s{4}name:/.test(l)),
        ciJob,
      ).toBe(false);
    }
    // 작업 이름이 없으면 멈춤, 표시와 앱 파일이 같으면 건너뜀, 검사 안 된 앱 변경이 남으면 경고
    expect(plan).toContain(': "${CI_JOB:?');
    expect(plan).toContain(
      'git diff --quiet "$deployed" "$target" -- "${paths[@]}"',
    );
    expect(plan).toMatch(
      /git diff --quiet "\$deployed" HEAD -- "\$\{paths\[@\]\}"; then\s*\n\s*echo "::warning::/,
    );
  });

  it("지도 판 확인(map-files)은 지도 판·스타일·도구 변경 PR에서만, 공개 주소 읽기로 돌고 ci-ok에 묶인다 (D19-1 · #392)", () => {
    const text = ci?.text ?? "";
    const cond = jobIf(text, "map-files") ?? "";
    // main push·정기 실행에서는 돌지 않음(실패하면 배포가 막힘), 지도와 무관한 웹 PR은 외부 지도 요청 없음
    expect(cond).toBe(
      "github.event_name == 'pull_request' && needs.changes.outputs.map == 'true'",
    );
    const job = codeLines(jobLines(text, "map-files").join("\n")).join("\n");
    expect(job).toContain('node tools/map-tiles/verify.mjs --site "$SITE_URL"');
    expect(job).not.toMatch(/id-token|configure-aws-credentials|secrets\./);
    expect(job).toMatch(/-z "\$SITE_URL"[\s\S]*?exit 1/);
    // 지도 판 이름·스타일·지도 제공 경로가 바뀌면 돎
    const filter =
      text.match(/\n {12}map:[^\n]*\n((?: {14}- .*\n)+)/)?.[1] ?? "";
    for (const path of [
      "apps/web/src/lib/map/style.ts",
      "apps/web/src/lib/map/style-*.json",
      "tools/map-tiles/**",
      ".github/workflows/map-tiles.yml",
    ]) {
      expect(filter).toContain(`'${path}'`);
    }
    // 사이트 인프라는 PR 때 운영 반영 전이라 보지 않음(배포 뒤 deploy:infra가 확인). 넣으면 고치는 PR이 막힘
    expect(filter).not.toContain("infra/");
    expect(jobLines(text, "ci-ok").join("\n")).toMatch(/^\s+map-files,$/m);
  });

  it("인프라 배포(deploy:infra)는 배포 뒤 운영 CloudFront에서 지도 판을 확인하고 결과를 댓글에 남긴다 (D19-1 · #392)", () => {
    const script = readFileSync(
      resolve(__dirname, "../scripts/deploy.mjs"),
      "utf8",
    );
    const at = script.indexOf(
      'step(9, "운영 CloudFront에서 웹이 쓰는 지도 판을 확인해요")',
    );
    expect(at).toBeGreaterThan(
      script.indexOf("console.log(`\\n배포 완료: ${subject}`)"),
    );
    expect(script.slice(at)).toMatch(
      /"tools", "map-tiles", "verify\.mjs"[\s\S]*?"--site"[\s\S]*?postIssueComment\([\s\S]*?지도 판 확인: \$\{mapCheck\}/,
    );
    // SITE_URL을 못 읽으면 통과로 적지 않음
    expect(script.slice(at)).toContain(
      "확인 못 함(저장소 변수 SITE_URL을 읽지 못함)",
    );
  });

  it("옛 OpenFreeMap 스모크는 없고, 정기 실행에는 audit·gitleaks가 남는다 (#392)", () => {
    const text = ci?.text ?? "";
    expect(jobLines(text, "map-smoke")).toEqual([]);
    expect(codeLines(text).join("\n")).not.toMatch(/check:map|openfreemap/i);
    expect(text).toMatch(/schedule:\s*\n\s*- cron:/);
    expect(jobIf(text, "audit")).toContain("github.event_name == 'schedule'");
    expect(
      codeLines(jobLines(text, "gitleaks").join("\n")).join("\n"),
    ).toContain('"${{ github.event_name }}" = "schedule"');
  });

  it("수동 실행은 그 커밋의 main CI가 성공일 때만 올리고, 아니면 멈춘다 (BRD-133)", () => {
    expect(plan).toMatch(
      /MANUAL:-false\}" = "true"[\s\S]*?ci_ok "\$HEAD_SHA"\)" != "success"[\s\S]*?exit 1/,
    );
  });

  it("웹 사이트 동기화(s3 sync)는 지도 파일 구역 map/을 제외한다 (D19-1)", () => {
    const text = deploy?.text ?? "";
    const site = text.slice(
      text.indexOf("\n  site:"),
      text.indexOf("\n  admin:"),
    );
    const syncs = codeLines(site).filter((l) => l.includes("aws s3 sync"));
    expect(syncs.length).toBeGreaterThan(0);
    for (const line of syncs) expect(line).toContain('--exclude "map/*"');
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
    const guard = lines.findIndex((l) =>
      l.includes("문의 사진 버킷 이름 확인"),
    );
    const build = lines.findIndex((l) =>
      l.includes("npm run build -w apps/web"),
    );
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

// 작업의 실행 조건(if: 한 줄)
const jobIf = (text: string, job: string) =>
  jobLines(text, job)
    .map((l) => l.match(/^\s{4}if:\s*(.+)$/)?.[1])
    .find((v) => v !== undefined);

// 웹 빌드 단계의 env에 적힌 NEXT_PUBLIC_SITE_URL 값. 단계가 없거나 값이 없으면 undefined
const webBuildSiteUrl = (lines: string[]) => {
  const at = lines.findIndex((l) =>
    /^\s*(-\s*)?run:\s*npm run build -w apps\/web\s*$/.test(l),
  );
  if (at < 0) return undefined;
  const next = lines.findIndex((l, i) => i > at && /^\s*-\s/.test(l));
  return lines
    .slice(at + 1, next < 0 ? undefined : next)
    .map((l) => l.match(/^\s*NEXT_PUBLIC_SITE_URL:\s*(.+?)\s*$/)?.[1])
    .find((v) => v !== undefined);
};

describe("PR 필수 웹 검사 (BRD-102 결정 41·42)", () => {
  it("infra CI는 고정 IAM·CFN 자료를 검사하고 최신 감사는 별도 읽기 전용 실행이다", () => {
    const infra = jobLines(ci?.text ?? "", "infra").join("\n");
    expect(infra).toContain("npm run check:iam-actions -w @baradun/infra");
    expect(infra.indexOf("npx cdk synth")).toBeGreaterThanOrEqual(0);
    expect(infra.indexOf("npm run check:iam-actions")).toBeGreaterThan(
      infra.indexOf("npx cdk synth"),
    );
    expect(infra).not.toMatch(/--check-latest|--update-reference/);
    const audit = codeLines(
      workflows.find((w) => w.name === "iam-reference-audit.yml")?.text ?? "",
    ).join("\n");
    expect(audit).toContain("-- --check-latest");
    expect(audit).toContain('cron: "0 0 * * 1"');
    expect(audit).toContain("workflow_dispatch:");
    expect(audit).toContain("contents: read");
    expect(audit).not.toMatch(
      /pull_request:|push:|id-token:|contents:\s*write|--update-reference|aws\s/,
    );
  });

  // 정적 빌드는 e2e-build에서 한 번만(BRD-178): web 작업은 검사만, 빌드 결과의 CSP 검사는 e2e-build
  it("web 작업은 타입 검사를 돌리고, 정적 빌드·CSP 검사는 e2e-build가 한 번 한다", () => {
    const web = jobLines(ci?.text ?? "", "web");
    expect(web).toContainEqual(
      expect.stringMatching(/^\s*-\s*run:\s*npm run typecheck -w apps\/web$/),
    );
    expect(web.join("\n")).not.toContain("npm run build -w apps/web");
    const build = jobLines(ci?.text ?? "", "e2e-build").join("\n");
    expect(build.indexOf("npm run check:csp -w apps/web")).toBeGreaterThan(
      build.indexOf("npm run build -w apps/web"),
    );
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

  // main push도 바뀐 영역만(BRD-178, 10/30 BRD-133 '늘 전체'를 바꿈). main 규칙이 '최신 브랜치만 머지'라 PR CI가 같은 내용을 검사함
  // 대신 main push CI는 커밋마다 따로 돌고 취소하지 않음(취소되면 그 커밋의 변경이 배포에서 빠짐)
  it("main push도 바뀐 영역만 검사하고, main push CI는 커밋마다 따로 돌며 취소하지 않는다", () => {
    for (const job of [
      "web",
      "e2e-build",
      "e2e",
      "admin",
      "admin-build",
      "admin-e2e",
      "admin-e2e-engines",
    ]) {
      const cond = jobIf(ci?.text ?? "", job);
      const area = job.startsWith("admin") ? "admin" : "web";
      expect(cond, job).toBe(`needs.changes.outputs.${area} == 'true'`);
    }
    const text = codeLines(ci?.text ?? "").join("\n");
    expect(text).toContain(
      "group: ci-${{ github.event_name == 'schedule' && 'schedule' || (github.event_name == 'push' && github.sha) || github.ref }}",
    );
    expect(text).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
  });

  // 바뀐 앱만 배포하므로, 빌드가 읽는 앱 밖 파일과 배포 빌드 방법(deploy.yml)도 그 앱의 변경으로 봄
  it("빌드가 읽는 앱 밖 파일과 deploy.yml은 그 앱의 바뀐 영역에 들어간다", () => {
    const changes = jobLines(ci?.text ?? "", "changes");
    const filter = (area: string) => {
      const start = changes.findIndex((l) =>
        new RegExp(`^\\s{12}${area}:`).test(l),
      );
      const end = changes.findIndex(
        (l, i) => i > start && /^\s{12}[a-z_]+:/.test(l),
      );
      return changes.slice(start, end < 0 ? undefined : end).join("\n");
    };
    for (const path of [
      "data/beaches/**",
      "data/beach-meta.json",
      ".github/workflows/deploy.yml",
    ]) {
      expect(filter("web"), path).toContain(`'${path}'`);
    }
    for (const path of ["data/beaches/**", ".github/workflows/deploy.yml"]) {
      expect(filter("admin"), path).toContain(`'${path}'`);
    }
  });

  // 바뀐 앱만 배포(BRD-178): 마지막으로 올린 커밋(deploy-version.txt) 뒤로 main CI가 그 앱 빌드 작업까지 성공한 가장 새 커밋
  // 옛 커밋이 새 배포를 덮지 않고, CI가 실패한 커밋의 변경은 그 앱을 다시 검사한 뒤 커밋으로만 나감
  const deployPaths = (job: string) => {
    const lines = jobLines(deploy?.text ?? "", job);
    const start = lines.findIndex((l) =>
      l.includes(".github/scripts/deploy-plan.sh"),
    );
    const out: string[] = [];
    for (const l of lines.slice(start + 1)) {
      const m = l.match(/^\s+(\S+?)(\s*\\)?$/);
      if (!m || /^\s*-\s/.test(l)) break;
      out.push(m[1]!);
      if (!m[2]) break;
    }
    return out;
  };
  const ciFilter = (name: string) => {
    // paths-filter의 filters 블록 안에서 찾음(changes 출력의 같은 이름과 섞이지 않게)
    const text = codeLines(ci?.text ?? "");
    const block = text.findIndex((l) => l.trim() === "filters: |");
    const at = text.findIndex(
      (l, i) => i > block && /^\s*([\w-]+):/.exec(l)?.[1] === name,
    );
    const out: string[] = [];
    for (const l of text.slice(at + 1)) {
      const m = l.match(/^\s*-\s*'([^']+)'\s*$/);
      if (m) out.push(m[1]!.replace(/\/\*\*$/, ""));
      else if (/^\s*-\s*\*shared\s*$/.test(l)) continue;
      else break;
    }
    return out;
  };

  it("배포 비교 경로는 ci.yml의 바뀐 영역 필터(공통 + 앱)에서 빌드와 상관없는 ci.yml만 뺀 것과 같다", () => {
    const shared = ciFilter("shared").filter(
      (p) => p !== ".github/workflows/ci.yml",
    );
    expect(shared.length).toBeGreaterThan(0);
    expect(deployPaths("site").sort()).toEqual(
      [...shared, ...ciFilter("web")].sort(),
    );
    expect(deployPaths("admin").sort()).toEqual(
      [...shared, ...ciFilter("admin")].sort(),
    );
  });

  it("배포는 정한 결과를 따르고, 표시는 동기화·캐시 비우기가 끝난 뒤 마지막에 올리며, 빌드 캐시를 복원하지 않는다", () => {
    // 표시 뒤로 고를 커밋이 없으면 건너뜀, 표시를 못 읽으면 경고 뒤 올림
    expect(plan).toContain('git merge-base --is-ancestor "$deployed" HEAD');
    expect(plan).toContain('git rev-list --first-parent "$deployed..HEAD"');
    expect(plan).toMatch(/deploy=false/);
    expect(plan).toContain("::warning::");
    for (const [job, dir] of [
      ["site", "apps/web/out"],
      ["admin", "apps/admin/out"],
    ] as const) {
      const lines = jobLines(deploy?.text ?? "", job);
      const text = lines.join("\n");
      const decide = lines.findIndex((l) => l.includes("- id: decide"));
      const steps = lines.slice(decide + 1).filter((l) => /^\s{6}-\s/.test(l));
      expect(steps.length, job).toBeGreaterThan(3);
      for (const step of steps) {
        expect(step, job).toBe(
          "      - if: steps.decide.outputs.deploy == 'true'",
        );
      }
      // 중간에 실패한 배포를 다시 실행하면 건너뛰지 않게 표시는 맨 마지막
      const marker = lines.findIndex((l) =>
        l.includes('aws s3 cp - "s3://$BUCKET/deploy-version.txt"'),
      );
      const lastSync = lines.reduce(
        (at, l, i) => (l.includes("aws s3 sync") ? i : at),
        -1,
      );
      const invalidation = lines.findIndex((l) =>
        l.includes("aws cloudfront create-invalidation"),
      );
      expect(marker, job).toBeGreaterThan(lastSync);
      expect(marker, job).toBeGreaterThan(invalidation);
      expect(text, job).not.toContain("> deploy-version.txt");
      expect(text, job).toContain(`working-directory: ${dir}`);
      // OIDC 토큰을 받는 배포 작업은 캐시를 복원하지 않음(CodeQL actions/cache-poisoning)
      expect(text, job).not.toMatch(/actions\/cache/);
    }
  });

  it("CI의 Next 빌드 캐시는 main push에서만 저장한다", () => {
    for (const job of ["e2e-build", "admin-build"]) {
      const text = jobLines(ci?.text ?? "", job).join("\n");
      expect(text, job).toMatch(/uses: actions\/cache\/restore@/);
      expect(text, job).toMatch(
        /if: github\.event_name == 'push' && steps\.next-cache\.outputs\.cache-hit != 'true'\s*\n\s*uses: actions\/cache\/save@/,
      );
      expect(text, job).not.toMatch(/uses: actions\/cache@/);
    }
  });

  it("E2E는 Playwright 브라우저를 lock 파일 기준으로 캐시하고, 운영자 E2E는 빌드 결과를 받아 돈다", () => {
    for (const job of ["e2e", "admin-e2e"]) {
      const lines = jobLines(ci?.text ?? "", job).join("\n");
      expect(lines, job).toContain("path: ~/.cache/ms-playwright");
      expect(lines, job).toContain(
        "key: playwright-${{ runner.os }}-${{ hashFiles('package-lock.json') }}",
      );
    }
    expect(jobLines(ci?.text ?? "", "admin-e2e").join("\n")).toMatch(
      /needs:\s*\[changes, admin-build\]/,
    );
    expect(jobLines(ci?.text ?? "", "admin-e2e").join("\n")).toMatch(
      /name:\s*admin-site\s*\n\s*path:\s*apps\/admin\/out/,
    );
  });

  // 지원 브라우저 기준안(D16-E2): Firefox·WebKit 엔진 E2E는 admin-e2e와 나란히, 같은 빌드 결과로 돎
  it("운영자 E2E는 chromium(admin-e2e)과 Firefox·WebKit(admin-e2e-engines)을 나눠 같은 빌드 결과로 돌린다", () => {
    const chromium = jobLines(ci?.text ?? "", "admin-e2e").join("\n");
    const engines = jobLines(ci?.text ?? "", "admin-e2e-engines").join("\n");
    expect(chromium).toContain("npm run test:e2e -w apps/admin");
    expect(engines).toMatch(/needs:\s*\[changes, admin-build\]/);
    expect(engines).toMatch(
      /name:\s*admin-site\s*\n\s*path:\s*apps\/admin\/out/,
    );
    expect(engines).toContain("playwright install --with-deps firefox webkit");
    // 캐시가 있을 때도 OS 의존성은 설치해야 함(빠지면 두 번째 실행부터 엔진이 시작하지 못함)
    expect(engines).toContain("playwright install-deps firefox webkit");
    expect(engines).toContain(
      "key: playwright-engines-${{ runner.os }}-${{ hashFiles('package-lock.json') }}",
    );
    expect(engines).toContain("npm run test:e2e:engines -w apps/admin");
  });

  it("web·e2e 결과는 ci-ok에 모인다", () => {
    const needs = jobLines(ci?.text ?? "", "ci-ok")
      .join("\n")
      .match(/needs:\s*\[([^\]]*)\]/)?.[1]
      .split(",")
      .map((n) => n.trim());
    expect(needs).toEqual(
      expect.arrayContaining([
        "web",
        "e2e-build",
        "e2e",
        "admin",
        "admin-build",
        "admin-e2e",
        "admin-e2e-engines",
        "gitleaks",
      ]),
    );
  });

  it("배포 빌드는 저장소 변수 SITE_URL을 사이트 주소로 넣는다", () => {
    expect(webBuildSiteUrl(codeLines(deploy?.text ?? ""))).toBe(
      "${{ vars.SITE_URL }}",
    );
  });

  it("워크플로는 secrets.*나 API 키 환경 변수를 쓰지 않고, 웹 빌드에는 공개 변수만 넘긴다 (BRD-67)", () => {
    for (const w of workflows) {
      let text = codeLines(w.text).join("\n");
      // 예외 하나: Project 스냅샷의 읽기 전용 토큰(아래 테스트에서 범위를 따로 검사)
      if (w.name === PROJECT_SNAPSHOT) {
        text = text.replaceAll(PROJECT_TOKEN_REF, "");
      }
      expect(text, w.name).not.toMatch(/\bsecrets\./);
      expect(text, w.name).not.toMatch(
        /\b(KMA_APIHUB_AUTH_KEY|DATA_GO_KR_SERVICE_KEY)\b/,
      );
      const nextPublicKeys = [
        ...text.matchAll(/\b(NEXT_PUBLIC_[A-Z0-9_]+)\s*:/g),
      ].map((m) => m[1]);
      for (const key of nextPublicKeys) {
        expect(
          [
            "NEXT_PUBLIC_SITE_URL",
            "NEXT_PUBLIC_INQUIRY_PHOTO_BUCKET",
            // 운영자 사이트 로그인 풀 값(스택 출력, 비밀값 아님, BRD-148)
            "NEXT_PUBLIC_OPERATOR_USER_POOL_ID",
            "NEXT_PUBLIC_OPERATOR_CLIENT_ID",
            "NEXT_PUBLIC_DEMO_USER_POOL_ID",
            "NEXT_PUBLIC_DEMO_CLIENT_ID",
          ],
          `${w.name}: ${key}`,
        ).toContain(key);
      }
    }
  });

  it("비밀값 검사(gitleaks) 잡은 contents: read 권한, 고정 해시 체크섬 검증, --redact 출력을 쓴다 (BRD-132)", () => {
    const gitleaks = jobLines(ci?.text ?? "", "gitleaks").join("\n");
    expect(gitleaks).toContain("contents: read");
    expect(gitleaks).toContain("--redact");
    expect(gitleaks).not.toMatch(/\bsecrets\./);
    // 다운로드 바이너리 체크섬 검증 단계와 기대 해시 고정 확인
    expect(gitleaks).toContain("sha256sum -c -");
    expect(gitleaks).toContain(
      "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    );
  });
});

describe("Project 스냅샷 워크플로: 비밀값 예외 범위", () => {
  const text = codeLines(projectSnapshot?.text ?? "").join("\n");

  it("예약·수동 실행만 받고 PR·push 이벤트로 돌지 않는다", () => {
    expect(projectSnapshot).toBeDefined();
    const on = text.slice(
      text.indexOf("\non:"),
      text.indexOf("\npermissions:"),
    );
    expect(on).toMatch(/schedule:/);
    expect(on).toMatch(/workflow_dispatch:/);
    expect(on).not.toMatch(
      /\b(pull_request|push|issue_comment|workflow_run|repository_dispatch)\b/,
    );
  });

  it("비밀값은 PROJECT_READ_TOKEN 하나를 한 번만 쓴다", () => {
    expect(text.match(/\bsecrets\.[A-Za-z0-9_]+/g)).toEqual([
      "secrets.PROJECT_READ_TOKEN",
    ]);
  });

  it("저장소 코드를 받지 않고 외부 Action도 쓰지 않는다", () => {
    expect(text).not.toMatch(/^\s*(?:-\s*)?uses:/m);
    expect(text).not.toMatch(/\bnpm\b|\bnode\b/);
  });

  it("기본 권한은 읽기, 쓰기는 project-snapshot 브랜치 push 하나뿐이다", () => {
    expect(text).toMatch(/^permissions:\n\s+contents: read$/m);
    expect(text.match(/contents: write/g)).toHaveLength(1);
    expect(text).not.toMatch(/id-token:|pull-requests: write|issues: write/);
    const pushes = text.match(/HEAD:refs\/heads\/\S+/g);
    expect(pushes).toEqual(["HEAD:refs/heads/project-snapshot"]);
  });

  it("항목이 비었거나 totalCount와 다르면 스냅샷을 바꾸지 않고 멈춘다", () => {
    expect(text).toContain(
      "(.items | length) > 0 and (.items | length) == .totalCount",
    );
  });
});
