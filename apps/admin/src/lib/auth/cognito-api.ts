import { COGNITO_ENDPOINT } from "./policy";

// Cognito 사용자 풀 공개 API 직접 부르기 (BRD-148, 결정 기록 D17-1)
// SRP 계산이 필요 없는 호출(토큰 갱신·폐기·비밀번호 찾기·변경·인증 앱 등록)은 라이브러리 없이 이 함수로 함
// 서명 없는 JSON 호출. 요청·응답 본문(비밀번호·토큰)은 로그에 남기지 않음

export class CognitoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CognitoError";
  }
}

export type Fetcher = typeof fetch;

export async function callCognito<T>(
  target: string,
  body: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(COGNITO_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `AWSCognitoIdentityProviderService.${target}`,
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new CognitoError("NetworkError", "network");
  }
  const text = await response.text();
  let value: Record<string, unknown> = {};
  try {
    value = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // 본문이 JSON이 아니면 아래에서 상태 코드로만 판단
  }
  if (!response.ok) {
    // __type 예: "NotAuthorizedException" 또는 "com.amazonaws...#NotAuthorizedException"
    const type = String(value.__type ?? value.code ?? "UnknownError");
    throw new CognitoError(
      type.split("#").pop() ?? type,
      String(value.message ?? ""),
    );
  }
  return value as T;
}

export interface AuthenticationResult {
  readonly AccessToken: string;
  readonly IdToken?: string;
  readonly RefreshToken?: string;
  readonly ExpiresIn?: number;
}

// 토큰 갱신(refresh 회전). 새 refresh token이 오면 그것을 쓰고, 예전 것은 Cognito가 바로 거부함(유예 0초)
export async function refreshTokens(
  clientId: string,
  refreshToken: string,
  fetcher?: Fetcher,
): Promise<AuthenticationResult> {
  const result = await callCognito<{
    AuthenticationResult?: AuthenticationResult;
  }>(
    "GetTokensFromRefreshToken",
    { ClientId: clientId, RefreshToken: refreshToken },
    fetcher,
  );
  if (!result.AuthenticationResult?.AccessToken) {
    throw new CognitoError("InvalidResponse", "no tokens");
  }
  return result.AuthenticationResult;
}

// 로그아웃 때 refresh token 폐기. 이미 받은 access token은 만료(최대 15분)까지 남을 수 있음(D16-A10)
export async function revokeRefreshToken(
  clientId: string,
  refreshToken: string,
  fetcher?: Fetcher,
): Promise<void> {
  await callCognito(
    "RevokeToken",
    { ClientId: clientId, Token: refreshToken },
    fetcher,
  );
}

export async function forgotPassword(
  clientId: string,
  email: string,
  fetcher?: Fetcher,
): Promise<void> {
  await callCognito(
    "ForgotPassword",
    { ClientId: clientId, Username: email },
    fetcher,
  );
}

export async function confirmForgotPassword(
  clientId: string,
  email: string,
  code: string,
  newPassword: string,
  fetcher?: Fetcher,
): Promise<void> {
  await callCognito(
    "ConfirmForgotPassword",
    {
      ClientId: clientId,
      Username: email,
      ConfirmationCode: code,
      Password: newPassword,
    },
    fetcher,
  );
}

export async function changePassword(
  accessToken: string,
  previous: string,
  next: string,
  fetcher?: Fetcher,
): Promise<void> {
  await callCognito(
    "ChangePassword",
    {
      AccessToken: accessToken,
      PreviousPassword: previous,
      ProposedPassword: next,
    },
    fetcher,
  );
}

// 내 계정에서 인증 앱 다시 등록: 새 키 받기 → 코드 확인. 확인이 끝나야 예전 인증 앱이 바뀜
export async function associateTotp(
  accessToken: string,
  fetcher?: Fetcher,
): Promise<string> {
  const result = await callCognito<{ SecretCode?: string }>(
    "AssociateSoftwareToken",
    { AccessToken: accessToken },
    fetcher,
  );
  if (!result.SecretCode)
    throw new CognitoError("InvalidResponse", "no secret");
  return result.SecretCode;
}

export async function verifyTotp(
  accessToken: string,
  code: string,
  fetcher?: Fetcher,
): Promise<void> {
  const result = await callCognito<{ Status?: string }>(
    "VerifySoftwareToken",
    {
      AccessToken: accessToken,
      UserCode: code,
      FriendlyDeviceName: "baradun-admin",
    },
    fetcher,
  );
  if (result.Status !== "SUCCESS") {
    throw new CognitoError("CodeMismatchException", "not verified");
  }
}

// 모든 기기에서 로그아웃: 이 계정의 refresh token을 모두 무효로 함. 이미 받은 access token은 만료까지 남음
export async function globalSignOut(
  accessToken: string,
  fetcher?: Fetcher,
): Promise<void> {
  await callCognito("GlobalSignOut", { AccessToken: accessToken }, fetcher);
}
