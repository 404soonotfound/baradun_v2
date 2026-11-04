// 운영자 로그인 고정값 (BRD-148·172, 결정 기록 D16-A3·A4·A5·E1, 아키텍처 18.2)

// 세션 시간: 활동 없이 60분이면 로그아웃, 최초 인증 8시간이 되면 연장 없이 다시 로그인, 둘 다 2분 전 경고
// access token(15분)은 만료 1분 전에 refresh token(회전)으로 갱신함
export const SESSION = {
  idleMs: 60 * 60 * 1000,
  maxMs: 8 * 60 * 60 * 1000,
  warnBeforeMs: 2 * 60 * 1000,
  refreshEarlyMs: 60 * 1000,
} as const;

// Cognito 사용자 풀 공개 엔드포인트(서울). 운영자 사이트 CSP connect-src와 같음(infra/lib/admin/admin-site.ts)
export const COGNITO_REGION = "ap-northeast-2";
export const COGNITO_ENDPOINT = `https://cognito-idp.${COGNITO_REGION}.amazonaws.com/`;

// 비밀번호 규칙 안내(D16-A4). 실제 검사는 Cognito 풀 정책이 함(infra operator-auth.ts)
export const PASSWORD_RULE = { minLength: 12, reuseBlocked: 5 } as const;

// 운영 API 토큰 헤더. services/src/admin/policy.ts ACCESS_TOKEN_HEADER와 같음
export const ACCESS_TOKEN_HEADER = "x-baradun-access-token";

// 탭 사이 로그인 채널 이름. 로그아웃 신호, 새 탭 넘겨받기, 갱신 토큰·활동 시각 나누기(2026-11-04 D16-A10 변경)
export const LOGOUT_CHANNEL = "baradun-admin-auth";
// 탭 사이 토큰 갱신 잠금 이름(Web Locks). refresh token 회전 유예가 0초라 한 탭씩 갱신
export const REFRESH_LOCK = "baradun-admin-refresh";
