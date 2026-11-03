// Cognito 오류 → 화면 사유 (BRD-148, D16-A5)
// - 잠금은 남은 시간·횟수를 추정해 보여 주지 않고 '잠시 뒤 다시 시도'로만 안내
// - 계정이 있는지 드러내지 않음(풀 설정 preventUserExistenceErrors + 같은 문구)
// - 모르는 오류는 '잠시 뒤 다시 시도'가 아니라 '알 수 없는 오류'로 두어 원인을 숨기지 않음(오류 이름은 화면에 쓰지 않음)

export type AuthFailure =
  | "wrong_credentials"
  | "locked"
  | "code_mismatch"
  | "code_expired"
  | "password_rule"
  | "password_reused"
  | "reset_required"
  | "limit_exceeded"
  | "session_expired"
  | "network"
  | "unknown";

export function authFailureOf(error: unknown): AuthFailure {
  const code =
    typeof error === "object" && error !== null
      ? String(
          (error as { code?: unknown }).code ??
            (error as { name?: unknown }).name ??
            "",
        )
      : "";
  const message =
    typeof error === "object" && error !== null
      ? String((error as { message?: unknown }).message ?? "")
      : "";
  switch (code) {
    case "NotAuthorizedException":
      // 잠금도 같은 이름으로 옴(메시지로만 구분). 세션 만료(챌린지 3분 초과)도 이 이름
      if (/attempts exceeded/i.test(message)) return "locked";
      if (/session is expired|invalid session/i.test(message)) {
        return "session_expired";
      }
      return "wrong_credentials";
    case "UserNotFoundException":
      return "wrong_credentials";
    case "CodeMismatchException":
    case "EnableSoftwareTokenMFAException":
      return "code_mismatch";
    case "ExpiredCodeException":
      return "code_expired";
    case "InvalidPasswordException":
      return /previous|history|reuse/i.test(message)
        ? "password_reused"
        : "password_rule";
    case "PasswordHistoryPolicyViolationException":
      return "password_reused";
    case "PasswordResetRequiredException":
      return "reset_required";
    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException":
      return "limit_exceeded";
    case "NetworkError":
      return "network";
    default:
      return "unknown";
  }
}
