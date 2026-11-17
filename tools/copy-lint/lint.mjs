#!/usr/bin/env node
// 커밋 메시지·바뀐 화면 문구·바뀐 문서를 한국어 문체 규칙(rules.mjs)으로 검사 (GH-546)
// 사용:
//   node tools/copy-lint/lint.mjs --commit-msg <파일>   git commit-msg 훅: 메시지 + 스테이징된 변경 줄
//   node tools/copy-lint/lint.mjs --range <base> <head> CI: base..head 커밋 메시지 + base...head 변경 줄
// - 검사 대상 줄: apps/web·apps/admin messages/ko.json의 추가·수정된 문자열 값, 추가·수정된 *.md 줄(코드 블록·인라인 코드 제외)
// - 건너뛰기: 커밋 메시지에 [skip-copy-lint]. --range에서는 그 커밋 메시지만, 그리고 범위 안 한 커밋이라도 있으면 변경 줄 검사도 건너뜀
// - Merge·Revert·fixup!·squash! 커밋과 Dependabot 커밋 메시지는 검사하지 않음(영어 자동 제목)
// 종료 코드: 0 통과 / 1 규칙에 걸림 / 2 사용법·git 오류(CI는 실패로 봄)
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { checkText } from "./rules.mjs";

export const SKIP_MARKER = "[skip-copy-lint]";
const AUTO_SKIP_PREFIXES = ["Merge ", "Revert ", "fixup!", "squash!"];
export const COPY_FILES = [
  "apps/web/messages/ko.json",
  "apps/admin/messages/ko.json",
];
// 다른 저작물 라이선스 문서는 손대지 않으므로 뺌
const DOC_EXCLUDE = [/(^|\/)LICENSE[^/]*\.md$/u, /(^|\/)node_modules\//u];

class UsageError extends Error {}

function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    throw new UsageError(
      `git ${args.join(" ")} 실패: ${e.stderr?.toString().trim() || e.message}`,
    );
  }
}

// git이 편집기에 넣는 주석 줄과 가위 줄(--verbose) 아래를 뺌
export function cleanMessage(raw) {
  const cut = raw.split(/^# -+ >8 -+$/mu)[0];
  return cut
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();
}

export function shouldSkipMessage(message, author = "") {
  if (message.includes(SKIP_MARKER)) return true;
  if (/dependabot/iu.test(author)) return true;
  const first = message.split("\n")[0] ?? "";
  return AUTO_SKIP_PREFIXES.some((p) => first.startsWith(p));
}

export function checkMessage(message, label) {
  const findings = [];
  message.split("\n").forEach((line, i) => {
    // Co-Authored-By 같은 트레일러는 검사하지 않음
    if (/^[A-Za-z-]+: /u.test(line)) return;
    for (const hit of checkText(line, "commit"))
      findings.push({ where: `${label}:${i + 1}`, text: line, ...hit });
  });
  return findings;
}

// git diff -U0 출력 → { 파일: Set(추가·수정된 새 줄 번호) }
// 파일 머리(diff --git ~ 첫 @@)에서만 '+++ '를 경로로 읽음: 내용 줄이 '++ '로 시작해도 머리로 오인하지 않게 함
export function parseAddedLines(diff) {
  const out = new Map();
  let file = null;
  let inHeader = false;
  let line = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) {
      inHeader = true;
      file = null;
      continue;
    }
    if (inHeader) {
      if (l.startsWith("+++ ")) {
        file = l === "+++ /dev/null" ? null : headerPath(l.slice(4));
        if (file && !out.has(file)) out.set(file, new Set());
        continue;
      }
      if (!l.startsWith("@@")) continue;
      inHeader = false;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(l);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (!file) continue;
    if (l.startsWith("+")) out.get(file).add(line++);
    else if (!l.startsWith("-") && !l.startsWith("\\")) line++;
  }
  return out;
}

// '+++ b/경로' 또는 따옴표로 감싼 '"b/경로"'(탭·따옴표 같은 특수 문자)에서 경로만 꺼냄
function headerPath(raw) {
  let p = raw;
  if (p.startsWith('"')) {
    try {
      p = JSON.parse(p);
    } catch {
      throw new UsageError(`diff 경로를 읽지 못함: ${raw}`);
    }
  }
  return p.startsWith("b/") ? p.slice(2) : p;
}

// ko.json 한 줄의 문자열 값("키": "값" 또는 배열 안 "값")
export function jsonLineValue(line) {
  const m =
    /^\s*"(?:[^"\\]|\\.)*"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/u.exec(line) ??
    /^\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/u.exec(line);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
}

// 문서 줄 번호 → 검사할 글(코드 블록 안이면 null, 인라인 코드·링크 주소는 지움)
export function docLines(content) {
  const out = new Map();
  let fence = null;
  content.split("\n").forEach((raw, i) => {
    const f = /^\s*(`{3,}|~{3,})/u.exec(raw);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      out.set(i + 1, null);
      return;
    }
    if (fence) return out.set(i + 1, null);
    out.set(i + 1, raw.replace(/`[^`]*`/gu, "").replace(/\]\([^)]*\)/gu, "]"));
  });
  return out;
}

export function checkChangedFiles(added, readFile) {
  const findings = [];
  for (const [file, lines] of added) {
    const isCopy = COPY_FILES.includes(file);
    const isDoc =
      file.endsWith(".md") && !DOC_EXCLUDE.some((r) => r.test(file));
    if ((!isCopy && !isDoc) || lines.size === 0) continue;
    const content = readFile(file);
    const rows = content.split("\n");
    const docs = isDoc ? docLines(content) : null;
    for (const n of [...lines].sort((a, b) => a - b)) {
      const text = isCopy ? jsonLineValue(rows[n - 1] ?? "") : docs.get(n);
      if (!text) continue;
      for (const hit of checkText(text, isCopy ? "copy" : "doc"))
        findings.push({ where: `${file}:${n}`, text: text.trim(), ...hit });
    }
  }
  return findings;
}

// 사용자 git 설정(diff.noprefix·mnemonicPrefix·core.quotePath·외부 diff)과 상관없이 같은 모양으로 받음
function diffArgs(...range) {
  return [
    "-c",
    "core.quotePath=false",
    "diff",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "-U0",
    "--no-color",
    "--no-ext-diff",
    ...range,
    "--",
    ...COPY_FILES,
    "*.md",
  ];
}

export function runCommitMsg(msgFile, cwd) {
  const message = cleanMessage(readFileSync(msgFile, "utf8"));
  if (shouldSkipMessage(message)) return [];
  const diff = git(diffArgs("--cached"), cwd);
  return [
    ...checkMessage(message, "커밋 메시지"),
    ...checkChangedFiles(parseAddedLines(diff), (f) =>
      git(["show", `:${f}`], cwd),
    ),
  ];
}

export function runRange(base, head, cwd) {
  const log = git(
    ["log", "--format=%H%x00%an%x00%B%x1e", `${base}..${head}`],
    cwd,
  );
  const findings = [];
  let skipFiles = false;
  for (const entry of log.split("\x1e")) {
    const [sha, author, body] = entry.replace(/^\n/u, "").split("\x00");
    if (!sha) continue;
    const message = (body ?? "").trim();
    if (message.includes(SKIP_MARKER)) skipFiles = true;
    if (shouldSkipMessage(message, author)) continue;
    findings.push(...checkMessage(message, `커밋 ${sha.slice(0, 8)}`));
  }
  if (!skipFiles) {
    const diff = git(diffArgs(`${base}...${head}`), cwd);
    findings.push(
      ...checkChangedFiles(parseAddedLines(diff), (f) =>
        git(["show", `${head}:${f}`], cwd),
      ),
    );
  }
  return findings;
}

export function format(findings) {
  const lines = [
    `한국어 문체 규칙에 걸린 곳이 ${findings.length}건 있어요. 아래 위치를 고쳐 주세요.`,
    "",
  ];
  for (const f of findings) {
    lines.push(`- ${f.where} [${f.id} ${f.name}] '${f.matched}'`);
    lines.push(`    ${f.text.slice(0, 120)}`);
    lines.push(`    → ${f.hint}`);
  }
  lines.push(
    "",
    `규칙 출처: im-not-ai(MIT, tools/copy-lint/LICENSE-im-not-ai)·공지 금지 표현(D17-8).`,
    `꼭 필요한 예외면 커밋 메시지에 ${SKIP_MARKER}를 넣고 PR 설명에 이유를 적어요.`,
  );
  return lines.join("\n");
}

function main(argv) {
  const cwd = process.cwd();
  let findings;
  if (argv[0] === "--commit-msg" && argv[1])
    findings = runCommitMsg(argv[1], cwd);
  else if (argv[0] === "--range" && argv[1] && argv[2])
    findings = runRange(argv[1], argv[2], cwd);
  else
    throw new UsageError(
      "사용법: lint.mjs --commit-msg <파일> | --range <base> <head>",
    );
  if (findings.length === 0) return 0;
  console.error(format(findings));
  return 1;
}

// 경로에 공백·한글·심볼릭 링크가 있어도 직접 실행을 알아보게 실제 경로의 URL로 비교함(못 알아보면 검사 없이 통과해 버림)
const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(realpathSync(process.argv[1])).href ===
    pathToFileURL(realpathSync(new URL(import.meta.url))).href;

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(
      `[copy-lint] ${e instanceof UsageError ? "" : "예상하지 못한 오류: "}${e.message}`,
    );
    process.exitCode = 2;
  }
}
