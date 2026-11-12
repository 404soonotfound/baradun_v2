import {
  WARNING_CONFIRMATION_TTL_MS,
  WARNING_POLICY_VERSION,
} from "@baradun/contracts/judgment-policy";

// 특보 판단 정책값 (아키텍처 2.1·14.3, 결정 기록 10장 N2·11장 10/22)
// 값은 웹과 같이 쓰도록 계약 패키지 한 곳에 둠(D20-5). 값을 바꾸면 version도 거기서 새로 올림
export const WARNING_POLICY = {
  version: WARNING_POLICY_VERSION,
  // 마지막 정상 전체 확인 뒤 '특보 없음'을 믿는 최대 시간. 15분 수집 3회분(N2)
  confirmationTtlMs: WARNING_CONFIRMATION_TTL_MS,
} as const;
