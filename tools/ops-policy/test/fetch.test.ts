import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  NOTION_VERSION,
  PAGE_ID,
  buildSnapshot,
  fetchFromNotion,
  main,
  parseArgs,
  writeAtomic,
  parseInline,
  parsePolicyMarkdown,
} from "../fetch.mjs";

// 운영 정책 원본 가져오기 도구 (결정 기록 D20-8~11·D16-E5)
// 노션을 부르지 않음: fetch를 가짜로 바꿔 넘긴 주소·머리말과 검증만 확인함

const REVISION = "2026-11-12T04:50:04.046Z";
const FETCHED = "2026-11-13T01:00:00.000Z";

function section(n: number, lines = 3, extra = "") {
  const items = Array.from({ length: lines }, (_, i) => `- ${n}번 ${i + 1}줄`);
  return [
    `## ${n}. 항목${n}`,
    "",
    "<b>확정</b>",
    "",
    ...items,
    extra,
    "",
    `<span color="gray">근거: D${n}</span>`,
    "",
  ].join("\n");
}

const HEAD = `<callout icon="💡" color="gray_bg">
머리 설명
</callout>

### 이 페이지를 쓰는 법

- 이 줄은 가져오지 않음

---
`;

const page = (sections = 9) =>
  HEAD + Array.from({ length: sections }, (_, i) => section(i + 1)).join("\n");

describe("parseInline", () => {
  it("굵게·코드를 나누고 회색 글자 꾸밈과 백슬래시를 뺀다", () => {
    expect(
      parseInline(
        "보기 \\< 편집 <b>미확정:</b> <code>/policies</code> **굵게** \\`코드\\` 3\\~6줄",
      ),
    ).toEqual([
      { text: "보기 < 편집 " },
      { text: "미확정:", bold: true },
      { text: " " },
      { text: "/policies", code: true },
      { text: " " },
      { text: "굵게", bold: true },
      { text: " `코드` 3~6줄" },
    ]);
    expect(parseInline('<span color="gray">근거: G1</span>')).toEqual([
      { text: "근거: G1" },
    ]);
  });

  it.each([
    ["링크", "[원문](https://example.test)"],
    ["모르는 태그", "<u>밑줄</u>"],
    ["다른 색", '<span color="red">빨강</span>'],
    ["백틱 코드(노션은 <code>로 내보냄)", "보기 `코드`"],
    ["닫히지 않은 회색 글자", '<span color="gray">근거: G1'],
    ["짝 없는 </span>", "근거: G1</span>"],
    [
      "회색 글자 안의 회색 글자",
      '<span color="gray"><span color="gray">a</span></span>',
    ],
  ])("%s는 조용히 글자만 남기지 않고 멈춘다", (_, line) => {
    expect(() => parseInline(line)).toThrow();
  });
});

describe("parsePolicyMarkdown·buildSnapshot", () => {
  it("머리 설명은 빼고 9개 항목의 상태·줄·근거를 담는다", () => {
    const snapshot = buildSnapshot({
      markdown: page(),
      revision: REVISION,
      fetchedAt: FETCHED,
    });
    expect(snapshot.revision).toBe(REVISION);
    expect(snapshot.fetchedAt).toBe(FETCHED);
    expect(snapshot.source.url).toBe(`https://app.notion.com/p/${PAGE_ID}`);
    expect(snapshot.sections).toHaveLength(9);
    expect(snapshot.sections[0]).toEqual({
      number: 1,
      title: "항목1",
      status: "확정",
      items: [
        [{ text: "1번 1줄" }],
        [{ text: "1번 2줄" }],
        [{ text: "1번 3줄" }],
      ],
      basis: "D1",
    });
  });

  it.each([
    ["항목 8개", page(8)],
    ["항목 10개", page(10)],
    ["번호 건너뜀", page().replace("## 3. 항목3", "## 4. 항목3")],
    ["상태 없음", page().replace("<b>확정</b>", "")],
    ["모르는 상태", page().replace("<b>확정</b>", "<b>검토 중</b>")],
    [
      "줄 2개",
      HEAD +
        [
          section(1, 2),
          ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => section(n)),
        ].join("\n"),
    ],
    [
      "줄 7개",
      HEAD +
        [
          section(1, 7),
          ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => section(n)),
        ].join("\n"),
    ],
    ["근거 없음", page().replace('<span color="gray">근거: D5</span>', "")],
    [
      "모르는 문단",
      HEAD +
        [
          section(1, 3, "설명 문단"),
          ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => section(n)),
        ].join("\n"),
    ],
    [
      "안쪽 목록",
      HEAD +
        [
          section(1, 3, "  - 안쪽"),
          ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => section(n)),
        ].join("\n"),
    ],
    [
      "탭으로 들여쓴 안쪽 목록",
      HEAD +
        [
          section(1, 3, "\t- 안쪽"),
          ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => section(n)),
        ].join("\n"),
    ],
    [
      "항목 안 작은 제목",
      page().replace("<b>확정</b>", "<b>확정</b>\n\n### 작은 제목"),
    ],
    ["제목 모양 다름", page().replace("## 2. 항목2", "## 항목2")],
  ])("%s이면 검증 실패로 멈춘다", (_, markdown) => {
    expect(() =>
      buildSnapshot({ markdown, revision: REVISION, fetchedAt: FETCHED }),
    ).toThrow();
  });

  it("revision이 가져온 시각보다 늦거나 시각 모양이 틀리면 멈춘다", () => {
    expect(() =>
      buildSnapshot({
        markdown: page(),
        revision: FETCHED,
        fetchedAt: REVISION,
      }),
    ).toThrow(/늦어요/);
    expect(() =>
      buildSnapshot({
        markdown: page(),
        revision: "2026-11-12",
        fetchedAt: FETCHED,
      }),
    ).toThrow();
  });

  it("빈 머리말만 있으면 항목 0개로 멈춘다", () => {
    expect(parsePolicyMarkdown(HEAD)).toEqual([]);
    expect(() =>
      buildSnapshot({ markdown: HEAD, revision: REVISION, fetchedAt: FETCHED }),
    ).toThrow(/9개가 아니라 0개/);
  });
});

describe("parseArgs", () => {
  it("노션 API(기본)·마크다운 파일·검증만", () => {
    expect(parseArgs([])).toEqual({
      markdown: undefined,
      revision: undefined,
      check: false,
    });
    expect(
      parseArgs(["--markdown", "p.md", "--revision", REVISION, "--check"]),
    ).toEqual({
      markdown: "p.md",
      revision: REVISION,
      check: true,
    });
  });

  it.each([
    ["마크다운에 revision 없음", ["--markdown", "p.md"]],
    ["마크다운 파일 이름 없음", ["--markdown", "--revision", REVISION]],
    ["revision만", ["--revision", REVISION]],
    ["revision 모양 틀림", ["--markdown", "p.md", "--revision", "11/12"]],
  ])("%s이면 멈춘다", (_, argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});

function fakeNotion(options: {
  before?: string;
  after?: string;
  markdown?: string;
  truncated?: boolean;
  status?: number;
}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  let pageCalls = 0;
  const fetchImpl = vi.fn(
    async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      if (options.status) return new Response("{}", { status: options.status });
      if (url.includes("/markdown")) {
        return Response.json({
          markdown: options.markdown ?? page(),
          truncated: options.truncated ?? false,
          unknown_block_ids: [],
        });
      }
      pageCalls += 1;
      return Response.json({
        last_edited_time:
          pageCalls === 1
            ? (options.before ?? REVISION)
            : (options.after ?? REVISION),
      });
    },
  );
  return { fetchImpl, calls };
}

describe("fetchFromNotion", () => {
  it("페이지 정보·본문(v2)·페이지 정보를 차례로 받고 revision은 마지막 수정 시각", async () => {
    const { fetchImpl, calls } = fakeNotion({});
    const result = await fetchFromNotion({ token: "test-token", fetchImpl });
    expect(result.revision).toBe(REVISION);
    expect(calls.map((c) => c.url)).toEqual([
      `https://api.notion.com/v1/pages/${PAGE_ID}`,
      `https://api.notion.com/v1/pages/${PAGE_ID}/markdown?markdown_version=v2`,
      `https://api.notion.com/v1/pages/${PAGE_ID}`,
    ]);
    expect(calls[0]!.headers["Notion-Version"]).toBe(NOTION_VERSION);
    expect(calls[0]!.headers.Authorization).toBe("Bearer test-token");
  });

  it("토큰 없음·응답 실패·잘린 본문·가져오는 사이 수정이면 멈춘다", async () => {
    await expect(
      fetchFromNotion({
        token: undefined,
        fetchImpl: fakeNotion({}).fetchImpl,
      }),
    ).rejects.toThrow(/NOTION_TOKEN/);
    await expect(
      fetchFromNotion({
        token: "t",
        fetchImpl: fakeNotion({ status: 404 }).fetchImpl,
      }),
    ).rejects.toThrow(/404/);
    await expect(
      fetchFromNotion({
        token: "t",
        fetchImpl: fakeNotion({ truncated: true }).fetchImpl,
      }),
    ).rejects.toThrow(/잘렸/);
    await expect(
      fetchFromNotion({
        token: "t",
        fetchImpl: fakeNotion({ after: "2026-11-12T05:00:00.000Z" }).fetchImpl,
      }),
    ).rejects.toThrow(/바뀌었어요/);
  });
});

describe("main", () => {
  it("검증을 통과하면 파일을 쓰고, 실패하면 쓰지 않는다(옛 파일과 가져온 시각이 남음)", async () => {
    const write = vi.fn();
    const log = vi.fn();
    const ok = fakeNotion({});
    await main(
      [],
      { NOTION_TOKEN: "secret-token-xyz" },
      { fetchImpl: ok.fetchImpl, write, log, now: () => FETCHED },
    );
    expect(write).toHaveBeenCalledTimes(1);
    const [file, text] = write.mock.calls[0]!;
    expect(String(file)).toMatch(
      /apps\/admin\/src\/content\/ops-policy\.json$/,
    );
    expect(JSON.parse(String(text))).toMatchObject({
      revision: REVISION,
      fetchedAt: FETCHED,
    });
    // 토큰은 파일·출력에 남지 않음
    expect(String(text)).not.toContain("secret-token-xyz");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret-token-xyz");

    write.mockClear();
    const bad = fakeNotion({ markdown: page(8) });
    await expect(
      main(
        [],
        { NOTION_TOKEN: "t" },
        { fetchImpl: bad.fetchImpl, write, log, now: () => FETCHED },
      ),
    ).rejects.toThrow(/검증 실패/);
    expect(write).not.toHaveBeenCalled();
  });

  it("--check는 쓰지 않는다", async () => {
    const write = vi.fn();
    await main(
      ["--check"],
      { NOTION_TOKEN: "t" },
      {
        fetchImpl: fakeNotion({}).fetchImpl,
        write,
        log: vi.fn(),
        now: () => FETCHED,
      },
    );
    expect(write).not.toHaveBeenCalled();
  });
});

describe("writeAtomic·main 실제 쓰기", () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), "ops-policy-"));

  it("--markdown으로 임시 폴더 파일을 쓰고 .tmp를 남기지 않는다", async () => {
    const root = dir();
    const md = path.join(root, "p.md");
    const out = path.join(root, "ops-policy.json");
    writeFileSync(md, page());
    await main(
      ["--markdown", md, "--revision", REVISION],
      {},
      {
        outFile: out,
        log: vi.fn(),
        now: () => FETCHED,
      },
    );
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({
      revision: REVISION,
      fetchedAt: FETCHED,
    });
    expect(readdirSync(root).sort()).toEqual(["ops-policy.json", "p.md"]);
  });

  it("바꿔 넣기에 실패하면 임시 파일을 지우고 멈춘다", () => {
    const root = dir();
    // 비어 있지 않은 폴더 자리에는 파일을 바꿔 넣을 수 없음
    const out = path.join(root, "ops-policy.json");
    mkdirSync(out);
    writeFileSync(path.join(out, "keep"), "x");
    expect(() => writeAtomic(out, "{}")).toThrow();
    expect(existsSync(`${out}.tmp`)).toBe(false);
    expect(readFileSync(path.join(out, "keep"), "utf8")).toBe("x");
  });
});
