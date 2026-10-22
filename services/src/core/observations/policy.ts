import type { MetricKey } from "./values";

// 관측 신선도 정책값 (결정 기록 11장 B4·10/21·10/22 BRD-19, 아키텍처 2.2)
// 숫자를 코드 곳곳에 두지 않고 여기 한 곳에만 둠. 값을 바꾸면 version도 새로 올림
const MINUTE_MS = 60 * 1000;

export const OBSERVATION_POLICY = {
  version: "observations-1",
  // 관측 시각부터 값을 믿는 최대 시간. 넘으면 delayed
  // 파고만 분류에 영향(90분 초과 → 관측 지연). 나머지는 그 값만 숨김
  expiryMs: {
    waveHeight: 90 * MINUTE_MS,
    waterTemp: 90 * MINUTE_MS,
    wind: 90 * MINUTE_MS,
    wavePeriod: 60 * MINUTE_MS,
    waveDirection: 60 * MINUTE_MS, // 파주기와 같은 kma_buoy 관측(10/21)
  } satisfies Record<MetricKey, number>,
} as const;
