import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  createValidator,
  decideScope,
  parseEvents,
  verifyProbe,
  verifyReview,
} from "../verify.mjs";

// 이벤트 모양은 agy 1.4.12 stream-json에서 확인한 것(init·step_update·result)
const CWD = "/tmp/agy-review-snap-abc";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MODEL = "gemini-3.8-flash-high";
const SENSITIVE = ["services/src/core/", "services/src/admin/"];
const validate = createValidator();

const init = (over = {}) => ({
  event: "init",
  conversation_id: "c1",
  init: { model: MODEL, cwd: CWD, permission_mode: "request-review", ...over },
});
let step = 0;
const tool = (
  tool_name: string,
  state: string,
  parameters: object,
  error?: string,
) => ({
  event: "step_update",
  step_update: {
    step_index: ++step,
    state,
    step_type: "tool",
    tool_name,
    tool_info: {
      name: tool_name,
      parameters,
      ...(error ? { error: { type: "TOOL_ERROR", message: error } } : {}),
    },
  },
});
const readOf = (rel: string) =>
  tool("read_file", "DONE", { Path: `${CWD}/${rel}` });
const result = (response: unknown, over = {}) => ({
  event: "result",
  result: {
    conversation_id: "c1",
    status: "SUCCESS",
    response:
      typeof response === "string" ? response : JSON.stringify(response),
    num_turns: 1,
    ...over,
  },
});
const jsonl = (...events: object[]) =>
  events.map((e) => JSON.stringify(e)).join("\n");

const review = (over = {}) => ({
  base_sha: BASE,
  head_sha: HEAD,
  scope: "full",
  reviewed_files: [
    "services/src/admin/inquiries.ts",
    "services/src/admin/policy.ts",
  ],
  findings: [],
  not_reviewed_files: [],
  not_reviewed_aspects: ["실제 AWS 동작"],
  limitations: [],
  end_marker: "e1d2c3b4a5f60718",
  ...over,
});
const expected = (over = {}) => ({
  model: MODEL,
  cwd: CWD,
  baseSha: BASE,
  headSha: HEAD,
  scope: "full",
  requiredFiles: ["services/src/admin/inquiries.ts"],
  diffFiles: ["services/src/admin/inquiries.ts"],
  sensitivePrefixes: SENSITIVE,
  evidenceCount: 1,
  endMarker: "e1d2c3b4a5f60718",
  ...over,
});
const verify = (text: string, over = {}, exitCode = 0) =>
  verifyReview({ exitCode, text, validate, expected: expected(over) });
const ok = () =>
  jsonl(init(), readOf("services/src/admin/policy.ts"), result(review()));

describe("리뷰 판정", () => {
  it("정상: SHA·변경 파일·주변 파일 읽기 기록이 맞으면 완료", () => {
    const v = verify(ok());
    expect(v.reasons).toEqual([]);
    expect(v.complete).toBe(true);
    expect(v.notion.status).toBe("제공");
    expect(v.limits[0]).toContain("Flash");
  });

  it("시간 초과: SUCCESS·종료 코드 0이어도 finished_reason print_timeout이면 미완료", () => {
    const v = verify(
      jsonl(init(), result("", { finished_reason: "print_timeout" })),
    );
    expect(v.complete).toBe(false);
    expect(v.reasons).toContain("종료 사유 print_timeout");
    expect(v.reasons).toContain("응답이 비어 있음");
  });

  it("한도 초과: 종료 코드 3·status ERROR면 미완료", () => {
    const v = verify(
      jsonl(
        init(),
        result("", { status: "ERROR", error: "Individual quota reached." }),
      ),
      {},
      3,
    );
    expect(v.complete).toBe(false);
    expect(v.reasons).toEqual(
      expect.arrayContaining([
        "agy 종료 코드 3",
        "agy 상태 ERROR: Individual quota reached.",
      ]),
    );
  });

  it("결과 이벤트가 없거나(중단) 줄이 깨지면 미완료", () => {
    expect(verify(jsonl(init())).reasons).toContain("결과 이벤트(result) 없음");
    expect(verify(`${ok()}\n{깨진 줄`).reasons).toContain(
      "stream-json 4번째 줄을 읽지 못함",
    );
  });

  it("null·false·0·빈 문자열 JSON 응답도 스키마 검사를 거쳐 미완료", () => {
    for (const response of ["null", "false", "0", '""']) {
      const v = verify(
        jsonl(init(), readOf("services/src/admin/policy.ts"), result(response)),
      );
      expect(v.complete, response).toBe(false);
      expect(
        v.reasons.some((r: string) => r.startsWith("스키마 위반")),
        response,
      ).toBe(true);
    }
  });

  it("프롬프트 끝 표지를 돌려받지 못하면(입력 잘림) 미완료", () => {
    const v = verify(
      jsonl(
        init(),
        readOf("services/src/admin/policy.ts"),
        result(review({ end_marker: "" })),
      ),
    );
    expect(v.complete).toBe(false);
    expect(v.reasons).toContain(
      "프롬프트 끝 표지 불일치(입력이 잘렸을 수 있음): 빈 값",
    );
  });

  it("빈 응답·JSON 아닌 응답·스키마 위반은 미완료", () => {
    expect(verify(jsonl(init(), result("   "))).reasons).toContain(
      "응답이 비어 있음",
    );
    expect(
      verify(jsonl(init(), result("검토 결과 문제 없음"))).reasons,
    ).toContain("응답이 JSON이 아님");
    const bad = verify(
      jsonl(
        init(),
        result({
          ...review(),
          findings: [
            {
              severity: "P9",
              file: "x",
              line: 1,
              problem: "p",
              reason: "r",
              fix_direction: "f",
            },
          ],
        }),
      ),
    );
    expect(bad.complete).toBe(false);
    expect(bad.reasons.some((r: string) => r.startsWith("스키마 위반"))).toBe(
      true,
    );
  });

  it("SHA·범위가 넘긴 값과 다르면 미완료", () => {
    const v = verify(
      jsonl(
        init(),
        readOf("services/src/admin/policy.ts"),
        result(review({ head_sha: "c".repeat(40), scope: "incremental" })),
      ),
    );
    expect(v.reasons).toEqual(
      expect.arrayContaining([
        `head SHA 불일치: ${"c".repeat(40)}`,
        "범위 불일치: incremental (기대 full)",
      ]),
    );
  });

  it("변경 파일이 reviewed_files에 없으면 검토 누락", () => {
    const v = verify(ok(), {
      requiredFiles: [
        "services/src/admin/inquiries.ts",
        "services/src/admin/handler.ts",
      ],
      diffFiles: [
        "services/src/admin/inquiries.ts",
        "services/src/admin/handler.ts",
      ],
    });
    expect(v.reasons).toContain("검토 누락: services/src/admin/handler.ts");
  });

  it("diff 밖 파일을 검토했다고 하면 사본에서 읽은 기록이 있어야 함", () => {
    const v = verify(jsonl(init(), result(review())));
    expect(v.reasons).toContain(
      "읽은 기록 없는 주변 파일: services/src/admin/policy.ts",
    );
  });

  it("사본 밖 파일을 읽으면 미완료", () => {
    const v = verify(
      jsonl(
        init(),
        readOf("services/src/admin/policy.ts"),
        tool("read_file", "DONE", { Path: "/Users/soo/.ssh/id_ed25519" }),
        result(review()),
      ),
    );
    expect(v.reasons).toContain(
      "사본 밖 파일을 읽음: /Users/soo/.ssh/id_ed25519",
    );
    // 사본 경로로 시작해도 ../로 빠져나가면 사본 밖
    const escaped = verify(
      jsonl(
        init(),
        readOf("services/src/admin/policy.ts"),
        tool("read_file", "DONE", { Path: `${CWD}/../../etc/passwd` }),
        result(review()),
      ),
    );
    expect(escaped.reasons).toContain("사본 밖 파일을 읽음: /etc/passwd");
  });

  it("파일 만들기·명령 입력·웹 도구가 성공해도 미완료", () => {
    for (const name of [
      "create_file",
      "send_command_input",
      "read_url_content",
    ]) {
      const v = verify(
        jsonl(
          init(),
          tool(name, "DONE", {}),
          readOf("services/src/admin/policy.ts"),
          result(review()),
        ),
      );
      expect(v.reasons).toContain(`쓰기·실행 도구가 성공함: ${name}`);
    }
  });

  it("사본 안 없는 경로를 읽으려 한 것은 참고로만, 사본 밖이면 미완료", () => {
    const missing = (path: string) =>
      tool("read_file", "ERROR", { Path: path }, "file does not exist");
    const v = verify(
      jsonl(
        init(),
        missing(`${CWD}/infra/src/settings.ts`),
        readOf("services/src/admin/policy.ts"),
        result(review()),
      ),
    );
    expect(v.complete).toBe(true);
    expect(v.notes).toEqual(["없는 파일을 읽으려 함: infra/src/settings.ts"]);
    const outside = verify(
      jsonl(
        init(),
        missing("/Users/soo/.aws/credentials"),
        readOf("services/src/admin/policy.ts"),
        result(review()),
      ),
    );
    expect(outside.complete).toBe(false);
  });

  it("리뷰 중 도구 거부가 있으면 미완료, 쓰기·실행 도구가 성공하면 미완료", () => {
    const denied = tool(
      "run_command",
      "ERROR",
      { CommandLine: "git log" },
      "Permission denied for command(git log). Matches user-configured deny rule.",
    );
    expect(
      verify(
        jsonl(
          init(),
          denied,
          readOf("services/src/admin/policy.ts"),
          result(review()),
        ),
      ).reasons[0],
    ).toMatch(/^리뷰 중 도구 거부·오류: run_command/);
    const wrote = tool("write_to_file", "DONE", { TargetFile: `${CWD}/x` });
    expect(
      verify(
        jsonl(
          init(),
          wrote,
          readOf("services/src/admin/policy.ts"),
          result(review()),
        ),
      ).reasons,
    ).toContain("쓰기·실행 도구가 성공함: write_to_file");
  });

  it("민감 파일이 미검토로 남으면 미완료, 검토·미검토 겹침도 미완료", () => {
    const v = verify(
      jsonl(
        init(),
        readOf("services/src/admin/policy.ts"),
        result(
          review({
            not_reviewed_files: [
              "services/src/core/judge.ts",
              "services/src/admin/policy.ts",
            ],
          }),
        ),
      ),
    );
    expect(v.reasons).toEqual(
      expect.arrayContaining([
        "민감 파일 미검토: services/src/core/judge.ts",
        "검토·미검토에 함께 있음: services/src/admin/policy.ts",
      ]),
    );
  });

  it("미검토 파일과 미검토 관점은 나뉘어 남음", () => {
    const v = verify(
      jsonl(
        init(),
        readOf("services/src/admin/policy.ts"),
        result(
          review({
            not_reviewed_files: ["apps/admin/src/app/page.tsx"],
            not_reviewed_aspects: ["화면 렌더링"],
          }),
        ),
      ),
    );
    expect(v.complete).toBe(true);
    expect(v.review.not_reviewed_files).toEqual([
      "apps/admin/src/app/page.tsx",
    ]);
    expect(v.review.not_reviewed_aspects).toEqual(["화면 렌더링"]);
  });

  it("민감 경로가 바뀌었는데 노션 근거가 없으면 기준 문서 대조 미완료", () => {
    expect(verify(ok(), { evidenceCount: 0 }).notion).toEqual({
      status: "미완료",
      sensitiveChanged: ["services/src/admin/inquiries.ts"],
    });
    expect(
      verify(ok(), {
        evidenceCount: 0,
        diffFiles: ["tools/x.mjs"],
        requiredFiles: [],
      }).notion.status,
    ).toBe("해당 없음");
  });

  it("시작 정보의 모델·권한 모드·작업 폴더가 다르면 미완료", () => {
    const v = verify(
      jsonl(
        init({
          model: "gemini-4-argon-high",
          permission_mode: "always-proceed",
          cwd: "/Users/soo/git/baradun_v2",
        }),
        result(review()),
      ),
    );
    expect(v.reasons).toEqual(
      expect.arrayContaining([
        `모델 불일치: gemini-4-argon-high (기대 ${MODEL})`,
        "권한 모드 불일치: always-proceed (기대 request-review)",
        `작업 폴더 불일치: /Users/soo/git/baradun_v2 (기대 ${CWD})`,
      ]),
    );
    expect(verify(jsonl(result(review()))).reasons).toContain(
      "시작 정보(init) 없음",
    );
  });
});

describe("거부 시험", () => {
  const exp = { model: MODEL, cwd: CWD };
  const deniedWrite = () =>
    tool(
      "write_to_file",
      "ERROR",
      { TargetFile: `${CWD}/agy-probe.txt` },
      `Permission denied for write_file(${CWD}/agy-probe.txt). Matches user-configured deny rule.`,
    );
  const deniedCmd = () =>
    tool(
      "run_command",
      "ERROR",
      { CommandLine: "touch agy-probe-cmd.txt" },
      'permission check failed for command "touch agy-probe-cmd.txt": Permission denied for command(touch agy-probe-cmd.txt). Matches user-configured deny rule.',
    );

  it("쓰기·명령이 deny 규칙으로 거부되고 사본이 그대로면 통과", () => {
    expect(
      verifyProbe({
        exitCode: 0,
        text: jsonl(init(), deniedWrite(), deniedCmd(), result("둘 다 거부됨")),
        expected: exp,
        snapshotUnchanged: true,
      }),
    ).toEqual({ ok: true, reasons: [] });
  });

  it("도구를 부르지 않았거나 deny가 아닌 이유로 실패하면 통과 아님", () => {
    const none = verifyProbe({
      exitCode: 0,
      text: jsonl(init(), result("못 하겠어요")),
      expected: exp,
      snapshotUnchanged: true,
    });
    expect(none.reasons).toEqual([
      "파일 쓰기가 deny 규칙으로 거부된 기록 없음",
      "명령 실행이 deny 규칙으로 거부된 기록 없음",
    ]);
    const headless = tool(
      "write_to_file",
      "ERROR",
      {},
      "a tool required the write_file permission that headless mode cannot prompt for",
    );
    expect(
      verifyProbe({
        exitCode: 0,
        text: jsonl(init(), headless, deniedCmd(), result("")),
        expected: exp,
        snapshotUnchanged: true,
      }).ok,
    ).toBe(false);
  });

  it("쓰기가 성공했거나 사본이 바뀌면 통과 아님", () => {
    const wrote = tool("write_to_file", "DONE", {
      TargetFile: `${CWD}/agy-probe.txt`,
    });
    const v = verifyProbe({
      exitCode: 0,
      text: jsonl(init(), wrote, deniedWrite(), deniedCmd(), result("")),
      expected: exp,
      snapshotUnchanged: false,
    });
    expect(v.reasons).toEqual([
      "쓰기·실행 도구가 성공함: write_to_file",
      "거부 시험 뒤 사본 내용이 바뀜",
    ]);
  });

  it("실제 agy 1.4.12 기록(픽스처)으로도 통과", () => {
    const fx = JSON.parse(
      readFileSync(
        new URL("./fixtures/probe-real.json", import.meta.url),
        "utf8",
      ),
    );
    expect(
      verifyProbe({
        exitCode: 0,
        text: fx.jsonl,
        expected: { model: fx.model, cwd: fx.cwd },
        snapshotUnchanged: true,
      }),
    ).toEqual({ ok: true, reasons: [] });
  });
});

describe("추가 리뷰 범위", () => {
  const previous = { base_sha: BASE, verdict: { complete: true } };
  it("base 같고 이전 head가 조상이며 병합 커밋이 없을 때만 증분", () => {
    expect(
      decideScope({
        previous,
        baseSha: BASE,
        prevHeadIsAncestor: true,
        mergeCommits: 0,
      }).scope,
    ).toBe("incremental");
  });
  it("base 변경·리베이스·병합 커밋·이전 미완료는 전체 재검토", () => {
    expect(
      decideScope({
        previous: null,
        baseSha: BASE,
        prevHeadIsAncestor: false,
        mergeCommits: 0,
      }),
    ).toEqual({ scope: "full", reasons: ["첫 리뷰"] });
    const v = decideScope({
      previous: { base_sha: "d".repeat(40), verdict: { complete: false } },
      baseSha: BASE,
      prevHeadIsAncestor: false,
      mergeCommits: 0,
    });
    expect(v.scope).toBe("full");
    expect(v.reasons).toEqual([
      "base가 바뀜",
      "이전 head가 지금 head의 조상이 아님(리베이스·강제 push)",
      "이전 리뷰가 미완료",
    ]);
    expect(
      decideScope({
        previous,
        baseSha: BASE,
        prevHeadIsAncestor: true,
        mergeCommits: 1,
      }).scope,
    ).toBe("full");
  });
});

it("parseEvents는 빈 줄을 건너뛰고 깨진 줄 번호를 남김", () => {
  expect(parseEvents('{"event":"init"}\n\nnope\n')).toEqual({
    events: [{ event: "init" }],
    errors: ["stream-json 3번째 줄을 읽지 못함"],
  });
});
