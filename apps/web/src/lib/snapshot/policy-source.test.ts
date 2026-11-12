import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// 판단 정책 상수는 계약 패키지 한 곳에만 정의함(결정 기록 D20-5, #256)
// 웹은 '특보 없음' 근거 검증·지표 만료에 @baradun/contracts/judgment-policy 값을 가져다 씀
// 여기에 숫자나 버전 글자를 다시 적으면 publisher와 값이 갈릴 수 있어 원본 글자를 훑어 막음
// 안전망임: 식 모양이 다른 사본(예: 1.5 * HOUR)까지 잡지는 못함
describe("판단 정책 상수를 웹에 다시 적지 않는다 (D20-5)", () => {
  // 정책 버전 글자(warnings-1·observations-1). 주석·이어 붙인 글자 안에 있어도 찾음
  const VERSION_LITERAL = /\b(warnings|observations)-\d/;
  // 45·60·90분을 숫자로 적은 식(곱하는 순서 둘 다)
  // 앞뒤에 곱셈이 더 있으면(예: 9 * 60 * 60_000 = 9시간) 그 값이 아니라서 뺌
  const MINUTE_UNIT = "(60\\s*\\*\\s*1000|60_?000|MINUTE(_MS)?)";
  const MINUTES_LITERAL = new RegExp(
    `(?<!\\*\\s*)\\b(45|60|90)\\s*\\*\\s*${MINUTE_UNIT}\\b(?!\\s*\\*)|(?<!\\*\\s*)\\b${MINUTE_UNIT}\\s*\\*\\s*(45|60|90)\\b(?!\\s*\\*)|\\b(2_?700_?000|3_?600_?000|5_?400_?000)\\b`,
  );
  const SRC = new URL("../../", import.meta.url);
  // 게시본을 읽어 판단 근거를 검증하는 코드 폴더만 봄
  // 폴더 밖의 같은 숫자는 판단 근거가 아닌 화면 규칙이라 보지 않음(예: 파고 그래프 끊김 간격 lib/wave-chart.ts의 CHART_GAP_MS)
  const JUDGMENT_DIR = "lib/snapshot/";

  const sources = (readdirSync(SRC, { recursive: true }) as string[])
    .map((file) => file.replaceAll("\\", "/"))
    .filter(
      (file) => /\.tsx?$/.test(file) && !/\.(test|stories)\.tsx?$/.test(file),
    );

  function hits(file: string, pattern: RegExp): string[] {
    return readFileSync(new URL(file, SRC), "utf8")
      .split("\n")
      .flatMap((line, i) => (pattern.test(line) ? [`${file}:${i + 1}`] : []));
  }

  it("훑는 식이 계약 패키지의 정의는 찾아낸다(빈 검사가 아님)", () => {
    const contract = readFileSync(
      new URL(
        "../../../../../packages/contracts/src/judgment-policy.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(VERSION_LITERAL.test(contract)).toBe(true);
    expect(MINUTES_LITERAL.test(contract)).toBe(true);
    expect(sources).toContain("lib/snapshot/view.ts");
    expect(sources).toContain("lib/snapshot/store.ts");
  });

  it("정책 버전 글자를 웹에 다시 적지 않는다", () => {
    expect(sources.flatMap((file) => hits(file, VERSION_LITERAL))).toEqual([]);
  });

  it("게시본을 읽는 코드에 45·60·90분을 숫자로 다시 적지 않는다", () => {
    const judgment = sources.filter((file) => file.startsWith(JUDGMENT_DIR));
    expect(judgment.length).toBeGreaterThan(0);
    expect(judgment.flatMap((file) => hits(file, MINUTES_LITERAL))).toEqual([]);
  });
});
