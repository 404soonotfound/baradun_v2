// 커밋 훅·CI 범위 검사 회귀 검사: 임시 git 저장소에서 실제 git으로 확인 (GH-546)
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanMessage,
  docLines,
  jsonLineValue,
  parseAddedLines,
  runCommitMsg,
  runRange,
  shouldSkipMessage,
  checkMessage,
  parseBlame,
} from "../lint.mjs";

let dir: string;
// 실행 환경의 GIT_AUTHOR_* 등이 작성자를 덮어쓰지 않게 시험용 환경을 따로 씀
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
);
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
const write = (file: string, content: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
};
const commit = (message: string, author = "tester") => {
  git("add", "-A");
  git(
    "-c",
    `user.name=${author}`,
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    message,
  );
  return git("rev-parse", "HEAD");
};
const msg = (text: string) => {
  const f = path.join(dir, "MSG");
  writeFileSync(f, text);
  return f;
};
const ids = (findings: { id: string }[]) => findings.map((f) => f.id);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "copy-lint-"));
  git("init", "-q", "-b", "main");
  write(
    "apps/web/messages/ko.json",
    '{\n  "a": "그대로 둔 문구, 예전 것"\n}\n',
  );
  write("README.md", "# 제목\n\n예전에 쓰고, 그대로 둔 줄\n");
  commit("GH-1 chore: 시작");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("도우미", () => {
  it("주석 줄과 가위 줄 아래를 뺌", () => {
    expect(
      cleanMessage(
        "제목\n# 주석\n# ------------------------ >8 ------------------------\n수행함",
      ),
    ).toBe("제목");
  });

  it("건너뛰기: 표지·자동 제목·Dependabot", () => {
    expect(shouldSkipMessage("GH-1 fix: 수행함 [skip-copy-lint]")).toBe(true);
    expect(shouldSkipMessage('Revert "GH-1 fix: x"')).toBe(true);
    expect(shouldSkipMessage("chore(deps): bump x", "dependabot[bot]")).toBe(
      true,
    );
    expect(shouldSkipMessage("GH-1 fix: 수정")).toBe(false);
  });

  it("메시지 끝 트레일러만 건너뛰고 본문 'Note:' 줄은 검사함", () => {
    const found = checkMessage(
      "GH-2 fix: 수정\n\nNote: 재시도 작업을 완료함\n\nCo-Authored-By: 진행함 <x@y>",
      "m",
    );
    expect(found.map((f: { where: string }) => f.where)).toEqual(["m:3"]);
  });

  it("git blame porcelain에서 줄별 커밋을 읽음", () => {
    const sha = "a".repeat(40);
    const other = "b".repeat(40);
    expect([
      ...parseBlame(
        `${sha} 1 1 2\nauthor x\n\tx\n${sha} 2 2\n\ty\n${other} 5 3 1\n\tz\n`,
      ),
    ]).toEqual([
      [1, sha],
      [2, sha],
      [3, other],
    ]);
  });

  it("diff -U0에서 추가·수정된 새 줄 번호를 찾음", () => {
    const added = parseAddedLines(
      "diff --git a/a.md b/a.md\n+++ b/a.md\n@@ -1,0 +2,2 @@\n+x\n+y\n@@ -9 +11 @@\n-old\n+new\n",
    );
    expect([...added.get("a.md")!]).toEqual([2, 3, 11]);
  });

  it("내용 줄이 '++ '로 시작해도 파일 머리로 오인하지 않고 따옴표 경로를 읽음", () => {
    const added = parseAddedLines(
      "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,0 +1,2 @@\n+++ 예시\n+y\n" +
        'diff --git "a/\\tb.md" "b/\\tb.md"\n+++ "b/\\tb.md"\n@@ -0,0 +1 @@\n+z\n',
    );
    expect([...added.get("a.md")!]).toEqual([1, 2]);
    expect([...added.get("\tb.md")!]).toEqual([1]);
    expect(added.has("예시")).toBe(false);
  });

  it("ko.json 줄에서 문자열 값만 꺼냄", () => {
    expect(jsonLineValue('    "key": "값 \\"인용\\"",')).toBe('값 "인용"');
    expect(jsonLineValue('    "배열 값",')).toBe("배열 값");
    expect(jsonLineValue('  "group": {')).toBeNull();
  });

  it("코드 블록·인라인 코드·링크 주소는 검사하지 않음", () => {
    const lines = docLines(
      "글\n```\n하고, 코드\n```\n`하고, x` 와 [a](http://b/하고, c)\n",
    );
    expect(lines.get(3)).toBeNull();
    expect(lines.get(5)).not.toContain("하고,");
  });
});

describe("커밋 훅(--commit-msg)", () => {
  it("커밋 메시지 규칙에 걸리면 알려 줌", () => {
    expect(
      ids(runCommitMsg(msg("GH-2 fix: 재시도 로직 수정을 진행함\n"), dir)),
    ).toContain("commit:bureaucratic_verb");
  });

  it("스테이징된 화면 문구·문서의 바뀐 줄만 검사함(기존 줄은 그대로)", () => {
    write(
      "apps/web/messages/ko.json",
      '{\n  "a": "그대로 둔 문구, 예전 것",\n  "b": "값이 저장되어집니다"\n}\n',
    );
    write(
      "README.md",
      "# 제목\n\n예전에 쓰고, 그대로 둔 줄\n새로 쓰고, 덧붙인 줄\n",
    );
    git("add", "-A");
    const found = runCommitMsg(msg("GH-2 fix(web): 문구 추가\n"), dir);
    expect(
      found
        .map((f: { where: string; id: string }) => `${f.where} ${f.id}`)
        .sort(),
    ).toEqual(["README.md:4 C-11", "apps/web/messages/ko.json:3 T2b"]);
  });

  it("한글 경로 문서와 diff.noprefix 설정에서도 경로를 바르게 읽음", () => {
    git("config", "diff.noprefix", "true");
    write("docs/안내.md", "새로 쓰고, 덧붙인 줄\n");
    git("add", "-A");
    expect(
      runCommitMsg(msg("GH-2 docs: 안내\n"), dir).map(
        (f: { where: string }) => f.where,
      ),
    ).toEqual(["docs/안내.md:1"]);
  });

  it("스테이징하지 않은 변경은 보지 않음", () => {
    write(
      "README.md",
      "# 제목\n\n예전에 쓰고, 그대로 둔 줄\n새로 쓰고, 덧붙인 줄\n",
    );
    expect(runCommitMsg(msg("GH-2 fix: 문구\n"), dir)).toEqual([]);
  });

  it("[skip-copy-lint]이면 모두 건너뜀", () => {
    write(
      "README.md",
      "# 제목\n\n예전에 쓰고, 그대로 둔 줄\n새로 쓰고, 덧붙인 줄\n",
    );
    git("add", "-A");
    expect(
      runCommitMsg(msg("GH-2 fix: 진행함 [skip-copy-lint]\n"), dir),
    ).toEqual([]);
  });

  it("영어 문구 파일은 금지 표현만 검사함", () => {
    write("apps/web/messages/en.json", '{\n  "a": "Safe to swim, enjoy"\n}\n');
    git("add", "-A");
    expect(ids(runCommitMsg(msg("GH-2 fix: 문구\n"), dir))).toEqual([
      "notice:guarantee",
    ]);
  });

  it("운영자 문구의 따옴표 예시 인용은 통과", () => {
    write(
      "apps/admin/messages/ko.json",
      '{\n  "h": "\'안전해요\' 같은 표현은 쓸 수 없어요"\n}\n',
    );
    git("add", "-A");
    expect(runCommitMsg(msg("GH-2 fix: 도움말\n"), dir)).toEqual([]);
  });

  it("영어 문구 파일·코드 파일은 검사하지 않음", () => {
    write("apps/web/messages/en.json", '{ "a": "x" }\n');
    write("src/a.ts", "// 저장되어집니다\n");
    git("add", "-A");
    expect(runCommitMsg(msg("GH-2 fix: 코드\n"), dir)).toEqual([]);
  });
});

describe("직접 실행", () => {
  it("공백·한글이 든 경로로 불러도 검사를 돌림(검사 없이 통과하지 않음)", () => {
    const linkDir = path.join(dir, "공백 있는 폴더");
    mkdirSync(linkDir);
    const tool = path.join(linkDir, "lint.mjs");
    symlinkSync(path.resolve(__dirname, "../lint.mjs"), tool);
    const r = spawnSync(
      process.execPath,
      [tool, "--commit-msg", msg("GH-2 fix: 수정을 진행함\n")],
      {
        cwd: dir,
        encoding: "utf8",
        env,
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("commit:bureaucratic_verb");
  });
});

describe("CI(--range)", () => {
  it("범위 안 커밋 메시지와 base...head 바뀐 줄을 검사함", () => {
    const base = git("rev-parse", "HEAD");
    write(
      "README.md",
      "# 제목\n\n예전에 쓰고, 그대로 둔 줄\n관리자에 의해 삭제된 줄\n",
    );
    commit("GH-3 docs: 안내를 수정했습니다");
    const head = commit("GH-3 docs: 정리");
    const found = runRange(base, head, dir);
    expect(found.map((f: { id: string }) => f.id).sort()).toEqual([
      "T2",
      "commit:over_polite_ending",
    ]);
  });

  it("표지 커밋이 넣은 줄만 건너뛰고 같은 범위 다른 커밋의 줄은 검사함", () => {
    const base = git("rev-parse", "HEAD");
    write(
      "README.md",
      "# 제목\n\n예전에 쓰고, 그대로 둔 줄\n예외로 쓰고, 둔 줄\n",
    );
    commit("GH-5 docs: 예외 문장 [skip-copy-lint]");
    write(
      "README.md",
      "# 제목\n\n예전에 쓰고, 그대로 둔 줄\n예외로 쓰고, 둔 줄\n관리자에 의해 삭제된 줄\n",
    );
    const head = commit("GH-5 docs: 줄 추가");
    expect(
      runRange(base, head, dir).map(
        (f: { where: string; id: string }) => `${f.where} ${f.id}`,
      ),
    ).toEqual(["README.md:5 T2"]);
  });

  it("Dependabot 커밋 메시지는 건너뛰고, 표지 커밋이 있으면 변경 줄 검사도 건너뜀", () => {
    const base = git("rev-parse", "HEAD");
    commit("chore(deps): bump x from 1 to 2 했습니다", "dependabot[bot]");
    expect(runRange(base, git("rev-parse", "HEAD"), dir)).toEqual([]);
    write("README.md", "# 제목\n\n새로 쓰고, 덧붙인 줄\n");
    const head = commit("GH-4 docs: 예외 문장 [skip-copy-lint]");
    expect(runRange(base, head, dir)).toEqual([]);
  });
});
