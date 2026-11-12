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
// authTime: 최초 인증 시각(초). refresh 갱신 응답은 처음 로그인과 같은 값이어야 함
export function tokensFor(
  email: string,
  groups: string[],
  expIn = 900,
  authTime?: number,
) {
  const now = Math.floor(Date.now() / 1000);
  return {
    AccessToken: jwt({
      token_use: "access",
      sub: `sub-${email}`,
      exp: now + expIn,
      iat: now,
      auth_time: authTime ?? now,
      client_id: "test",
      username: email,
      "cognito:groups": groups,
    }),
    IdToken: jwt({
      token_use: "id",
      email,
      exp: now + 900,
      iat: now,
      auth_time: authTime ?? now,
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
  // 최초 인증 시각(초). refresh 갱신 응답과 맞출 때만
  authTime?: number;
}): CognitoHandler {
  const groups = options.groups ?? ["publisher"];
  const issue = () =>
    tokensFor(
      options.email,
      groups,
      options.expIn?.() ?? 900,
      options.authTime,
    );
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

const HOME_PARTS =
  /\/ops\/(collection|beaches\/published|inquiries|notices|audit)(\?.*)?$/;

export async function mockOps(
  page: Page,
  me: { status: number; body: unknown },
) {
  const calls: Record<string, string>[] = [];
  // 운영 홈(/)은 로그인하자마자 요약용 운영 API 5곳을 읽음(ADM-HOME). 다른 화면 시험의 가짜 응답·호출 수에
  // 섞이지 않게, 홈에서 나간 요청만 여기서 받고 그 밖은 원래 가짜 응답으로 넘김. 홈 시험은 이 뒤에 자기 응답을 둠
  await page.route(HOME_PARTS, async (route) => {
    if (new URL(route.request().frame().url()).pathname !== "/") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 501,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "e2e_unmocked", requestId: null },
      }),
    });
  });
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

// 운영 홈이 요약 읽기를 끝낼 때까지 기다림('할 일' 제목은 읽기가 끝나야 보임)
// 로그인한 뒤에 가짜 응답을 거는 시험이 홈 요청과 섞이지 않게 함
export async function expectHomeLoaded(page: Page) {
  await expect(
    page.getByRole("heading", { name: "할 일", level: 2 }),
  ).toBeVisible();
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

// 767px 이하는 메뉴가 서랍 안에 있음(BRD-171)
export function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768;
}

// 모바일은 먼저 앱 바의 메뉴 버튼으로 서랍을 엶
export async function openMenu(page: Page) {
  if (isMobile(page))
    await page.getByRole("button", { name: "메뉴 열기" }).click();
}

export async function logout(page: Page) {
  await openMenu(page);
  await page.getByRole("button", { name: "로그아웃" }).click();
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

// 모든 테스트에서 Trusted Types 위반이 없어야 함(BRD-180). 새 탭도 같은 컨텍스트라 함께 봄
// 위반은 콘솔 오류로, 정책·입력 지점이 던진 오류는 잡히지 않은 페이지 오류로 남음
const TRUSTED_TYPES_ERROR = /Trusted(HTML|Script)|trusted-types/i;
export const test = base.extend<{ trustedTypesGuard: void }>({
  trustedTypesGuard: [
    async ({ context }, use) => {
      const violations: string[] = [];
      context.on("console", (message) => {
        if (
          message.type() === "error" &&
          TRUSTED_TYPES_ERROR.test(message.text())
        ) {
          violations.push(message.text());
        }
      });
      context.on("weberror", (error) => {
        if (TRUSTED_TYPES_ERROR.test(error.error().message)) {
          violations.push(error.error().message);
        }
      });
      await use();
      expect(violations).toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };
