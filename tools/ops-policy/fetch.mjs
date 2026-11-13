#!/usr/bin/env node
// 노션 '운영 정책 · 원본' 페이지를 저장소 파일로 가져오는 로컬 도구 (결정 기록 D20-8~11·D16-E5, #335)
// 사용:
//   NOTION_TOKEN=… node tools/ops-policy/fetch.mjs            노션 API로 받아 파일을 씀
//   node tools/ops-policy/fetch.mjs --markdown <파일> --revision <ISO 시각>
//                                                            노션 화면·MCP로 받은 Notion-flavored Markdown을 읽어 씀
//   --check                                                  파일을 쓰지 않고 검증만 함
// - revision은 노션 페이지의 마지막 수정 시각(last_edited_time). CI에는 노션 토큰을 두지 않음(D20-11)
//   → 사람이 이 도구로 파일을 만들고 PR로 반영함. 화면은 그 파일만 읽기 전용으로 보여 줌
// - 검증에 하나라도 실패하면 파일을 쓰지 않음(옛 파일과 옛 '가져온 시각'이 그대로 남아, 실패를 최신으로 보이지 않게 함)
// - 노션 쪽 모양(9개 항목·상태·근거 줄)이 바뀌면 조용히 빼지 않고 멈춤. 원본을 고치거나 이 도구를 고침
// - 토큰은 환경 변수로만 받고 파일·출력에 남기지 않음
// 종료 코드: 0 썼음(또는 --check 통과) / 1 실패(검증·네트워크·인자)
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PAGE_ID = "416587f5074781bf98a9eb9250941589";
export const PAGE_URL = `https://app.notion.com/p/${PAGE_ID}`;
export const PAGE_TITLE = "운영 정책 · 원본";
export const SECTION_COUNT = 9;
// 항목마다 3~6줄(D20-10)
export const MIN_ITEMS = 3;
export const MAX_ITEMS = 6;
export const STATUSES = ["확정", "초안"];
export const NOTION_VERSION = "2026-03-11";
export const SCHEMA = 1;

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const OUT_FILE = path.join(
  ROOT,
  "apps/admin/src/content/ops-policy.json",
);

export function parseArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(`--${name}`);
    const next = i >= 0 ? argv[i + 1] : undefined;
    return next !== undefined && !next.startsWith("--") ? next : undefined;
  };
  const markdown = value("markdown");
  const revision = value("revision");
  if (argv.includes("--markdown") && !markdown) {
    throw new Error("--markdown <파일>을 주세요");
  }
  if (markdown && !revision) {
    throw new Error(
      "--markdown을 쓸 때는 --revision <노션 페이지 마지막 수정 시각>을 함께 주세요",
    );
  }
  if (!markdown && argv.includes("--revision")) {
    throw new Error("--revision은 --markdown과 함께만 써요");
  }
  if (revision !== undefined) isoOrThrow(revision, "--revision");
  return { markdown, revision, check: argv.includes("--check") };
}

function isoOrThrow(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(
      `${label}는 UTC ISO 시각이어야 해요(예: 2026-11-12T04:50:04.046Z)`,
    );
  }
  return value;
}

// ── 글자 줄 해석 ──
// 한 줄 안의 꾸밈: <b>굵게</b>·**굵게**·<code>코드</code>, 회색 글자(<span color="gray">…</span>)는 꾸밈만 뺌
// - 노션 v2 마크다운은 인라인 코드를 <code>로 내보냄. 백틱 코드는 백슬래시 처리 규칙이 달라 같은 글이 다르게 저장되므로 멈춤
// - 회색 글자는 한 줄 안에서 여는·닫는 태그 짝이 맞아야 함
// 그 밖의 태그·링크는 모르는 모양이라 멈춤(조용히 글자만 남기지 않음)

const ESCAPES = /\\([\\`*_{}[\]()#+\-.!~<>|"'])/g;

function unescape(text) {
  return text.replace(ESCAPES, "$1");
}

export function parseInline(line) {
  const runs = [];
  const push = (text, mark) => {
    if (text === "") return;
    const value = unescape(text);
    const last = runs.at(-1);
    if (last && !last.bold && !last.code && !mark) {
      last.text += value;
    } else {
      runs.push(mark ? { text: value, [mark]: true } : { text: value });
    }
  };
  // 백슬래시로 막은 글자(\< 등)는 꾸밈으로 읽지 않게 먼저 잡음
  const pattern =
    /\\[\\`*_{}[\]()#+\-.!~<>|"']|<(b|code)>(.*?)<\/\1>|\*\*(.+?)\*\*|(`)|<span color="gray">|<\/span>|<[^>]*>|\[[^\]]*\]\([^)]*\)/g;
  let at = 0;
  let grayOpen = false;
  for (const match of line.matchAll(pattern)) {
    push(line.slice(at, match.index));
    at = match.index + match[0].length;
    if (match[0].startsWith("\\")) {
      push(match[0]);
    } else if (match[1]) {
      if (/<[^>]*>/.test(match[2])) {
        throw new Error(`꾸밈 안의 꾸밈은 읽지 못해요: ${line}`);
      }
      push(match[2], match[1] === "b" ? "bold" : "code");
    } else if (match[3] !== undefined) {
      push(match[3], "bold");
    } else if (match[4] !== undefined) {
      throw new Error(
        `백틱 코드는 읽지 못해요(노션은 <code>로 내보냄): ${line}`,
      );
    } else if (match[0] === '<span color="gray">') {
      if (grayOpen) throw new Error(`회색 글자 안의 회색 글자예요: ${line}`);
      grayOpen = true;
    } else if (match[0] === "</span>") {
      if (!grayOpen) throw new Error(`짝 없는 </span>이 있어요: ${line}`);
      grayOpen = false;
    } else {
      throw new Error(`모르는 꾸밈·링크가 있어요: ${match[0]}`);
    }
  }
  push(line.slice(at));
  if (grayOpen)
    throw new Error(`회색 글자가 줄 안에서 닫히지 않았어요: ${line}`);
  return runs;
}

export const plain = (runs) => runs.map((r) => r.text).join("");

// ── 페이지 해석 ──
// 모양: '## n. 제목' → 상태 한 줄(<b>확정</b>) → '- ' 목록 3~6줄 → '근거: …' 한 줄
// 첫 '## ' 앞(머리 설명·쓰는 법)은 원문 안내라 가져오지 않음

export function parsePolicyMarkdown(markdown) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  let current = null;
  let inCallout = false;
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    const where = `${index + 1}번째 줄`;
    if (inCallout) {
      if (line === "</callout>") inCallout = false;
      continue;
    }
    if (line.startsWith("<callout")) {
      if (current)
        throw new Error(`${where}: 항목 안의 강조 상자는 읽지 못해요`);
      inCallout = !line.endsWith("</callout>");
      continue;
    }
    if (line === "" || line === "---") continue;
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading) {
      const m = /^(\d+)\.\s+(.+)$/.exec(plain(parseInline(heading[1])).trim());
      if (!m)
        throw new Error(`${where}: 항목 제목은 'n. 제목' 모양이어야 해요`);
      current = {
        number: Number(m[1]),
        title: m[2].trim(),
        status: null,
        items: [],
        basis: null,
      };
      sections.push(current);
      continue;
    }
    if (!current) continue; // 머리 설명
    if (/^#/.test(line))
      throw new Error(`${where}: 항목 안의 작은 제목은 읽지 못해요`);
    // 노션 마크다운은 하위 목록을 탭 한 칸으로 들여씀. 공백·탭 하나라도 있으면 안쪽 목록으로 봄
    if (/^\s+[-*]\s/.test(raw)) {
      throw new Error(`${where}: 안쪽 목록은 읽지 못해요`);
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const runs = parseInline(bullet ? bullet[1] : line);
    const text = plain(runs).trim();
    if (bullet) {
      if (current.basis !== null) {
        throw new Error(
          `${where}: 근거 줄 뒤에 목록이 있어요(${current.number}번)`,
        );
      }
      current.items.push(runs);
    } else if (
      STATUSES.includes(text) &&
      current.status === null &&
      current.items.length === 0
    ) {
      current.status = text;
    } else if (text.startsWith("근거:") && current.basis === null) {
      current.basis = text.slice("근거:".length).trim();
    } else {
      throw new Error(
        `${where}: ${current.number}번 항목에 모르는 줄이 있어요: ${text}`,
      );
    }
  }
  if (inCallout) throw new Error("강조 상자가 닫히지 않았어요");
  return sections;
}

// 화면이 믿고 쓸 수 있는지 확인. 하나라도 틀리면 멈춤
export function validateSections(sections) {
  const problems = [];
  if (sections.length !== SECTION_COUNT) {
    problems.push(
      `항목이 ${SECTION_COUNT}개가 아니라 ${sections.length}개예요`,
    );
  }
  sections.forEach((s, i) => {
    const label = `${s.number}번 '${s.title}'`;
    if (s.number !== i + 1)
      problems.push(`${label}: 번호가 ${i + 1}이어야 해요`);
    if (!s.status) problems.push(`${label}: 확정·초안 표시가 없어요`);
    if (s.items.length < MIN_ITEMS || s.items.length > MAX_ITEMS) {
      problems.push(
        `${label}: 줄이 ${MIN_ITEMS}~${MAX_ITEMS}개가 아니라 ${s.items.length}개예요`,
      );
    }
    if (s.items.some((runs) => plain(runs).trim() === "")) {
      problems.push(`${label}: 빈 줄이 있어요`);
    }
    if (!s.basis) problems.push(`${label}: 근거 줄이 없어요`);
  });
  if (problems.length > 0) {
    throw new Error(`운영 정책 원본 검증 실패\n- ${problems.join("\n- ")}`);
  }
  return sections;
}

export function buildSnapshot({ markdown, revision, fetchedAt }) {
  isoOrThrow(revision, "revision");
  isoOrThrow(fetchedAt, "가져온 시각");
  if (Date.parse(revision) > Date.parse(fetchedAt)) {
    throw new Error("revision이 가져온 시각보다 늦어요");
  }
  const sections = validateSections(parsePolicyMarkdown(markdown));
  return {
    schema: SCHEMA,
    source: { title: PAGE_TITLE, url: PAGE_URL },
    revision,
    fetchedAt,
    sections,
  };
}

// ── 노션 API ──
// 페이지 정보(마지막 수정 시각) → 본문(Notion-flavored Markdown) → 페이지 정보 다시
// 가져오는 사이 고쳐졌으면 revision과 본문이 어긋나므로 멈춤

async function notion(fetchImpl, token, url) {
  const response = await fetchImpl(`https://api.notion.com/v1/${url}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`노션 응답 ${response.status} (${url.split("?")[0]})`);
  }
  return response.json();
}

export async function fetchFromNotion({ token, fetchImpl = fetch }) {
  if (!token)
    throw new Error("NOTION_TOKEN 환경 변수를 주세요(읽기 권한만 있는 연결)");
  const before = await notion(fetchImpl, token, `pages/${PAGE_ID}`);
  const body = await notion(
    fetchImpl,
    token,
    `pages/${PAGE_ID}/markdown?markdown_version=v2`,
  );
  const after = await notion(fetchImpl, token, `pages/${PAGE_ID}`);
  if (body.truncated || (body.unknown_block_ids ?? []).length > 0) {
    throw new Error("노션 본문이 잘렸거나 읽지 못한 블록이 있어요");
  }
  if (typeof body.markdown !== "string")
    throw new Error("노션 본문 모양이 달라요");
  if (before.last_edited_time !== after.last_edited_time) {
    throw new Error(
      "가져오는 사이 노션 페이지가 바뀌었어요. 다시 실행해 주세요",
    );
  }
  return {
    markdown: body.markdown,
    revision: isoOrThrow(before.last_edited_time, "last_edited_time"),
  };
}

// 임시 파일에 다 쓴 뒤 바꿔 넣음(쓰다 멈춰도 옛 파일이 그대로 남음, D16-E5)
// 실패하면 임시 파일을 지워 다음 PR에 .tmp가 섞이지 않게 함
export function writeAtomic(file, text) {
  const temp = `${file}.tmp`;
  try {
    writeFileSync(temp, text);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export async function main(argv, env = process.env, deps = {}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const write = deps.write ?? writeAtomic;
  const outFile = deps.outFile ?? OUT_FILE;
  const log = deps.log ?? console.log;
  const args = parseArgs(argv);
  const source = args.markdown
    ? { markdown: readFileSync(args.markdown, "utf8"), revision: args.revision }
    : await fetchFromNotion({
        token: env.NOTION_TOKEN,
        fetchImpl: deps.fetchImpl,
      });
  const snapshot = buildSnapshot({ ...source, fetchedAt: now() });
  if (args.check) {
    log(
      `검증 통과: ${snapshot.sections.length}개 항목, revision ${snapshot.revision}`,
    );
    return snapshot;
  }
  write(outFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  log(
    `썼어요: ${path.relative(ROOT, outFile)} (revision ${snapshot.revision})`,
  );
  return snapshot;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
