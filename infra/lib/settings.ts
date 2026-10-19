import * as logs from "aws-cdk-lib/aws-logs";

// 여러 파일이 함께 쓰는 고정값. 값을 바꿀 때는 이 파일 한 곳만 고쳐요.

// GitHub Actions 배포를 허락할 저장소와 environment (11장 가드레일)
// 신뢰 정책 sub = repo:{GITHUB_REPO}:environment:{DEPLOY_ENVIRONMENT} 와 정확히 같아야 해요.
export const GITHUB_REPO = "404soonotfound/baradun_v2";
export const DEPLOY_ENVIRONMENT = "production";

// 버킷 안에서 publisher만 쓰는 경로 (BRD-52). 나머지 경로는 사이트 파일이에요.
export const DATA_PREFIX = "data/";

// CloudWatch 로그 보존 기간 (10장: 3~7일, 아키텍처 0.1 확정값)
// 로그 그룹을 만드는 코드는 모두 이 값을 써요. 테스트가 다른 값을 막아요.
export const LOG_RETENTION = logs.RetentionDays.ONE_WEEK;

// SSM Parameter Store에 둘 API 키 이름 규칙 (11장: Standard, 기본 키)
// 값은 CDK·저장소에 넣지 않고, 배포 전에 콘솔이나 CLI로 SecureString으로 직접 만들어요.
// 예: /baradun/v2/api-keys/data-go-kr
export const API_KEY_PARAMETER_PREFIX = "/baradun/v2/api-keys/";
export const API_KEY_NAMES = ["data-go-kr", "kma-apihub"] as const;
export type ApiKeyName = (typeof API_KEY_NAMES)[number];

export function apiKeyParameterName(name: ApiKeyName): string {
  return `${API_KEY_PARAMETER_PREFIX}${name}`;
}
