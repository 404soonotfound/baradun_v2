import { describe, expect, it, vi } from "vitest";
import { otpauthUri, startSignIn, type ChallengeUser } from "./srp";

// SRP 로그인 단계 (BRD-148). 라이브러리 객체는 가짜로 바꿔 콜백 흐름만 확인

const session = (n: number) =>
  ({
    getAccessToken: () => ({ getJwtToken: () => `access-${n}` }),
    getIdToken: () => ({ getJwtToken: () => `id-${n}` }),
    getRefreshToken: () => ({ getToken: () => `refresh-${n}` }),
  }) as never;

type Script = {
  [K in keyof ChallengeUser]?: (...args: Parameters<ChallengeUser[K]>) => void;
};

function user(script: Script) {
  return {
    authenticateUser: vi.fn(script.authenticateUser),
    completeNewPasswordChallenge: vi.fn(script.completeNewPasswordChallenge),
    sendMFACode: vi.fn(script.sendMFACode),
    associateSoftwareToken: vi.fn(script.associateSoftwareToken),
    verifySoftwareToken: vi.fn(script.verifySoftwareToken),
  } as unknown as ChallengeUser;
}

describe("startSignIn", () => {
  it("데모 풀처럼 2단계가 없으면 바로 토큰", async () => {
    const step = await startSignIn(
      user({ authenticateUser: (_d, cb) => cb.onSuccess(session(1)) }),
      "demo@example.test",
      "pw",
    );
    expect(step).toEqual({
      kind: "signed_in",
      tokens: {
        accessToken: "access-1",
        idToken: "id-1",
        refreshToken: "refresh-1",
      },
    });
  });

  it("운영자: 비밀번호 → 인증 앱 코드 → 토큰", async () => {
    const u = user({
      authenticateUser: (_d, cb) => cb.totpRequired?.("SOFTWARE_TOKEN_MFA", {}),
      sendMFACode: (code, cb, type) =>
        code === "123456" && type === "SOFTWARE_TOKEN_MFA"
          ? cb.onSuccess(session(2))
          : cb.onFailure({ code: "CodeMismatchException" }),
    });
    const step = await startSignIn(u, "ops@example.test", "pw");
    expect(step.kind).toBe("totp");
    if (step.kind !== "totp") return;
    await expect(step.submit("000000")).rejects.toMatchObject({
      code: "CodeMismatchException",
    });
    expect(await step.submit("123456")).toMatchObject({ kind: "signed_in" });
  });

  it("첫 로그인: 새 비밀번호 → 인증 앱 등록(키) → 코드 확인 → 토큰", async () => {
    const u = user({
      authenticateUser: (_d, cb) => cb.newPasswordRequired?.({}, []),
      completeNewPasswordChallenge: (_p, _a, cb) =>
        cb.mfaSetup?.("MFA_SETUP", {}),
      associateSoftwareToken: (cb) =>
        cb.associateSecretCode("JBSWY3DPEHPK3PXP"),
      verifySoftwareToken: (_code, name, cb) => {
        expect(name).toBe("baradun-admin");
        cb.onSuccess(session(3));
      },
    });
    const first = await startSignIn(u, "new@example.test", "temp");
    expect(first.kind).toBe("new_password");
    if (first.kind !== "new_password") return;
    const setup = await first.submit("new-password-12");
    expect(setup).toMatchObject({
      kind: "totp_setup",
      secret: "JBSWY3DPEHPK3PXP",
    });
    if (setup.kind !== "totp_setup") return;
    expect(await setup.submit("654321")).toMatchObject({ kind: "signed_in" });
  });

  it("처리하지 않는 챌린지(SMS 등)는 실패로 본다", async () => {
    await expect(
      startSignIn(
        user({ authenticateUser: (_d, cb) => cb.mfaRequired?.("SMS_MFA", {}) }),
        "a@example.test",
        "pw",
      ),
    ).rejects.toMatchObject({ code: "UnexpectedChallenge" });
  });

  it("틀린 비밀번호는 라이브러리 오류를 그대로 넘긴다(화면이 사유로 바꿈)", async () => {
    await expect(
      startSignIn(
        user({
          authenticateUser: (_d, cb) =>
            cb.onFailure({ code: "NotAuthorizedException" }),
        }),
        "a@example.test",
        "pw",
      ),
    ).rejects.toMatchObject({ code: "NotAuthorizedException" });
  });
});

describe("otpauthUri", () => {
  it("발급자와 이메일, 키만 담는다", () => {
    expect(otpauthUri("ABC", "ops@example.test")).toBe(
      "otpauth://totp/%EB%B0%94%EB%9D%BC%EB%8D%98%20%EB%B0%94%EB%8B%A4%20%EC%9A%B4%EC%98%81%3Aops%40example.test?secret=ABC&issuer=%EB%B0%94%EB%9D%BC%EB%8D%98%20%EB%B0%94%EB%8B%A4%20%EC%9A%B4%EC%98%81",
    );
  });
});
