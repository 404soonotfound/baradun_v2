import { Duration } from "aws-cdk-lib";
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

// 경보 상한 및 과금 기준 (11장 기본값 함정, AWS CloudWatch 비용 절감 안내서)
// CloudWatch는 경보 개수가 아니라 '경보가 참조하는 표준 경보 지표 수'로 과금(수식 경보는 수식이 참조하는 지표마다 계산).
// 무료 범위: 표준 경보 지표 10개 (us-east-1 기준 초과 지표당 월 $0.10, 서울 리전 단가 미확인)
// 현재 경보 지표 수 계산(총 18개):
// - 오류 경보 5개: 5개 (수집기 4 + 게시 1, Errors)
// - 실행 없음 경보 4개: 4개 (특보·관측·이안류·게시 Invocations, FILL 수식 각 1지표)
// - 알림 발송 실패 경보 1개: 1개 (대기열 메시지 수)
// - 로그인 반복 요청 경보(LoginAbuse, D17-4): 5개 (풀 2 × [시도 1 + 성공 1] + 계정 복구 1) → 무료 초과 5개 × $0.10 ≈ 월 $0.50
// - 날씨 수집 계속 실패(WeatherFailing, BRD-181): 1개 (Errors) → 무료 초과 6개 × $0.10 ≈ 월 $0.60
// - 운영 API 오류 급증(OpsApiErrors, BRD-157·D17-7): 2개 (Url5xxCount 1 + AuthDenied 로그 지표 1) → 무료 초과 8개 × $0.10 ≈ 월 $0.80 (이번 경보 몫 +$0.20)
// - 문의 이메일 기한 초과(InquiryEmailOverdue, BRD-119): 2개 (EmailOverdue 로그 지표 1 + 정리 실패 대기열 1) → 무료 초과 10개 × $0.10 ≈ 월 $1.00 (월 $1 예산 안)
// 경보 리소스 자체의 개수 상한: 13 → 14(InquiryEmailOverdue 추가, BRD-119)
export const MAX_ALARMS = 14;

// 날씨 수집 계속 실패 경보(BRD-181). 1시간 구간에 오류가 있거나 실행이 없는 구간이 periods번 이어지면 울림
// 매시 한 번 도는 수집기라 한 번의 일부 실패(아직 안 나온 발표·시간 예산)는 다음 실행이 메움 → 3시간 이어질 때만 알림
// 단기예보는 발표 뒤 12시간까지 쓰므로 3시간 안에 알면 화면이 '확인하지 못했어요'가 되기 전에 고칠 수 있음
export const WEATHER_ALARM = { periodMinutes: 60, periods: 3 } as const;

// 로그인 반복 요청 감시 기준(D17-4, 운영자 1명 기준). 5분 동안 둘 중 하나라도 넘으면 알림
// - 로그인 실패: 운영자·데모 풀 합계(SignInSuccesses 표본 수 − 합계, 차단 요청 포함)
// - 계정 복구 API: 비밀번호 찾기·확인·변경·첫 로그인 새 비밀번호(계정 전체, AWS/Usage UserAccountRecovery)
export const LOGIN_ABUSE_ALARM = {
  periodMinutes: 5,
  signInFailures: 10,
  accountRecoveryCalls: 5,
} as const;

// 운영 API 5xx·권한 거부(401·403) 급증 경보 기준(D17-7, 출시 초기 운영자 소수 기준). 5분 동안 둘 중 하나라도 넘으면 알림
// - 5xx: Lambda 함수 URL Url5xxCount (Sum, 5분)
// - 권한 거부: 운영 API 로그 지표 필터(401·403에만 남는 ops_auth_denied 이벤트 수, Sum, 5분)
// 5xx 3회 또는 권한 거부 10회(5분 구간). 출시 초기 기본값으로 둠(검토한 대안: 5회·20회)
export const OPS_API_ALARM = {
  periodMinutes: 5,
  serverErrors: 3,
  authFailures: 10,
  metricNamespace: "Baradun/Ops",
  metricName: "AuthDenied",
} as const;

// 문의 이메일 기한 초과(89일 이상 남음) 경보 기준(BRD-119). 일일 정리 작업이 1건 이상 발견해 로그를 남기면 울림
export const INQUIRY_EMAIL_OVERDUE_ALARM = {
  periodMinutes: 5,
  metricNamespace: "Baradun/Inquiry",
  metricName: "EmailOverdue",
} as const;

// 문의 이메일 정리 일일 작업용 희소 GSI (BRD-119)
// 이름은 services/src/inquiry/policy.ts INQUIRY_EMAIL_INDEX_NAME과 같아야 함(tables.test.ts가 확인)
// KEYS_ONLY 투영으로 email 원문을 GSI에 넣지 않음. 용량 1/1 → 전체 13/13, 상한(25) 안
export const INQUIRY_EMAIL_INDEX = {
  name: "emailCleanupPartition-receivedAt",
  read: 1,
  write: 1,
} as const;
export const MAX_DYNAMODB_CAPACITY_UNITS = 25; // 읽기·쓰기 각각, 모든 테이블·GSI 합계

// DynamoDB 테이블 용량 (7장 저장소 3개, 11장 Provisioned 고정·Auto Scaling 없음)
// 합계 읽기 11·쓰기 11 → 위 상한(25) 안. 테스트가 합계를 다시 확인함.
export const TABLE_CAPACITY = {
  state: { read: 5, write: 5 },
  ops: { read: 5, write: 5 },
  inquiry: { read: 1, write: 1 },
} as const;

// 공지 파티션 키 (BRD-151). services/src/admin/keys.ts NOTICE_PK와 같아야 함(permissions.test.ts가 확인)
// 운영 API는 목록, publisher는 노출본 읽기에 이 파티션만 Query함
export const NOTICE_KEY = "admin#notice";

// 수집 실행 기록 파티션 키 앞부분 (BRD-149). services/src/core/collect/run-log.ts RUN_LOG_PREFIX와 같아야 함(permissions.test.ts가 확인)
// 수집 함수는 Ops PutItem으로 쓰고(기존 권한 안), 운영 API는 수집 현황 화면에서 이 파티션만 Query함
export const RUN_LOG_KEY_PREFIX = "collect#run#";

// 게시 요약 파티션 키 (BRD-187). services/src/core/collect/publish-summary.ts PUBLISH_SUMMARY_PK와 같아야 함(permissions.test.ts가 확인)
// publisher가 Ops PutItem으로 쓰고(기존 권한 안), 운영 API는 수집 현황 화면에서 이 파티션만 Query함
export const PUBLISH_SUMMARY_KEY = "publish#summary";

// 게시 실행 결과 파티션 키 (D16-C2, #331). services/src/core/collect/publish-summary.ts PUBLISH_RUN_PK와 같아야 함(permissions.test.ts가 확인)
// publisher가 Ops PutItem으로 쓰고(기존 권한 안), 운영 API는 데이터 게시 화면에서 실패한 실행 목록을 이 파티션만 Query함
export const PUBLISH_RUN_KEY = "publish#run";

// 문의 목록 GSI (결정 기록 D16-B4: 상태 + 접수 시각, 요약만 projection, BRD-153)
// 이름은 services/src/inquiry/policy.ts INQUIRY_STATUS_INDEX_NAME과 같아야 함(tables.test.ts가 확인)
// 용량 1/1 → 테이블 11/11 + GSI 1/1 = 12/12, 상한(25) 안. 목록 요약만이라 본문·이메일·사진 키는 넣지 않음
export const INQUIRY_STATUS_INDEX = {
  name: "inquiryStatus-receivedAt",
  read: 1,
  write: 1,
  projected: [
    "inquiryId",
    "inquiryType",
    "beachId",
    "activity",
    "version",
    "legacy",
    "ttl",
  ],
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
  // 이안류: 매시 12분·42분. 비수기에는 수집기가 하루 1회 슬롯(KST 04:12)만 호출하고 나머지는 바로 끝냄(BRD-57)
  rip: "12,42",
  // 날씨 예보: 매시 15분(BRD-181). 초단기실황 매시, 단기·중기는 새 발표가 있을 때만 수집기가 부름
  weather: "15",
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
// 게시 변경 미리보기 함수 제한 시간(#331). 운영 API는 8초만 기다리고(PREVIEW_WAIT_MS) 함수 제한은 10초라
// 그보다 오래 돌 이유가 없음. 늦은 실행이 계속 돌며 State 읽기 용량을 쓰지 않게 짧게 둠
export const PREVIEW_TIMEOUT_SECONDS = 10;

// 운영자 로그인 (BRD-145, 결정 기록 D16-A3, 아키텍처 18.2)
// 이름 앞부분 BaradunV2-는 실행 정책의 사용자 풀 Resource 범위가 아니라 콘솔에서 찾기 쉽게 붙임
// (사용자 풀 ARN은 생성 때 붙는 ID라 이름으로 범위를 좁힐 수 없음)
export const OPERATOR_POOL_NAME = "BaradunV2-Operators";
// 읽기 전용 샘플 계정만 두는 풀(D16-A7 실증 뒤 분리, 2026-11-03). MFA 없음
export const SAMPLE_POOL_NAME = "BaradunV2-Sample";

// 토큰 유효 시간(A3). 유휴 60분은 관리자 앱, 최초 인증 8시간은 운영 API가 따로 강제함
// refresh rotation을 켜면 새 refresh token이 다시 8시간을 받으므로 Cognito만으로는 8시간 상한이 안 됨
// 재전송 유예는 0초: 토큰을 메모리에만 두고 한 탭에서만 갱신함(A2). 갱신 응답을 놓치면 다시 로그인
export const OPERATOR_SESSION = {
  accessToken: Duration.minutes(15),
  idToken: Duration.minutes(15),
  refreshToken: Duration.hours(8),
  refreshRotationGrace: Duration.seconds(0),
} as const;

// 권한 그룹(아키텍처 18.2: 보기 < 편집 < 노출 변경 + 샘플). 이름은 토큰 cognito:groups 값이 됨
// 그룹 사이 포함 관계(편집이 보기를 포함하는지 등)는 운영 API의 허용표가 정함(BRD-146). 여기서는 이름만 둠
// 샘플 그룹은 샘플 풀에만 둠. 운영 API는 그룹 이름과 함께 발급 풀(iss)도 확인함
export const OPERATOR_GROUPS = [
  { id: "Viewer", name: "viewer", description: "보기" },
  { id: "Editor", name: "editor", description: "편집" },
  {
    id: "Publisher",
    name: "publisher",
    description: "노출 변경(공지 노출·지금 게시·되돌리기)",
  },
] as const;
export const SAMPLE_GROUP = {
  id: "Sample",
  name: "sample",
  description: "읽기 전용 시연 샘플",
} as const;
