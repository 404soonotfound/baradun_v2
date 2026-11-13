import { describe, expect, it } from "vitest";
import type { OpsResult } from "./auth/ops-fetch";
import { isEmail, mfaResetOutcome, sameEmail } from "./account";

// 다른 운영자의 2단계 인증 초기화 결과 나누기 (#335, D16-A9)
// 본인·없는 계정·이미 없음은 실패와 다르게, 확인 못 한 경우는 '그대로'라고 단정하지 않음

type R = OpsResult<{ result?: unknown }>;
const fail = (status: number, extra: Record<string, string> = {}): R => ({
  ok: false,
  status,
  code: (extra.code as string) ?? "x",
  requestId: "req-1",
  ...extra,
});

describe("mfaResetOutcome", () => {
  it.each<[string, R, string]>([
    ["초기화함", { ok: true, status: 200, body: { result: "reset" } }, "reset"],
    [
      "이미 없음",
      { ok: true, status: 200, body: { result: "already_none" } },
      "already_none",
    ],
    [
      "모르는 성공 응답",
      { ok: true, status: 200, body: { result: "?" } },
      "unknown",
    ],
    ["본인", fail(409, { code: "conflict", reason: "self" }), "self"],
    ["다른 409", fail(409, { code: "conflict", reason: "version" }), "unknown"],
    [
      "없는 계정",
      fail(404, { code: "not_found", reason: "account" }),
      "not_found",
    ],
    ["경로 없음(배포 전 서버)", fail(404, { code: "not_found" }), "unknown"],
    [
      "이메일 모양",
      fail(400, { code: "invalid_request", field: "email" }),
      "invalid_email",
    ],
    ["권한 없음", fail(403, { code: "forbidden" }), "forbidden"],
    ["서버 오류", fail(500, { code: "internal" }), "unknown"],
    ["응답 없음", { ok: false, status: 0, code: "network" }, "unknown"],
    ["다시 로그인", { ok: false, status: 0, code: "reauth" }, "reauth"],
  ])("%s → %s", (_, result, outcome) => {
    expect(mfaResetOutcome(result)).toBe(outcome);
  });
});

describe("이메일", () => {
  it("모양을 서버와 같게 본다", () => {
    expect(isEmail("lost@example.test")).toBe(true);
    expect(isEmail("lost.example.test")).toBe(false);
    expect(isEmail(" lost@example.test")).toBe(false);
    expect(isEmail(`${"a".repeat(250)}@x.test`)).toBe(false);
  });
  it("대소문자·앞뒤 공백은 같은 이메일로 본다", () => {
    expect(sameEmail("Lost@Example.test ", "lost@example.test")).toBe(true);
    expect(sameEmail("lost@example.test", "lost2@example.test")).toBe(false);
  });
});
