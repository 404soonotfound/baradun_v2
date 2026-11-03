import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Page, type Route } from "@playwright/test";

// 운영자 사이트 E2E 공용 (BRD-148)
// Cognito 사용자 풀 API는 가짜로 응답함(실제 계정·비밀값 없음). 로그인 라이브러리(SRP)는 실제와 같이 계산하고 서버 대답만 바꿈
// 빌드는 아래 테스트 풀 값으로 함(CI admin 작업과 같음)

export const TEST_POOL_ENV = {
  NEXT_PUBLIC_OPERATOR_USER_POOL_ID: "ap-northeast-2_TestOperator",
  NEXT_PUBLIC_OPERATOR_CLIENT_ID: "testoperatorclient0000000001",
  NEXT_PUBLIC_DEMO_USER_POOL_ID: "ap-northeast-2_TestDemo",
  NEXT_PUBLIC_DEMO_CLIENT_ID: "testdemoclient00000000000001",
};

const COGNITO = "https://cognito-idp.ap-northeast-2.amazonaws.com/";

// 서명 없는 가짜 JWT(클레임 읽기만). 라이브러리가 쓰는 base64(표준) 모양
function jwt(payload: Record<string, unknown>): string {
  const part = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString("base64").replace(/=+$/, "");
  return `${part({ alg: "none", kid: "test" })}.${part(payload)}.c2ln`;
}

// expIn: access 만료까지 초(기본 15분). 시계를 빨리 감는 테스트는 발급마다 다르게 줌
export function tokensFor(email: string, groups: string[], expIn = 900) {
  const now = Math.floor(Date.now() / 1000);
  return {
    AccessToken: jwt({
      token_use: "access",
      sub: `sub-${email}`,
      exp: now + expIn,
      iat: now,
      auth_time: now,
      client_id: "test",
      username: email,
      "cognito:groups": groups,
    }),
    IdToken: jwt({
      token_use: "id",
      email,
      exp: now + 900,
      iat: now,
      auth_time: now,
    }),
    RefreshToken: "test-refresh",
    ExpiresIn: 900,
    TokenType: "Bearer",
  };
}

// 서버 SRP 값(임의). 라이브러리는 이 값으로 계산해 응답을 보내고, 가짜 서버는 그 응답을 그대로 받아 줌
const SRP_B = "a".repeat(512);

export type CognitoReply = { status?: number; body: Record<string, unknown> };
// 요청 본문에서 쓰는 칸만
export interface CognitoRequest {
  readonly ChallengeName?: string;
  readonly ChallengeResponses?: Record<string, string>;
  readonly UserCode?: string;
}

export type CognitoHandler = (
  target: string,
  body: CognitoRequest,
) => CognitoReply | undefined;

const error = (type: string, message = ""): CognitoReply => ({
  status: 400,
  body: { __type: type, message },
});

export const COGNITO_ERRORS = { error };

// 로그인 흐름 대본: 비밀번호 확인 뒤 무엇이 오는지 정함
export function srpScript(options: {
  email: string;
  groups?: string[];
  password?: string;
  // 비밀번호 확인 뒤: tokens(바로) · totp(인증 앱 코드) · new_password(첫 로그인) · locked · wrong
  after: "tokens" | "totp" | "new_password" | "locked" | "wrong";
  totpCode?: string;
  // 발급마다 access 만료까지 초(기본 15분)
  expIn?: () => number;
}): CognitoHandler {
  const groups = options.groups ?? ["publisher"];
  const issue = () =>
    tokensFor(options.email, groups, options.expIn?.() ?? 900);
  return (target, body) => {
    if (target === "InitiateAuth") {
      if (options.after === "wrong")
        return error(
          "NotAuthorizedException",
          "Incorrect username or password.",
        );
      if (options.after === "locked")
        return error("NotAuthorizedException", "Password attempts exceeded");
      return {
        body: {
          ChallengeName: "PASSWORD_VERIFIER",
          ChallengeParameters: {
            SALT: "abcdef0123456789",
            SECRET_BLOCK: Buffer.from("secret-block").toString("base64"),
            SRP_B,
            USERNAME: options.email,
            USER_ID_FOR_SRP: options.email,
          },
        },
      };
    }
    if (target === "RespondToAuthChallenge") {
      const name = body.ChallengeName;
      if (name === "PASSWORD_VERIFIER") {
        if (options.after === "totp")
          return {
            body: {
              ChallengeName: "SOFTWARE_TOKEN_MFA",
              Session: "s1",
              ChallengeParameters: {},
            },
          };
        if (options.after === "new_password") {
          return {
            body: {
              ChallengeName: "NEW_PASSWORD_REQUIRED",
              Session: "s1",
              ChallengeParameters: {
                userAttributes: JSON.stringify({ email: options.email }),
                requiredAttributes: "[]",
              },
            },
          };
        }
        return {
          body: {
            AuthenticationResult: issue(),
            ChallengeParameters: {},
          },
        };
      }
      if (name === "SOFTWARE_TOKEN_MFA") {
        return body.ChallengeResponses?.SOFTWARE_TOKEN_MFA_CODE ===
          (options.totpCode ?? "123456")
          ? {
              body: {
                AuthenticationResult: issue(),
                ChallengeParameters: {},
              },
            }
          : error("CodeMismatchException", "Invalid code received for user");
      }
      if (name === "NEW_PASSWORD_REQUIRED") {
        // 운영자 풀은 MFA 필수 → 새 비밀번호 뒤 인증 앱 등록. 데모 풀(그룹 sample)은 바로 토큰
        return groups.includes("sample")
          ? {
              body: {
                AuthenticationResult: issue(),
                ChallengeParameters: {},
              },
            }
          : {
              body: {
                ChallengeName: "MFA_SETUP",
                Session: "s2",
                ChallengeParameters: {},
              },
            };
      }
      if (name === "MFA_SETUP") {
        return {
          body: {
            AuthenticationResult: issue(),
            ChallengeParameters: {},
          },
        };
      }
    }
    if (target === "AssociateSoftwareToken")
      return { body: { SecretCode: "JBSWY3DPEHPK3PXP", Session: "s3" } };
    if (target === "VerifySoftwareToken") {
      return body.UserCode === (options.totpCode ?? "123456")
        ? { body: { Status: "SUCCESS", Session: "s4" } }
        : error("EnableSoftwareTokenMFAException", "Code mismatch");
    }
    if (target === "RevokeToken") return { body: {} };
    return undefined;
  };
}

export async function mockCognito(page: Page, ...handlers: CognitoHandler[]) {
  const calls: { target: string; body: CognitoRequest }[] = [];
  await page.route(COGNITO, async (route: Route) => {
    const target =
      (route.request().headers()["x-amz-target"] ?? "").split(".").pop() ?? "";
    const body = JSON.parse(route.request().postData() ?? "{}");
    calls.push({ target, body });
    const reply =
      handlers.map((h) => h(target, body)).find(Boolean) ??
      error("UnknownOperationException");
    await route.fulfill({
      status: reply.status ?? 200,
      contentType: "application/x-amz-json-1.1",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(reply.body),
    });
  });
  return calls;
}

export async function mockOps(
  page: Page,
  me: { status: number; body: unknown },
) {
  const calls: Record<string, string>[] = [];
  await page.route("**/ops/me", async (route) => {
    calls.push(route.request().headers());
    await route.fulfill({
      status: me.status,
      contentType: "application/json",
      body: JSON.stringify(me.body),
    });
  });
  return calls;
}

export const ME_OK = {
  status: 200,
  body: {
    kind: "operator",
    role: "publisher",
    authTime: "",
    sessionExpiresAt: "",
  },
};

export async function signInWithPassword(
  page: Page,
  path: string,
  email: string,
) {
  await page.goto(path);
  await page.getByLabel("이메일").fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("test-password-1");
  await page.getByRole("button", { name: "다음" }).click();
}

export async function expectNoA11yViolations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations.map(
      (v) =>
        `${v.id}: ${v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(", ")}`,
    ),
  ).toEqual([]);
}

export const test = base;
export { expect };
