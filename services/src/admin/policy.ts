// 운영 API 고정값 (BRD-146, 결정 기록 D16-A3·A7·A8·B1·B2·B6·B7, 아키텍처 18.2·18.3)

// 최초 인증(auth_time)부터 8시간이 지나면 refresh로 받은 새 토큰이라도 거부함(A3)
// refresh rotation은 refresh마다 새 8시간을 주므로 Cognito만으로는 이 상한이 안 됨
export const OPS_SESSION_MAX_MS = 8 * 60 * 60 * 1000;

// 운영자 풀 그룹(아키텍처 18.2 보기 < 편집 < 노출 변경). infra settings.ts OPERATOR_GROUPS와 같은 이름
export const OPERATOR_ROLES = ["viewer", "editor", "publisher"] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

// 샘플 풀 그룹. infra settings.ts SAMPLE_GROUP과 같은 이름
export const SAMPLE_GROUP = "sample";

// 토큰을 받는 요청 헤더. Authorization은 CloudFront OAC가 함수 URL로 보낼 때 SigV4 서명에 씀
// → 뷰어의 토큰을 같은 헤더에 실으면 서명과 부딪혀서 따로 둠
export const ACCESS_TOKEN_HEADER = "x-baradun-access-token";

// 쓰기 요청의 멱등 키 헤더(값은 UUID v4, 쓰기마다 새로 만듦)
export const IDEMPOTENCY_KEY_HEADER = "x-idempotency-key";

// 같은 키·같은 내용의 재전송을 앞 결과로 돌려줄 기간. 지나면 TTL로 정리되고 새 요청으로 봄
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

// 멱등 키 형식: 화면이 쓰기마다 새로 만드는 UUID v4
export const IDEMPOTENCY_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
