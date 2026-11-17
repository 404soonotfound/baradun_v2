#!/usr/bin/env node
// 커밋 메시지·바뀐 화면 문구·바뀐 문서를 한국어 문체 규칙(rules.mjs)으로 검사 (GH-546)
// 사용:
//   node tools/copy-lint/lint.mjs --commit-msg <파일>   git commit-msg 훅: 메시지 + 스테이징된 변경 줄
//   node tools/copy-lint/lint.mjs --range <base> <head> CI: base..head 커밋 메시지 + base...head 변경 줄
// - 검사 대상 줄: apps/web·apps/admin messages/ko.json의 추가·수정된 문자열 값, 추가·수정된 *.md 줄(코드 블록·인라인 코드 제외),
//   messages/en.json 값은 공지 금지 표현(영어)만 봄. 운영자 사이트 문구는 따옴표 안 금지 표현을 예시 인용으로 보고 막지 않음
// - 건너뛰기: 커밋 메시지에 [skip-copy-lint]. --range에서는 그 커밋의 메시지와 그 커밋이 마지막으로 바꾼 줄만 건너뜀(git blame)
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
export const COPY_EN_FILES = [
  "apps/web/messages/en.json",
  "apps/admin/messages/en.json",
];
const QUOTED_EXAMPLES_OK = (file) => file.startsWith("apps/admin/");
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

// 메시지 끝 트레일러 블록(빈 줄 뒤 'Key: value' 줄만 이어짐)의 시작 줄 번호(0부터). 없으면 줄 수
export function trailerStart(lines) {
  let i = lines.length;
  while (i > 0 && /^[A-Za-z][A-Za-z0-9-]*: \S/u.test(lines[i - 1])) i--;
  // 제목 줄 하나뿐이거나 바로 앞이 빈 줄이 아니면 트레일러로 보지 않음
  return i < lines.length && i > 1 && lines[i - 1].trim() === ""
    ? i
    : lines.length;
}

export function checkMessage(message, label) {
  const findings = [];
  const lines = message.split("\n");
  const end = trailerStart(lines);
  lines.forEach((line, i) => {
    // Co-Authored-By 같은 끝 트레일러만 검사하지 않음(본문 'Note: …' 줄은 검사)
    if (i >= end) return;
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

// skipLine(file, n): 건너뛸 줄([skip-copy-lint] 커밋이 넣은 줄)
export function checkChangedFiles(added, readFile, skipLine = () => false) {
  const findings = [];
  for (const [file, lines] of added) {
    const isCopy = COPY_FILES.includes(file);
    const isCopyEn = COPY_EN_FILES.includes(file);
    const isDoc =
      file.endsWith(".md") && !DOC_EXCLUDE.some((r) => r.test(file));
    if ((!isCopy && !isCopyEn && !isDoc) || lines.size === 0) continue;
    const kind = isCopy ? "copy" : isCopyEn ? "copy-en" : "doc";
    const content = readFile(file);
    const rows = content.split("\n");
    const docs = isDoc ? docLines(content) : null;
    for (const n of [...lines].sort((a, b) => a - b)) {
      if (skipLine(file, n)) continue;
      const text = isDoc ? docs.get(n) : jsonLineValue(rows[n - 1] ?? "");
      if (!text) continue;
      const opts = { quotedExamples: QUOTED_EXAMPLES_OK(file) };
      for (const hit of checkText(text, kind, opts))
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
    ...COPY_EN_FILES,
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
  const skipCommits = new Set();
  for (const entry of log.split("\x1e")) {
    const [sha, author, body] = entry.replace(/^\n/u, "").split("\x00");
    if (!sha) continue;
    const message = (body ?? "").trim();
    if (message.includes(SKIP_MARKER)) skipCommits.add(sha);
    if (shouldSkipMessage(message, author)) continue;
    findings.push(...checkMessage(message, `커밋 ${sha.slice(0, 8)}`));
  }
  const diff = git(diffArgs(`${base}...${head}`), cwd);
  const blames = new Map();
  const skipLine = (file, n) => {
    if (skipCommits.size === 0) return false;
    if (!blames.has(file)) blames.set(file, blameLines(head, file, cwd));
    return skipCommits.has(blames.get(file).get(n));
  };
  findings.push(
    ...checkChangedFiles(
      parseAddedLines(diff),
      (f) => git(["show", `${head}:${f}`], cwd),
      skipLine,
    ),
  );
  return findings;
}

// head 기준 각 줄을 마지막으로 바꾼 커밋 → Map(줄 번호 → 커밋 SHA)
export function parseBlame(porcelain) {
  const out = new Map();
  for (const l of porcelain.split("\n")) {
    const m = /^([0-9a-f]{40}) \d+ (\d+)/u.exec(l);
    if (m) out.set(Number(m[2]), m[1]);
  }
  return out;
}

function blameLines(head, file, cwd) {
  return parseBlame(git(["blame", "--porcelain", head, "--", file], cwd));
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
