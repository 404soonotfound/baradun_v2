// API 키 읽기 인터페이스 (아키텍처 11장, BRD-56: API 키는 SSM에서 읽음)
// 수집기는 이 인터페이스만 씀. AWS SDK 호출은 ssm.ts 한 곳에만(17.2 이식성)
// 이름 규칙은 infra/lib/settings.ts의 API_KEY_PARAMETER_PREFIX와 같아야 함(services는 infra를 가져오지 않음)

export type ApiKeyName = "data-go-kr" | "kma-apihub";

export const API_KEY_PARAMETER_PREFIX = "/baradun/v2/api-keys/";

export function apiKeyParameterName(name: ApiKeyName): string {
  return `${API_KEY_PARAMETER_PREFIX}${name}`;
}

export interface ApiKeys {
  // 값이 없거나 빈 글자면 오류. 키 없이 호출해 실패를 '없음'으로 읽지 않게 함
  get(name: ApiKeyName): Promise<string>;
}
