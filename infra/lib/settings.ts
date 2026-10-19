import * as logs from "aws-cdk-lib/aws-logs";

// 여러 파일이 함께 쓰는 고정값. 값을 바꿀 때는 이 파일 한 곳만 고쳐요.

// GitHub Actions 배포를 허락할 저장소와 environment (11장 가드레일)
// 2026-07-15 이후 만든 저장소는 OIDC 토큰의 sub에 숫자 ID가 붙어요(GitHub 변경).
//   예전: repo:{owner}/{repo}:environment:{env}
//   지금: repo:{owner}@{ownerId}/{repo}@{repoId}:environment:{env}
// ID는 공개 정보예요(비밀값 아님). 저장소 이름을 바꿔도 ID는 그대로예요.
export const GITHUB_OWNER = "404soonotfound";
export const GITHUB_OWNER_ID = "202301114";
export const GITHUB_REPO_NAME = "baradun_v2";
export const GITHUB_REPO_ID = "1423369390";
export const DEPLOY_ENVIRONMENT = "production";

// 신뢰 정책이 받아 줄 sub 값 (글자 그대로 같아야 통과)
export const GITHUB_OIDC_SUBJECT = `repo:${GITHUB_OWNER}@${GITHUB_OWNER_ID}/${GITHUB_REPO_NAME}@${GITHUB_REPO_ID}:environment:${DEPLOY_ENVIRONMENT}`;

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

// 월 예산 알림 기준 (1장: 월 $0 목표, $1 알림). 알림만 보내고 과금을 막지는 않아요.
export const MONTHLY_BUDGET_USD = 1;

// 재시도 상한 (11장: Scheduler·Lambda 재시도를 명시적으로 줄임)
// 5장 "재시도는 같은 슬롯 안에서": 가장 짧은 슬롯(특보 15분)보다 짧게 10분으로 끊어요.
export const RETRY_LIMITS = {
  scheduleMaxRetries: 2,
  scheduleMaxEventAgeSeconds: 600,
  asyncMaxRetries: 1,
  asyncMaxEventAgeSeconds: 600,
} as const;

// 무료 범위 상한 (11장 기본값 함정)
export const MAX_ALARMS = 10;
export const MAX_DYNAMODB_CAPACITY_UNITS = 25; // 읽기·쓰기 각각, 모든 테이블·GSI 합계
