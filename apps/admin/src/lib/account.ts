import { opsFetch, type OpsResult } from "./auth/ops-fetch";

// 내 계정의 '다른 운영자의 2단계 인증 초기화' (#335, D16-A9, 화면 설계서 6장 ADM-CONFIRM)
// 운영 API POST /ops/account/mfa-reset 응답(services/src/admin/mfa-reset.ts)을 화면 결과로 바꿈
// - 본인·없는 계정·이미 없음은 실패와 다른 결과로 보여 줌
// - 응답이 없거나 500이면 '초기화하지 못했을 수 있음'(서버가 지운 뒤 기록에서 실패했을 수도 있어 '그대로'라고 하지 않음)
//   다시 보내도 안전함: 이미 지워졌으면 두 번째는 '이미 없음'

export type MfaResetOutcome =
  | "reset"
  | "already_none"
  | "self"
  | "not_found"
  | "invalid_email"
  | "forbidden"
  // 로그인이 만료됨(토큰 없음·401). 서버가 업무 처리 전에 거부했으니 바뀐 것이 없음
  | "expired"
  | "unknown";

// 서버와 같은 모양 검사(services/src/admin/mfa-reset.ts EMAIL·EMAIL_MAX)
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_MAX = 254;

export function isEmail(value: string): boolean {
  return value.length <= EMAIL_MAX && EMAIL.test(value);
}

// 로그인 이메일은 대소문자를 가리지 않음(운영자 풀 signInCaseSensitive: false)
export const sameEmail = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

export function mfaResetOutcome(
  result: OpsResult<{ result?: unknown }>,
): MfaResetOutcome {
  if (result.ok) {
    return result.body?.result === "reset"
      ? "reset"
      : result.body?.result === "already_none"
        ? "already_none"
        : "unknown";
  }
  if (result.status === 0) {
    return result.code === "reauth" ? "expired" : "unknown";
  }
  if (result.status === 401) return "expired";
  if (result.status === 409 && result.reason === "self") return "self";
  // reason 없는 404는 경로가 없는 서버(배포 전)라 '없는 계정'으로 보이지 않게 함
  if (result.status === 404 && result.reason === "account") return "not_found";
  if (result.status === 400 && result.field === "email") return "invalid_email";
  if (result.status === 403) return "forbidden";
  return "unknown";
}

export async function resetOperatorMfa(
  email: string,
  accessToken: () => Promise<string | null>,
): Promise<MfaResetOutcome> {
  return mfaResetOutcome(
    await opsFetch<{ result?: unknown }>(
      "/ops/account/mfa-reset",
      accessToken,
      {
        method: "POST",
        body: { email },
      },
    ),
  );
}
