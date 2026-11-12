import { afterEach, describe, expect, it, vi } from "vitest";

import { invokeArgs, main, parseArgs } from "../republish.mjs";

// 게시 함수를 사람이 직접 부르는 도구 (결정 기록 D20-1~4)
// 이 시험은 AWS를 부르지 않음: 실행기(run)를 가짜로 바꿔 넘긴 인자만 확인함

const FN = "BaradunV2-PublishFunction-ABC123";
const V = "20261017T053000Z";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseArgs", () => {
  it("함수 이름·게시 버전을 받고, 동작은 주지 않으면 다시 내보내기", () => {
    expect(parseArgs(["--function", FN, "--version", V])).toEqual({
      functionName: FN,
      version: V,
      action: "republish",
      yes: false,
    });
    expect(
      parseArgs([
        "--yes",
        "--action",
        "rollback",
        "--version",
        V,
        "--function",
        FN,
      ]),
    ).toEqual({ functionName: FN, version: V, action: "rollback", yes: true });
  });

  it.each([
    ["함수 이름 없음", ["--version", V]],
    ["함수 이름 자리에 다른 선택지", ["--function", "--version", V]],
    ["함수 이름에 셸 글자", ["--function", "fn; rm -rf .", "--version", V]],
    ["버전 없음", ["--function", FN]],
    ["버전 형식 다름", ["--function", FN, "--version", "2026-10-17"]],
    ["버전 뒤에 글자가 더 붙음", ["--function", FN, "--version", `${V}x`]],
    ["모르는 동작", ["--function", FN, "--version", V, "--action", "delete"]],
  ])("%s이면 부르지 않고 오류", (_name, argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});

describe("invokeArgs", () => {
  it("게시 함수가 받는 이벤트 모양 그대로 보내고, 응답은 화면으로 받는다", () => {
    const cli = invokeArgs({
      functionName: FN,
      version: V,
      action: "republish",
    });
    expect(cli.slice(0, 4)).toEqual([
      "lambda",
      "invoke",
      "--function-name",
      FN,
    ]);
    expect(JSON.parse(cli[cli.indexOf("--payload") + 1]!)).toEqual({
      action: "republish",
      version: V,
    });
    expect(cli.at(-1)).toBe("/dev/stdout");
  });
});

describe("main", () => {
  it("--yes가 없으면 명령만 보여 주고 아무것도 부르지 않는다", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const run = vi.fn();
    expect(main(["--function", FN, "--version", V], run)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    const shown = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(shown).toContain(`aws lambda invoke --function-name ${FN}`);
    expect(shown).toContain(`'{"action":"republish","version":"${V}"}'`);
    // 다시 내보내기는 시각을 고치지 않는다는 점을 실행 전에 알림
    expect(shown).toContain("관측·확인 시각은 고치지 않아요");
  });

  it("--yes를 주면 셸을 거치지 않고 aws를 인자 배열로 부르고 종료 코드를 돌려준다", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const run = vi.fn(() => ({ status: 3 }));
    expect(
      main(
        ["--function", FN, "--version", V, "--action", "rollback", "--yes"],
        run,
      ),
    ).toBe(3);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      "aws",
      invokeArgs({ functionName: FN, version: V, action: "rollback" }),
      { stdio: "inherit" },
    );
  });

  it("aws를 실행하지 못하면(설치 안 됨 등) 오류로 알린다", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const run = vi.fn(() => ({ error: new Error("spawn aws ENOENT") }));
    expect(() =>
      main(["--function", FN, "--version", V, "--yes"], run),
    ).toThrow("ENOENT");
  });
});
