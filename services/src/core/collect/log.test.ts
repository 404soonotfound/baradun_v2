import { describe, expect, it } from "vitest";
import {
  createLogger,
  maskRequestKeys,
  maskSecrets,
  normalizeResultCode,
  sanitizeResultMessage,
} from "./log";

// 로그 키 마스킹 (BRD-56)
describe("maskSecrets", () => {
  it("주소의 authKey·ServiceKey 인자를 가림", () => {
    expect(
      maskSecrets("a?authKey=abc123&tm=1 b?ServiceKey=x%2By&pageNo=1", []),
    ).toBe("a?authKey=***&tm=1 b?ServiceKey=***&pageNo=1");
  });

  it("출처 message에 들어온 요청 URL 키도 값만 가림", () => {
    expect(
      maskRequestKeys(
        "요청 실패 https://example.test?ServiceKey=LEAK&from=20261104",
      ),
    ).toBe("요청 실패 https://example.test?ServiceKey=***&from=20261104");
  });

  it("받은 비밀값은 원문·인코딩 모양 모두 가림", () => {
    const secret = "k+e/y==";
    expect(
      maskSecrets(`raw ${secret} enc ${encodeURIComponent(secret)}`, [secret]),
    ).toBe("raw *** enc ***");
  });
});

describe("createLogger", () => {
  it("한 줄 JSON으로 쓰고 나중에 읽은 키도 가림", () => {
    const lines: string[] = [];
    const secrets: string[] = [];
    const log = createLogger(
      () => secrets,
      (line) => lines.push(line),
    );
    secrets.push("TOPSECRET");
    log("error", "source_failed", { detail: "key TOPSECRET failed" });
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "error",
      event: "source_failed",
      detail: "key *** failed",
    });
  });
});

describe("sanitizeResultMessage · normalizeResultCode", () => {
  it("200자·64자 길이 제한과 제어문자만 있는 입력을 정리함", () => {
    expect(sanitizeResultMessage("x".repeat(300))).toBe("x".repeat(200));
    expect(sanitizeResultMessage(`${"a".repeat(199)} bbb`)).toBe(
      "a".repeat(199),
    );
    expect(sanitizeResultMessage("\n\t\u0000  ")).toBeUndefined();
    expect(sanitizeResultMessage(123)).toBeUndefined();
  });

  it("resultCode는 문자열·숫자만 허용하고 64자로 제한함", () => {
    expect(normalizeResultCode("c".repeat(100))).toBe("c".repeat(64));
    expect(normalizeResultCode(3)).toBe("3");
    expect(normalizeResultCode(true)).toBeUndefined();
    expect(normalizeResultCode({})).toBeUndefined();
    expect(normalizeResultCode(null)).toBeUndefined();
  });
});
