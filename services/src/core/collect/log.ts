// 수집 구조화 로그 (BRD-56: 로그 키 마스킹, 10/22 사용자 결정: 운영 알림은 지금은 로그만, 채널은 후속)
// 한 줄 JSON. 알림 대상은 level "warn"·"error"로 남겨 나중에 지표 필터로 잡음
// 받은 비밀값과 주소의 키 인자(authKey·serviceKey)는 출력 직전에 모두 가림

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;
export type Logger = (
  level: LogLevel,
  event: string,
  fields?: LogFields,
) => void;

const MASK = "***";
// 주소 안의 키 인자. 대소문자 섞임(ServiceKey)도 가림
const KEY_PARAM = /((?:authKey|serviceKey)=)[^&\s"]*/gi;

export function maskSecrets(text: string, secrets: readonly string[]): string {
  let masked = text.replace(KEY_PARAM, `$1${MASK}`);
  for (const secret of secrets) {
    if (secret === "") continue;
    masked = masked.split(secret).join(MASK);
    // 주소에 넣을 때 인코딩된 모양도 가림(data.go.kr 키는 + / = 를 담을 수 있음)
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) masked = masked.split(encoded).join(MASK);
  }
  return masked;
}

// secrets: 함수로 받음 → 키를 읽은 뒤에도 같은 로거가 가림
export function createLogger(
  secrets: () => readonly string[],
  write: (line: string) => void = (line) => console.log(line),
): Logger {
  return (level, event, fields = {}) => {
    const line = JSON.stringify({ level, event, ...fields });
    write(maskSecrets(line, secrets()));
  };
}
