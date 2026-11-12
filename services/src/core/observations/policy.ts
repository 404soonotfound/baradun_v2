import {
  METRIC_EXPIRY_MS,
  OBSERVATION_POLICY_VERSION,
} from "@baradun/contracts/judgment-policy";
import type { MetricKey } from "./values";

// 관측 신선도 정책값 (결정 기록 11장 B4·10/21·10/22 BRD-19, 아키텍처 2.2)
// 값은 웹과 같이 쓰도록 계약 패키지 한 곳에 둠(D20-5). 값을 바꾸면 version도 거기서 새로 올림
export const OBSERVATION_POLICY = {
  version: OBSERVATION_POLICY_VERSION,
  // 관측 시각부터 값을 믿는 최대 시간. 넘으면 delayed
  // 파고만 분류에 영향(90분 초과 → 관측 지연). 나머지는 그 값만 숨김
  expiryMs: METRIC_EXPIRY_MS satisfies Record<MetricKey, number>,
} as const;
