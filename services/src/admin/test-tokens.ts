import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { AuthConfig } from "./auth";

// 테스트 전용: 실제 Cognito 대신 이 파일이 만든 RSA 키로 서명한 토큰을 씀
// 검증기에는 공개 키(JWKS)를 cacheJwks로 넣어 네트워크 없이 서명·발급자·client_id·token_use를 실제로 검사함
// 실제 토큰·키는 넣지 않음(풀 ID·client ID도 가짜 값)

export const REGION = "ap-northeast-2";

export const TEST_CONFIG: AuthConfig = {
  operator: {
    userPoolId: `${REGION}_OperatorTst`,
    clientId: "operatorclient0000000000",
  },
  sample: {
    userPoolId: `${REGION}_SampleTest1`,
    clientId: "sampleclient000000000000",
  },
};

export interface TestKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwk: Record<string, unknown>;
}

export function newKey(kid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    kid,
    privateKey,
    jwk: {
      ...publicKey.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

export function issuer(userPoolId: string): string {
  return `https://cognito-idp.${REGION}.amazonaws.com/${userPoolId}`;
}

function b64(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function signToken(
  key: TestKey,
  payload: Record<string, unknown>,
): string {
  const head = b64({ alg: "RS256", kid: key.kid, typ: "JWT" });
  const body = b64(payload);
  const signature = createSign("RSA-SHA256")
    .update(`${head}.${body}`)
    .sign(key.privateKey)
    .toString("base64url");
  return `${head}.${body}.${signature}`;
}

// 기본값은 운영자 풀의 정상 access token. 필요한 클레임만 덮어씀
export function accessClaims(
  nowSec: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sub: "11111111-2222-3333-4444-555555555555",
    iss: issuer(TEST_CONFIG.operator.userPoolId),
    client_id: TEST_CONFIG.operator.clientId,
    token_use: "access",
    scope: "aws.cognito.signin.user.admin",
    auth_time: nowSec - 60,
    iat: nowSec - 60,
    exp: nowSec + 900,
    "cognito:groups": ["publisher"],
    ...overrides,
  };
}
