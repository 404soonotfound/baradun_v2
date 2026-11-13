// 수집 정책값 (아키텍처 5·7장, 결정 기록 10장 N3·11장 10/22 BRD-18·BRD-56)
// 숫자를 코드 곳곳에 두지 않고 여기 한 곳에만 둠
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

export const COLLECT_POLICY = {
  // 실행 분(N3). 슬롯 = 이 격자에서 지금 이전의 가장 늦은 시각
  oceanSchedule: { periodMinutes: 30, offsetMinutes: 10 }, // :10/:40
  warningsSchedule: { periodMinutes: 15, offsetMinutes: 3 }, // :03/:18/:33/:48
  // 슬롯을 맡은 뒤 다른 실행이 다시 맡을 수 없는 시간. 같은 owner 재시도도 이 시간이 지나야 맡음(10/22 사용자 결정)
  // Lambda 시간 제한(PR ② infra에서 60초)보다 길게
  slotLeaseMs: 2 * MINUTE_MS,
  // 한 번 시도의 시간 제한과 다시 하는 횟수. 두 번 다 실패해도 Lambda 시간 제한 안에서 끝나게 함
  httpTimeoutMs: 10 * SECOND_MS,
  httpRetries: 1,
  httpRetryDelayMs: 1 * SECOND_MS, // 최악 10초 + 1초 + 10초 → Lambda 시간 제한(60초) 안

  // getPwnCd: 59일 범위를 한 번에(아키텍처 4장, 10/22 BRD-18). 받은 행이 70%를 넘으면 운영 알림
  pwncdLookbackDays: 59,
  pwncdNumOfRows: 10_000,
  pwncdRowAlertRatio: 0.7,
  // getTsunamiMsg: 제공 범위가 오늘 기준 3일 전까지(아키텍처 4장 10/20 실호출)
  tsunamiLookbackDays: 3,
  tsunamiNumOfRows: 100,

  // collect-rip: 시즌(6~9월) 중 :12/:42, 비수기 하루 1회 KST 04:12 = UTC 19:12(결정 기록 10장, BRD-57)
  // 일정은 연중 :12/:42로 돌고, 비수기에는 하루 1회 슬롯만 호출함(나머지는 호출 없이 끝냄)
  // 비수기 호출은 시즌 시작(자료가 다시 나오는지) 확인용
  ripSchedule: { periodMinutes: 30, offsetMinutes: 12 },
  ripOffSeasonSlotUtcMinutes: 19 * 60 + 12,
  // 한 해변 하루치(5분 간격 287건, 2026-10-26 실측)를 한 번에 받는 행 수. API 최댓값 300
  ripNumOfRows: 300,

  // collect-catalog: 하루 1회(D6) KST 04:20 = UTC 19:20. 대표 사진 공공누리 유형 다시 확인(BRD-58)
  catalogSchedule: { periodMinutes: 24 * 60, offsetMinutes: 19 * 60 + 20 },
  // 한 번에 보내는 요청 수. 사진 86곳 × 1회
  catalogConcurrency: 4,
  // detailImage2(상세 사진 목록)에서 한 번에 받는 행 수
  catalogImageNumOfRows: 100,
  // 이 시간이 지나면 새 요청을 보내지 않음(남은 해변은 이전 확인 결과 유지)
  // 마지막 요청이 최악 21초 걸려도 51초 → Lambda 시간 제한(60초) 안에서 저장까지 끝냄
  catalogBudgetMs: 30 * SECOND_MS,

  // collect-weather: 매시 :15(BRD-181, 결정 기록 18장 D18-1·D18-8)
  // 초단기실황 154격자 매시(+이번 시각 확인 1회) + 단기예보 154격자 하루 8회 + 중기 육상 8·기온 34 하루 2회
  // ≈ 하루 5,000회. 실황·단기는 같은 서비스(VilageFcstInfoService)라 합쳐 약 4,950회, 하루 10,000회 안
  weatherSchedule: { periodMinutes: 60, offsetMinutes: 15 },
  // 발표 뒤 받기까지 기다리는 분. 단기예보·초단기실황은 활용가이드 '발표 10분 뒤 제공'
  // 중기예보(06·18시)는 제공 시각 근거가 없어 1시간 여유(덜 기다려 '행 없음' 실패를 만들지 않게)
  weatherShortDelayMinutes: 10,
  weatherNowDelayMinutes: 10,
  weatherMidDelayMinutes: 60,
  // 한 번에 받는 행 수. 단기예보 02:00 발표 한 격자 944행(2026-11-05 실측), 초단기실황 8행
  weatherShortNumOfRows: 1000,
  weatherNowNumOfRows: 20,
  // 중기 육상·기온(구역 하나씩 요청)에서 한 번에 받는 행 수
  weatherMidNumOfRows: 10,
  // 한 번에 보내는 요청 수와 새 요청을 보내지 않는 시간(catalog와 같은 이유로 Lambda 60초 안)
  weatherConcurrency: 8,
  weatherBudgetMs: 30 * SECOND_MS,
  // 기상청 일시 오류(01 등)를 같은 실행에서 다시 받는 곳 수 상한(BRD-186). 평소 한 실행에 0~2곳
  // 전면 장애 때 매시 이만큼만 더 부름 → 하루 종일 이어져도 약 +480회로 하루 10,000회 안(평소 약 5,000회)
  weatherRetryMax: 20,
  // 기상청이 결측(-999)으로 주는 실황 격자 수가 이만큼 이상이면 실패로 봄(BRD-186)
  // 2026-11-05 실호출: 140격자 중 바다 쪽 1곳(삼척해수욕장 98,126)만 늘 결측
  weatherNowMissingMax: 10,
} as const;
