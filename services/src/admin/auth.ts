import { CognitoJwtVerifier } from "aws-jwt-verify";
import { FetchError, JwksValidationError } from "aws-jwt-verify/error";
import type { JwksCache } from "aws-jwt-verify/jwk";
import {
  OPERATOR_ROLES,
  OPS_SESSION_MAX_MS,
  SAMPLE_GROUP,
  type OperatorRole,
} from "./policy";
import type { SamplePolicy } from "./sample";

// 운영 API 토큰 검증 (D16-A3·A7·A8, 아키텍처 18.2)
// - access token만 받음: 서명·iss·client_id·token_use=access·exp는 aws-jwt-verify가 검사
// - 두 풀만 믿음. 발급자(iss)로 운영자 풀(MFA 필수)과 샘플 풀을 가름
//   운영자 풀은 MFA 필수라 그 풀이 발급한 토큰은 인증 앱을 거친 것(2026-11-03 실증: amr 없음 → 풀 분리)
// - 최초 인증(auth_time)부터 8시간이 지나면 거부. auth_time이 없거나 숫자가 아니면 거부
// - 역할이 불명확하면(운영자 그룹이 0개·2개 이상, 샘플 그룹 섞임) 보기로 낮추지 않고 거부
// - 샘플은 sub 허용 목록·허용 기간을 서버 설정(Ops 테이블)으로 다시 검사. 요청 본문·헤더의 값은 믿지 않음

export interface PoolConfig {
  readonly userPoolId: string;
  readonly clientId: string;
}

export interface AuthConfig {
  readonly operator: PoolConfig;
  readonly sample: PoolConfig;
}

export type Principal =
  | {
      readonly kind: "operator";
      readonly sub: string;
      readonly role: OperatorRole;
      readonly authTime: number;
    }
  | {
      readonly kind: "sample";
      readonly sub: string;
      readonly authTime: number;
    };

export type AuthFailure =
  | "missing_token"
  | "invalid_token"
  | "session_expired"
  | "role_unclear"
  | "sample_not_allowed";

export type AuthResult =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly reason: AuthFailure };

// 검증된 토큰 내용 중 이 파일이 쓰는 것만
interface VerifiedClaims {
  readonly iss: string;
  readonly sub: string;
  readonly auth_time?: unknown;
  readonly "cognito:groups"?: unknown;
}

export interface TokenVerifier {
  verify(token: string): Promise<object>;
}

// 두 풀의 access token만 믿는 검증기. JWKS는 처음 쓸 때 받아 함수 실행 동안 캐시함
// jwksCache는 테스트가 네트워크 없이 공개 키만 넣으려고 바꿔 끼움
export function createTokenVerifier(config: AuthConfig, jwksCache?: JwksCache) {
  return CognitoJwtVerifier.create(
    [
      { ...config.operator, tokenUse: "access" },
      { ...config.sample, tokenUse: "access" },
    ],
    jwksCache ? { jwksCache } : undefined,
  );
}

// iss = https://cognito-idp.{region}.amazonaws.com/{userPoolId}
function poolIdOf(iss: string): string | undefined {
  return iss.split("/").pop();
}

function groupsOf(claims: VerifiedClaims): string[] {
  const groups = claims["cognito:groups"];
  return Array.isArray(groups) && groups.every((g) => typeof g === "string")
    ? groups
    : [];
}

export interface AuthDependencies {
  readonly config: AuthConfig;
  readonly verifier: TokenVerifier;
  readonly samplePolicy: () => Promise<SamplePolicy | null>;
  readonly now: () => Date;
}

export async function authenticate(
  token: string | undefined,
  deps: AuthDependencies,
): Promise<AuthResult> {
  if (!token) return { ok: false, reason: "missing_token" };

  let claims: VerifiedClaims;
  try {
    claims = (await deps.verifier.verify(token)) as VerifiedClaims;
  } catch (error) {
    // 공개 키(JWKS)를 받지 못했거나 받은 키 목록이 깨진 것은 토큰 문제가 아니라 장애 → 던져서 500
    // (401로 바꾸면 관리자 앱이 로그아웃시키고 운영 로그에도 장애가 거부로만 남음)
    if (error instanceof FetchError || error instanceof JwksValidationError) {
      throw error;
    }
    // 서명·만료·발급자·client_id·token_use 실패를 한 가지로 돌려줌(어느 검사에서 막혔는지 알려 주지 않음)
    return { ok: false, reason: "invalid_token" };
  }

  const authTime = claims.auth_time;
  if (typeof authTime !== "number" || !Number.isFinite(authTime)) {
    return { ok: false, reason: "invalid_token" };
  }
  const nowMs = deps.now().getTime();
  // 미래의 auth_time은 시계가 어긋났거나 위조된 값이라 거부
  if (authTime * 1000 > nowMs + 60_000) {
    return { ok: false, reason: "invalid_token" };
  }
  if (nowMs - authTime * 1000 >= OPS_SESSION_MAX_MS) {
    return { ok: false, reason: "session_expired" };
  }

  const groups = groupsOf(claims);
  const poolId = poolIdOf(claims.iss);

  if (poolId === deps.config.operator.userPoolId) {
    const roles = OPERATOR_ROLES.filter((role) => groups.includes(role));
    if (roles.length !== 1 || groups.includes(SAMPLE_GROUP)) {
      return { ok: false, reason: "role_unclear" };
    }
    return {
      ok: true,
      principal: {
        kind: "operator",
        sub: claims.sub,
        role: roles[0]!,
        authTime,
      },
    };
  }

  if (poolId === deps.config.sample.userPoolId) {
    if (groups.length !== 1 || groups[0] !== SAMPLE_GROUP) {
      return { ok: false, reason: "role_unclear" };
    }
    const policy = await deps.samplePolicy();
    if (!policy || !allowsSample(policy, claims.sub, deps.now())) {
      return { ok: false, reason: "sample_not_allowed" };
    }
    return {
      ok: true,
      principal: { kind: "sample", sub: claims.sub, authTime },
    };
  }

  // 검증기가 두 풀만 믿으므로 여기 오면 설정이 어긋난 것
  return { ok: false, reason: "invalid_token" };
}

// 허용 기간은 시작 포함·끝 제외(I09와 같은 경계)
export function allowsSample(
  policy: SamplePolicy,
  sub: string,
  now: Date,
): boolean {
  const t = now.getTime();
  return (
    policy.subs.includes(sub) &&
    t >= policy.allowedFrom.getTime() &&
    t < policy.allowedUntil.getTime()
  );
}
