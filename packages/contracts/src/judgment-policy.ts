// 판단 정책 상수 (결정 기록 D20-5~7, 아키텍처 14.1·14.3, #256)
// publisher(분류 계산)와 웹('특보 없음' 근거 검증·지표 만료)이 같은 값을 쓰도록 여기 한 곳에만 둠
// 값을 바꾸면 그 정책의 version을 올리고, POLICY_HISTORY 끝에 새 항목을 더함(minWebBuild도 함께 올림, D20-7)

const MINUTE_MS = 60 * 1000;

// 특보: 마지막 정상 전체 확인 뒤 '특보 없음'을 믿는 최대 시간. 15분 수집 3회분(N2)
export const WARNING_POLICY_VERSION = "warnings-1";
export const WARNING_CONFIRMATION_TTL_MS = 45 * MINUTE_MS;

// 관측: 관측 시각부터 값을 믿는 최대 시간. 파고만 분류에 영향(90분 초과 → 관측 지연), 나머지는 그 값만 숨김
// 파향은 파주기와 같은 kma_buoy 관측(10/21)
export const OBSERVATION_POLICY_VERSION = "observations-1";
export const METRIC_EXPIRY_MS = {
  waveHeight: 90 * MINUTE_MS,
  waterTemp: 90 * MINUTE_MS,
  wind: 90 * MINUTE_MS,
  wavePeriod: 60 * MINUTE_MS,
  waveDirection: 60 * MINUTE_MS,
} as const;

// manifest.policyVersion = 특보·관측 정책 버전(14.3)
export const POLICY_VERSION = `${WARNING_POLICY_VERSION}+${OBSERVATION_POLICY_VERSION}`;

// 정책 이력: 정책 버전과 그 정책 데이터를 처음 읽을 수 있는 화면 빌드(minWebBuild)
// - 마지막 항목이 지금 정책(POLICY_VERSION)이어야 하고, minWebBuild는 항목마다 커져야 함(시험이 확인)
// - 게시하는 manifest.minWebBuild는 마지막 항목의 minWebBuild 이상(옛 화면은 강제 업데이트 → 모르는 정책을 읽지 않음)
export const POLICY_HISTORY: readonly {
  readonly policyVersion: string;
  readonly minWebBuild: number;
}[] = [{ policyVersion: "warnings-1+observations-1", minWebBuild: 1 }];

// 웹이 읽을 수 있는 정책 버전: 지금 정책 하나뿐. 모르는 버전은 '지원하지 않는 데이터 형식'(판단불가, D20-6)
// 웹의 근거 검증(45·90·60분)은 지금 정책값만 알아서, 옛 정책으로 계산한 데이터를 새 기준으로 검증하지 않음
// (되돌리기도 지금 정책으로 새로 게시함, D20-1~3)
export const SUPPORTED_POLICY_VERSIONS: readonly string[] = [POLICY_VERSION];
