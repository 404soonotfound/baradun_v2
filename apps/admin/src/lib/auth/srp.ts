import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
  type ICognitoStorage,
} from "amazon-cognito-identity-js";
import type { PoolConfig } from "./config";

// SRP 로그인 단계 (BRD-148, 결정 기록 D17-1). 라이브러리는 SRP 계산과 로그인 챌린지 응답에만 씀
// 2026-11-03 실제 풀 실증(infra/scripts/operator-auth-probe.mjs)과 같은 흐름
//   비밀번호 → (새 비밀번호) → 인증 앱 코드(SOFTWARE_TOKEN_MFA) 또는 인증 앱 등록(MFA_SETUP) → 토큰
// 데모 풀은 MFA가 없어 비밀번호(·새 비밀번호) 뒤 바로 토큰
// 라이브러리 저장소는 메모리로 바꿈(D16-A2: localStorage·sessionStorage에 아무것도 두지 않음). 이 객체도 새로고침하면 사라짐

class MemoryStorage implements ICognitoStorage {
  private readonly data = new Map<string, string>();
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  clear() {
    this.data.clear();
  }
}

export interface Tokens {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
}

// 로그인 다음 단계. 각 단계의 함수는 같은 CognitoUser(챌린지 세션 3분)를 이어서 씀
export type SignInStep =
  | { readonly kind: "signed_in"; readonly tokens: Tokens }
  | {
      readonly kind: "new_password";
      readonly submit: (newPassword: string) => Promise<SignInStep>;
    }
  | {
      readonly kind: "totp";
      readonly submit: (code: string) => Promise<SignInStep>;
    }
  | {
      readonly kind: "totp_setup";
      // 인증 앱에 넣을 키(Base32). 화면 밖에 저장하지 않음
      readonly secret: string;
      readonly submit: (code: string) => Promise<SignInStep>;
    };

// 테스트에서 가짜로 바꿀 수 있게 라이브러리 객체의 필요한 부분만 씀
export type ChallengeUser = Pick<
  CognitoUser,
  | "authenticateUser"
  | "completeNewPasswordChallenge"
  | "sendMFACode"
  | "associateSoftwareToken"
  | "verifySoftwareToken"
>;

function tokensOf(session: CognitoUserSession): Tokens {
  return {
    accessToken: session.getAccessToken().getJwtToken(),
    idToken: session.getIdToken().getJwtToken(),
    refreshToken: session.getRefreshToken().getToken(),
  };
}

type Outcome =
  | { kind: "session"; session: CognitoUserSession }
  | { kind: "new_password" | "totp" | "totp_setup" };

function unexpected(name: string) {
  return Object.assign(new Error(`unexpected challenge: ${name}`), {
    code: "UnexpectedChallenge",
  });
}

// 라이브러리 콜백을 Promise 하나로 모음. 처리하지 않는 챌린지(SMS 등)는 실패로 봄
function callbacks(
  resolve: (o: Outcome) => void,
  reject: (e: unknown) => void,
) {
  return {
    onSuccess: (session: CognitoUserSession) =>
      resolve({ kind: "session", session }),
    onFailure: reject,
    newPasswordRequired: () => resolve({ kind: "new_password" }),
    totpRequired: () => resolve({ kind: "totp" }),
    mfaSetup: () => resolve({ kind: "totp_setup" }),
    mfaRequired: (name: string) => reject(unexpected(name)),
    selectMFAType: () => reject(unexpected("SELECT_MFA_TYPE")),
    customChallenge: () => reject(unexpected("CUSTOM_CHALLENGE")),
  };
}

async function stepOf(
  user: ChallengeUser,
  outcome: Outcome,
): Promise<SignInStep> {
  switch (outcome.kind) {
    case "session":
      return { kind: "signed_in", tokens: tokensOf(outcome.session) };
    case "new_password":
      return {
        kind: "new_password",
        submit: async (newPassword) =>
          stepOf(
            user,
            await new Promise<Outcome>((resolve, reject) =>
              user.completeNewPasswordChallenge(
                newPassword,
                {},
                callbacks(resolve, reject),
              ),
            ),
          ),
      };
    case "totp":
      return {
        kind: "totp",
        submit: async (code) =>
          stepOf(
            user,
            await new Promise<Outcome>((resolve, reject) =>
              user.sendMFACode(
                code,
                {
                  onSuccess: (session) => resolve({ kind: "session", session }),
                  onFailure: reject,
                },
                "SOFTWARE_TOKEN_MFA",
              ),
            ),
          ),
      };
    case "totp_setup": {
      const secret = await new Promise<string>((resolve, reject) =>
        user.associateSoftwareToken({
          associateSecretCode: resolve,
          onFailure: reject,
        }),
      );
      return {
        kind: "totp_setup",
        secret,
        submit: async (code) =>
          stepOf(
            user,
            await new Promise<Outcome>((resolve, reject) =>
              user.verifySoftwareToken(code, "baradun-admin", {
                onSuccess: (session) => resolve({ kind: "session", session }),
                onFailure: reject,
              }),
            ),
          ),
      };
    }
  }
}

export async function startSignIn(
  user: ChallengeUser,
  email: string,
  password: string,
): Promise<SignInStep> {
  const outcome = await new Promise<Outcome>((resolve, reject) =>
    user.authenticateUser(
      new AuthenticationDetails({ Username: email, Password: password }),
      callbacks(resolve, reject),
    ),
  );
  return stepOf(user, outcome);
}

export function newChallengeUser(
  pool: PoolConfig,
  email: string,
): ChallengeUser {
  const Storage = new MemoryStorage();
  return new CognitoUser({
    Username: email,
    Pool: new CognitoUserPool({
      UserPoolId: pool.userPoolId,
      ClientId: pool.clientId,
      Storage,
    }),
    Storage,
  });
}

// 인증 앱 등록용 otpauth 주소(QR). 발급자 이름과 계정 이메일만 담음
export function otpauthUri(secret: string, email: string): string {
  const issuer = "바라던 바다 운영";
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}
