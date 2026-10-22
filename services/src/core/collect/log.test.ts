import { describe, expect, it } from "vitest";
import { createLogger, maskSecrets } from "./log";

// 로그 키 마스킹 (BRD-56)
describe("maskSecrets", () => {
  it("주소의 authKey·ServiceKey 인자를 가림", () => {
    expect(
      maskSecrets("a?authKey=abc123&tm=1 b?ServiceKey=x%2By&pageNo=1", []),
    ).toBe("a?authKey=***&tm=1 b?ServiceKey=***&pageNo=1");
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
