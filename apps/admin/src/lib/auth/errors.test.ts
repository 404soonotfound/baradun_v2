import { describe, expect, it } from "vitest";
import { authFailureOf } from "./errors";

// Cognito 오류 → 화면 사유 (BRD-148, D16-A5)

describe("authFailureOf", () => {
  it.each([
    [
      {
        code: "NotAuthorizedException",
        message: "Incorrect username or password.",
      },
      "wrong_credentials",
    ],
    [{ code: "UserNotFoundException", message: "" }, "wrong_credentials"],
    [
      { code: "NotAuthorizedException", message: "Password attempts exceeded" },
      "locked",
    ],
    [
      {
        code: "NotAuthorizedException",
        message: "Invalid session for the user, session is expired.",
      },
      "session_expired",
    ],
    [{ code: "CodeMismatchException", message: "" }, "code_mismatch"],
    [{ code: "EnableSoftwareTokenMFAException", message: "" }, "code_mismatch"],
    [
      {
        code: "InvalidPasswordException",
        message: "Password did not conform with policy",
      },
      "password_rule",
    ],
    [
      {
        code: "InvalidPasswordException",
        message: "Password has previously been used",
      },
      "password_reused",
    ],
    [{ code: "LimitExceededException", message: "" }, "limit_exceeded"],
    [{ name: "NetworkError" }, "network"],
    [{ code: "SomethingNew" }, "unknown"],
    ["boom", "unknown"],
  ])("%j → %s", (error, failure) => {
    expect(authFailureOf(error)).toBe(failure);
  });
});
