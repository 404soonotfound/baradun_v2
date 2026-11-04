// BRD-174 Codex 대체 리뷰: agy(Gemini)로 고정한 head 사본을 읽기 전용 리뷰하고 결과를 검증함
// 실행: node tools/agy-review/review.mjs --model <gemini-…> [--base <ref>] [--head <ref>] [--evidence <노션 근거 파일>]…
//       [--previous <이전 기록.json> [--handling <지적 처리 내용 파일>]] [--reason <대체 사유>] [--timeout <초>] [--out <폴더>]
// 종료 코드: 리뷰 완료 0, 리뷰 미완료 1, 사용법·준비 오류 2
// 저장소 밖(기본 OS 임시 폴더)에만 씀. Codex 샌드박스에서는 네트워크·~/.gemini 기록 때문에 샌드박스 밖 실행 승인이 필요함
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PROBE_PROMPT, buildReviewPrompt, summaryMarkdown } from "./prompt.mjs";
import {
  createValidator,
  decideScope,
  sensitiveOf,
  verifyProbe,
  verifyReview,
} from "./verify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
// agy는 입력이 약 73k 토큰을 넘으면 뒷부분을 알리지 않고 자름(2026-11-04 실측: 150KB 통과, 200KB부터 잘림).
// 크기로 먼저 거르고, 잘림 자체는 끝 표지(end_marker)로 확인함
const MAX_PROMPT_BYTES = 150_000;

// 거부 규칙은 공유 허용 목록보다 우선함(2026-11-04 실증). --mode는 쓰지 않음(plan은 계획 문서를 쓰고 auto는 실행함)
export const REVIEW_SETTINGS = {
  permissions: {
    deny: [
      "write_file(*)",
      "command(*)",
      "execute_url(*)",
      "read_url(*)",
      "mcp(*)",
    ],
  },
  toolPermission: "request-review",
  enableTerminalSandbox: true,
  allowNonWorkspaceAccess: false,
};

class UsageError extends Error {}

// allowTimeout: 제한 시간 초과(ETIMEDOUT)는 던지지 않고 결과로 돌려줌(리뷰 미완료로 기록하려고)
function run(cmd, args, { allowTimeout = false, ...opts } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
  if (r.error && !(allowTimeout && r.error.code === "ETIMEDOUT"))
    throw new UsageError(`${cmd} 실행 실패: ${r.error.message}`);
  return r;
}

function git(...args) {
  const r = run("git", args);
  if (r.status !== 0)
    throw new UsageError(`git ${args.join(" ")} 실패: ${r.stderr.trim()}`);
  return r.stdout;
}

const sha = (ref) => git("rev-parse", "--verify", `${ref}^{commit}`).trim();

// --evidence·--handling·--previous는 파일 경로. 없으면 알아볼 수 있는 사용법 오류로 멈춤
function readInput(path, label) {
  if (!existsSync(path))
    throw new UsageError(`${label} 파일을 찾을 수 없음: ${path}`);
  return readFileSync(path, "utf8");
}
const names = (from, to) =>
  git("diff", "--name-only", "--no-renames", from, to)
    .split("\n")
    .filter(Boolean);

// 사본 전체 내용 해시: 거부 시험·리뷰 뒤 바뀐 파일이 없는지 확인용
function treeHash(dir) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        h.update(relative(dir, p));
        h.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest("hex");
}

// 프롬프트는 stdin으로 넘김: 인자 하나로 넘기면 Linux에서 128KiB를 넘을 때 E2BIG로 실패함
// (-p 없이 stdin이 파이프면 agy가 한 턴만 실행하는 print 모드로 돎, agy 1.4.12에서 거부 설정 적용 확인)
function agy(prompt, { model, cwd, settingsPath, timeout, schemaPath }) {
  const args = [
    "--model",
    model,
    "--disable-slash-commands",
    "--settings",
    settingsPath,
  ];
  args.push("--output-format", "stream-json", "--print-timeout", `${timeout}s`);
  if (schemaPath) args.push("--json-schema", schemaPath);
  // print-timeout이 듣지 않을 때를 대비한 바깥 제한
  const r = run("agy", args, {
    cwd,
    input: prompt,
    timeout: (timeout + 60) * 1000,
    allowTimeout: true,
  });
  return {
    exitCode: r.status ?? -1,
    signal: r.signal,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: "string" },
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      evidence: { type: "string", multiple: true, default: [] },
      previous: { type: "string" },
      handling: { type: "string" },
      reason: { type: "string", default: "" },
      timeout: { type: "string", default: "900" },
      out: { type: "string" },
    },
  });
  if (!values.model)
    throw new UsageError(
      "--model이 필요함(agy models에서 gemini- 모델을 골라 명시)",
    );
  if (!values.model.startsWith("gemini-"))
    throw new UsageError(`Gemini 모델만 씀: ${values.model}`);
  const timeout = Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 60)
    throw new UsageError("--timeout은 60 이상 정수(초)");
  if (values.handling && !values.previous)
    throw new UsageError("--handling은 --previous와 함께 씀");
  return { ...values, timeout };
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseCli(argv);
  const log = (m) => console.error(`[agy-review] ${m}`);

  // 1) 미리 확인: SHA 고정, 모델 목록. HEAD를 리뷰할 때는 커밋하지 않은 변경이 빠지지 않도록 깨끗한 작업 트리 요구
  if (opts.head === "HEAD" && git("status", "--porcelain").trim())
    throw new UsageError(
      "커밋하지 않은 변경이 있음. 리뷰할 상태를 커밋한 뒤 실행(또는 --head로 커밋 지정)",
    );
  const headSha = sha(opts.head);
  const baseSha = git(
    "merge-base",
    opts.base ? sha(opts.base) : sha("origin/main"),
    headSha,
  ).trim();
  if (baseSha === headSha)
    throw new UsageError("base와 head가 같아 리뷰할 변경이 없음");
  const PREFLIGHT = { timeout: 60_000 }; // 미리 확인이 멈춰 있지 않도록
  const agyVersion = run("agy", ["--version"], PREFLIGHT).stdout.trim();
  const models = run("agy", ["models"], PREFLIGHT)
    .stdout.split("\n")
    .map((l) => l.split("\t")[0].trim());
  if (!models.includes(opts.model))
    throw new UsageError(`agy models 목록에 없음: ${opts.model}`);
  // 한도를 쓰지 않는 조회. 혹시 모델 턴이 시작돼도 거부 설정으로 저장소 밖(OS 임시 폴더)에서만 돌게 함
  const quota = run(
    "agy",
    ["-p", "/quota", "--settings", JSON.stringify(REVIEW_SETTINGS)],
    { ...PREFLIGHT, cwd: tmpdir() },
  ).stdout.trim();

  // 2) 추가 리뷰 범위
  const previous = opts.previous
    ? JSON.parse(readInput(opts.previous, "--previous 기록"))
    : null;
  let prevHeadIsAncestor = false;
  let mergeCommits = 0;
  if (previous) {
    if (previous.headSha === headSha)
      throw new UsageError(
        "이전 기록과 head가 같아 추가 리뷰할 변경이 없음(--previous 없이 다시 실행)",
      );
    prevHeadIsAncestor =
      run("git", ["merge-base", "--is-ancestor", previous.headSha, headSha])
        .status === 0;
    if (prevHeadIsAncestor)
      mergeCommits = git(
        "rev-list",
        "--merges",
        `${previous.headSha}..${headSha}`,
      )
        .split("\n")
        .filter(Boolean).length;
  }
  const { scope, reasons: scopeReasons } = decideScope({
    previous,
    baseSha,
    prevHeadIsAncestor,
    mergeCommits,
  });

  const diffFiles = names(baseSha, headSha);
  const requiredFiles =
    scope === "incremental" ? names(previous.headSha, headSha) : diffFiles;
  const { prefixes: sensitivePrefixes } = JSON.parse(
    readFileSync(join(HERE, "sensitive-paths.json"), "utf8"),
  );
  const sensitiveChanged = sensitiveOf(diffFiles, sensitivePrefixes);
  const evidence = opts.evidence.map((p) => {
    const text = readInput(p, "--evidence 노션 근거");
    if (!text.trim()) throw new UsageError(`노션 근거 파일이 비어 있음: ${p}`);
    return {
      name: p.split("/").pop(),
      text,
      sha256: createHash("sha256").update(text).digest("hex"),
    };
  });

  // 3) 고정 head 사본(git archive, .git 없음, worktree 쓰지 않음)과 기록 폴더
  const outDir = opts.out ?? join(tmpdir(), "agy-review", headSha.slice(0, 12));
  mkdirSync(outDir, { recursive: true });
  const snapshot = realpathSync(
    mkdtempSync(join(tmpdir(), `agy-review-snap-${headSha.slice(0, 12)}-`)),
  );

  try {
    const tarPath = join(outDir, "head.tar");
    git("archive", "--format=tar", "-o", tarPath, headSha);
    if (run("tar", ["-xf", tarPath, "-C", snapshot]).status !== 0)
      throw new UsageError("사본 풀기 실패");
    rmSync(tarPath);
    const settingsPath = join(outDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify(REVIEW_SETTINGS, null, 2));
    // 스키마는 기록 폴더로 복사하고 검사기도 지금 만듦: 리뷰 도중 작업 폴더 checkout이 바뀌어도 그대로 씀
    const schemaPath = join(outDir, "schema.json");
    writeFileSync(schemaPath, readFileSync(join(HERE, "schema.json")));
    const validate = createValidator(schemaPath);
    const expectedBase = { model: opts.model, cwd: snapshot };
    // agy가 함께 설치한 내장 안내 문서 폴더: 여기 읽기만 사본 밖이어도 참고로 남김
    const agyBuiltinDir = join(homedir(), ".gemini/antigravity-cli/builtin");

    // 4) 리뷰 프롬프트: 크기 초과는 거부 시험(한도 사용) 전에 멈춤
    const guidelines = readFileSync(join(snapshot, "AGENTS.md"), "utf8").split(
      "## Review guidelines",
    )[1];
    if (!guidelines)
      throw new UsageError("사본 AGENTS.md에 Review guidelines 절이 없음");
    const endMarker = randomBytes(8).toString("hex");
    const prompt = buildReviewPrompt({
      baseSha,
      headSha,
      scope,
      guidelines: `## Review guidelines${guidelines}`,
      diffStat: git("diff", "--stat", "--no-renames", baseSha, headSha),
      diff: git("diff", "-U20", "--no-renames", baseSha, headSha),
      evidence,
      previous: previous && {
        headSha: previous.headSha,
        findings: previous.verdict?.review?.findings ?? [],
        handling: opts.handling
          ? readInput(opts.handling, "--handling 지적 처리 내용")
          : "",
      },
      incrementalDiff:
        scope === "incremental"
          ? git("diff", "-U20", "--no-renames", previous.headSha, headSha)
          : "",
      sensitiveChanged,
      endMarker,
    });
    if (Buffer.byteLength(prompt) > MAX_PROMPT_BYTES)
      throw new UsageError(
        `프롬프트가 ${Buffer.byteLength(prompt)}바이트로 한도 ${MAX_PROMPT_BYTES}바이트를 넘음(agy가 뒷부분을 자름). 리뷰 범위를 나눠 실행`,
      );
    writeFileSync(join(outDir, "prompt.txt"), prompt);

    // 5) 거부 시험: 통과하지 못하면 리뷰를 시작하지 않음
    log(`거부 시험 (${opts.model}, 사본 ${snapshot})`);
    const before = treeHash(snapshot);
    const p = agy(PROBE_PROMPT, {
      model: opts.model,
      cwd: snapshot,
      settingsPath,
      timeout: 120,
    });
    writeFileSync(join(outDir, "probe.jsonl"), p.stdout);
    writeFileSync(join(outDir, "probe.stderr.txt"), p.stderr);
    const afterProbe = treeHash(snapshot);
    const probe = verifyProbe({
      exitCode: p.exitCode,
      text: p.stdout,
      expected: expectedBase,
      snapshotUnchanged: afterProbe === before,
    });

    let verdict = {
      complete: false,
      reasons: ["거부 시험 실패로 리뷰를 시작하지 않음", ...probe.reasons],
      notes: [],
      review: null,
      notion: { status: "미완료", sensitiveChanged },
      limits: [],
      toolLog: [],
      usage: null,
    };
    let stderr = "";
    if (probe.ok) {
      // 6) 리뷰
      log(
        `리뷰 시작 (${scope}, ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)}, 제한 ${opts.timeout}초)`,
      );
      const r = agy(prompt, {
        model: opts.model,
        cwd: snapshot,
        settingsPath,
        timeout: opts.timeout,
        schemaPath,
      });
      writeFileSync(join(outDir, "review.jsonl"), r.stdout);
      writeFileSync(join(outDir, "review.stderr.txt"), r.stderr);
      stderr = r.stderr;
      verdict = verifyReview({
        exitCode: r.exitCode,
        text: r.stdout,
        validate,
        expected: {
          ...expectedBase,
          baseSha,
          headSha,
          scope,
          requiredFiles,
          diffFiles,
          sensitivePrefixes,
          evidenceCount: evidence.length,
          endMarker,
          agyBuiltinDir,
        },
      });
      if (r.signal)
        verdict.reasons.push(`바깥 제한 시간으로 중단됨(${r.signal})`);
      if (treeHash(snapshot) !== afterProbe)
        verdict.reasons.push("리뷰 뒤 사본 내용이 바뀜");
      verdict.complete = verdict.reasons.length === 0;
    }

    // 6) 기록
    const record = {
      tool: "agy-review",
      issue: "BRD-174",
      createdAt: new Date().toISOString(),
      reason: opts.reason,
      agyVersion,
      model: opts.model,
      quotaBefore: quota,
      baseSha,
      headSha,
      scope,
      scopeReasons,
      previous: opts.previous ?? null,
      changedFiles: diffFiles,
      requiredFiles,
      evidence: evidence.map(({ name, sha256 }) => ({ name, sha256 })),
      settings: REVIEW_SETTINGS,
      probe,
      verdict,
      notion: verdict.notion,
      stderrPreview: stderr.slice(0, 2000),
    };
    const base = join(outDir, `agy-review-${headSha.slice(0, 12)}`);
    writeFileSync(`${base}.json`, `${JSON.stringify(record, null, 2)}\n`);
    const md = summaryMarkdown(record);
    writeFileSync(`${base}.md`, `${md}\n`);
    console.log(md);
    log(`기록: ${base}.json`);
    return verdict.complete ? 0 : 1;
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main();
  } catch (e) {
    console.error(
      `[agy-review] ${e instanceof UsageError ? "" : "예상하지 못한 오류: "}${e.message}`,
    );
    process.exitCode = 2;
  }
}
