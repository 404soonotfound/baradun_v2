// 테스트 전용: 서명 없는 가짜 JWT(클레임 읽기만 확인). 실제 토큰·비밀값이 아님
export function fakeJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.sig`;
}

export function fakeAccess(overrides: Record<string, unknown> = {}): string {
  return fakeJwt({
    token_use: "access",
    sub: "operator-sub",
    exp: 1_700_000_900,
    auth_time: 1_700_000_000,
    "cognito:groups": ["publisher"],
    ...overrides,
  });
}
