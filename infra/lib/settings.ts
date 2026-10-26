import * as logs from "aws-cdk-lib/aws-logs";

// 여러 파일이 함께 쓰는 고정값. 값을 바꿀 때는 이 파일 한 곳만 고침.

// GitHub Actions 배포를 허락할 저장소와 environment (11장 가드레일)
// 2026-07-15 이후 만든 저장소는 OIDC 토큰의 sub에 숫자 ID가 붙음(GitHub 변경).
//   예전: repo:{owner}/{repo}:environment:{env}
//   지금: repo:{owner}@{ownerId}/{repo}@{repoId}:environment:{env}
// ID는 공개 정보임(비밀값 아님). 저장소 이름을 바꿔도 ID는 그대로임.
export const GITHUB_OWNER = "404soonotfound";
export const GITHUB_OWNER_ID = "202301114";
export const GITHUB_REPO_NAME = "baradun_v2";
export const GITHUB_REPO_ID = "1423369390";
export const DEPLOY_ENVIRONMENT = "production";

// 신뢰 정책이 받아 줄 sub 값 (글자 그대로 같아야 통과)
export const GITHUB_OIDC_SUBJECT = `repo:${GITHUB_OWNER}@${GITHUB_OWNER_ID}/${GITHUB_REPO_NAME}@${GITHUB_REPO_ID}:environment:${DEPLOY_ENVIRONMENT}`;

// 버킷 안에서 publisher만 쓰는 경로 (BRD-52). 나머지 경로는 사이트 파일임.
export const DATA_PREFIX = "data/";

// CloudWatch 로그 보존 기간 (10장: 3~7일, 아키텍처 0.1 확정값)
// 로그 그룹을 만드는 코드는 모두 이 값을 씀. 테스트가 다른 값을 막음.
export const LOG_RETENTION = logs.RetentionDays.ONE_WEEK;

// SSM Parameter Store에 둘 API 키 이름 규칙 (11장: Standard, 기본 키)
// 값은 CDK·저장소에 넣지 않고, 배포 전에 콘솔이나 CLI로 SecureString으로 직접 만듦.
// 예: /baradun/v2/api-keys/data-go-kr
export const API_KEY_PARAMETER_PREFIX = "/baradun/v2/api-keys/";
export const API_KEY_NAMES = ["data-go-kr", "kma-apihub"] as const;
export type ApiKeyName = (typeof API_KEY_NAMES)[number];

export function apiKeyParameterName(name: ApiKeyName): string {
  return `${API_KEY_PARAMETER_PREFIX}${name}`;
}

// 이 스택이 만드는 모든 역할의 권한 상한(permissions boundary) 정책 이름 (BRD-89)
// 정책은 스택 밖에서 bootstrap/role-boundary-policy.json으로 미리 만듦.
// 실행 정책(cfn-execution-policy.json)은 이 boundary가 붙은 역할만 만들고 고치게 허락함
export const ROLE_BOUNDARY_POLICY_NAME = "BaradunV2-RoleBoundary";

// 월 예산 알림 기준 (1장: 월 $0 목표, $1 알림). 알림만 보내고 과금을 막지는 않음.
export const MONTHLY_BUDGET_USD = 1;

// 재시도 상한 (11장: Scheduler·Lambda 재시도를 명시적으로 줄임)
// 5장 "재시도는 같은 슬롯 안에서": 가장 짧은 슬롯(특보 15분)보다 짧게 10분으로 끊음.
export const RETRY_LIMITS = {
  scheduleMaxRetries: 2,
  scheduleMaxEventAgeSeconds: 600,
  asyncMaxRetries: 1,
  asyncMaxEventAgeSeconds: 600,
} as const;

// 무료 범위 상한 (11장 기본값 함정)
export const MAX_ALARMS = 10;
export const MAX_DYNAMODB_CAPACITY_UNITS = 25; // 읽기·쓰기 각각, 모든 테이블·GSI 합계

// DynamoDB 테이블 용량 (7장 저장소 3개, 11장 Provisioned 고정·Auto Scaling 없음)
// 합계 읽기 11·쓰기 11 → 위 상한(25) 안. 테스트가 합계를 다시 확인함.
export const TABLE_CAPACITY = {
  state: { read: 5, write: 5 },
  ops: { read: 5, write: 5 },
  inquiry: { read: 1, write: 1 },
} as const;

// TTL 속성 이름 (Ops 슬롯 기록·Inquiry 문의 글 정리용)
// TTL은 오래된 항목을 지우는 용도만. 유효시간·신선도 판단에 쓰지 않음.
export const TTL_ATTRIBUTE = "ttl";

// 수집 Lambda 설정 (아키텍처 5장, BRD-56)

// 수집기 한 번 실행에 허락하는 최대 시간(초). 넘으면 AWS가 강제로 멈춤
// 왜 60초인지:
//   API 한 번 부르기는 최악 21초 걸림 = 첫 시도 10초에서 끊김 + 1초 쉼 + 다시 시도 10초에서 끊김
//   (services/src/collectors/policy.ts의 httpTimeoutMs 10초·httpRetryDelayMs 1초·httpRetries 1번)
//   API 두 곳은 동시에 부르므로 둘이어도 21초. 여기에 DynamoDB 읽기·쓰기를 더해도 60초면 충분
// 2분보다 짧아야 하는 이유:
//   수집기는 시작할 때 "이 시간대는 내가 함" 표시를 2분 동안 걸어 둠(policy.ts의 slotLeaseMs)
//   60초 안에 끝나면 표시가 풀리기 전에 일을 마침 → 같은 시간대를 두 실행이 동시에 하지 않음
export const COLLECTOR_TIMEOUT_SECONDS = 60;

// 수집기 메모리(MB). 특보 응답(가장 클 때 약 1MB 글자)을 읽기에 충분한 크기
// Lambda는 메모리를 늘리면 CPU도 함께 늘어남. 요금 = 메모리 × 실행 시간
export const COLLECTOR_MEMORY_MB = 256;

// 매시 몇 분에 실행할지(결정 기록 10장 N3). 쉼표로 여러 개
// 예: "10,40" → 매시 10분과 40분 = 30분마다
// services/src/collectors/policy.ts의 oceanSchedule·warningsSchedule과 같아야 함(collectors.test.ts가 확인)
// 한국 시각과 세계 표준시(UTC)는 정확히 9시간 차이 → "몇 분"은 어느 시간대로 봐도 같음
export const COLLECTOR_SCHEDULE_MINUTES = {
  ocean: "10,40", // 바다 관측: 매시 10분·40분(30분마다)
  warnings: "3,18,33,48", // 특보: 매시 3분·18분·33분·48분(15분마다)
} as const;

// collect-catalog 실행 시각(하루 1회, 아키텍처 5장 D6, BRD-58). 한국 시각 04:20
// 사진 확인은 급하지 않아 수집이 몰리지 않는 새벽으로 둠
// services policy.ts의 catalogSchedule(UTC 분 단위)과 같은 시각이어야 함(collectors.test.ts가 확인)
export const CATALOG_SCHEDULE_KST = { hour: "4", minute: "20" } as const;

// publish-snapshot Lambda 설정 (아키텍처 6.2, BRD-61 PR ②)
// 시간 제한은 게시 잠금(2분, services/src/publisher/policy.ts lockTtlMs)보다 짧게
// → 잠금이 풀리기 전에 실행이 끝나거나 강제로 멈춤. 잠금이 풀린 뒤 겹치는 경우는 manifest 조건부 쓰기가 막음
export const PUBLISHER_TIMEOUT_SECONDS = 60;
// 해변 약 200곳 분류·계약 검사·JSON 4개 쓰기. 수집기와 같은 크기
export const PUBLISHER_MEMORY_MB = 256;
