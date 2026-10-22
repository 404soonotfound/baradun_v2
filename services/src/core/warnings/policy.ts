// 특보 판단 정책값 (아키텍처 2.1·14.3, 결정 기록 10장 N2·11장 10/22)
// 숫자를 코드 곳곳에 두지 않고 여기 한 곳에만 둠. 값을 바꾸면 version도 새로 올림
export const WARNING_POLICY = {
  version: "warnings-1",
  // 마지막 정상 전체 확인 뒤 '특보 없음'을 믿는 최대 시간. 15분 수집 3회분(N2)
  confirmationTtlMs: 45 * 60 * 1000,
} as const;
