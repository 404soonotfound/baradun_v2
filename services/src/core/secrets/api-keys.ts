// API 키 읽기 인터페이스 (아키텍처 11장, BRD-56: API 키는 SSM에서 읽음)
// 수집기는 이 인터페이스만 씀. AWS SDK 호출은 ssm.ts 한 곳에만(17.2 이식성)
// 이름 규칙은 infra/lib/settings.ts의 API_KEY_PARAMETER_PREFIX와 같아야 함(services는 infra를 가져오지 않음)

export const API_KEY_NAMES = ["data-go-kr", "kma-apihub"] as const;
export type ApiKeyName = (typeof API_KEY_NAMES)[number];

export const API_KEY_PARAMETER_PREFIX = "/baradun/v2/api-keys/";

export function apiKeyParameterName(name: ApiKeyName): string {
  return `${API_KEY_PARAMETER_PREFIX}${name}`;
}

export interface ApiKeys {
  // 값이 없거나 빈 글자면 오류. 키 없이 호출해 실패를 '없음'으로 읽지 않게 함
  get(name: ApiKeyName): Promise<string>;
}

// API 키 파라미터의 태그 읽기(운영 화면 데이터 출처: 등록 여부·만료일). 값은 읽지 않음
// 파라미터가 없으면 ApiKeyMissingError, 그 밖의 오류는 그대로 던짐. signal로 취소하면 요청을 멈춤
export interface ApiKeyTag {
  readonly Key?: string | undefined;
  readonly Value?: string | undefined;
}

export interface ApiKeyTags {
  tags(name: ApiKeyName, signal?: AbortSignal): Promise<readonly ApiKeyTag[]>;
}

export class ApiKeyMissingError extends Error {}
