// 시계 보정 (아키텍처 9.1, BRD-41)
// 기기 시계가 틀리면 validUntil·"n분 전 측정"이 어긋나서, manifest 응답의 서버 시각과 비교해 보정함.
// 서버 시각 = Date 헤더 + Age 헤더(CDN 캐시에 머문 초). manifest는 60초 캐시라 Date만 쓰면 최대 1분 늦음

// 이 차이 안이면 보정하지 않음(기기 시계 그대로)
export const CLOCK_TOLERANCE_MS = 2 * 60_000;
// 서버 시각을 모를 때: 만료까지 이 시간 안 남은 정보는 만료로 봄(판단불가)
export const UNTRUSTED_MARGIN_MS = 5 * 60_000;

export interface Clock {
  // 서버 시각 - 기기 시각(ms). 2분 이내면 0
  offsetMs: number;
  // 서버 시각을 받았는지. false면 기기 시계를 그대로 쓰고 만료를 5분 앞당김
  trusted: boolean;
}

export const DEVICE_CLOCK: Clock = { offsetMs: 0, trusted: false };

export function clockFromHeaders(
  date: string | null,
  age: string | null,
  deviceNowMs: number,
): Clock {
  const dateMs = date ? Date.parse(date) : NaN;
  if (!Number.isFinite(dateMs)) return DEVICE_CLOCK;
  const ageSeconds = Number(age);
  const serverNowMs =
    dateMs +
    (Number.isFinite(ageSeconds) && ageSeconds > 0 ? ageSeconds * 1000 : 0);
  const diff = serverNowMs - deviceNowMs;
  return {
    offsetMs: Math.abs(diff) <= CLOCK_TOLERANCE_MS ? 0 : diff,
    trusted: true,
  };
}

export function correctedNow(clock: Clock, deviceNowMs: number): number {
  return deviceNowMs + clock.offsetMs;
}

// 만료 판정. 시각이 없거나 읽을 수 없으면 만료(모르는 건 판단불가).
// 서버 시각을 알면 만료 시각 "초과"부터 만료(파고 90:00은 아직 유효, 90:01부터 만료 — 아키텍처 14.1 경계값).
// 서버 시각을 모르면 남은 시간이 5분 이하일 때부터 만료.
export function isExpired(
  expiresAt: string | null | undefined,
  nowMs: number,
  clock: Clock,
): boolean {
  const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expiresMs)) return true;
  if (clock.trusted) return nowMs > expiresMs;
  return expiresMs - nowMs <= UNTRUSTED_MARGIN_MS;
}

// 다음에 만료 판정이 바뀌는 시각(보정된 시각, ms). 이 시각에 화면을 다시 계산함
export function expiryDeadline(
  expiresAt: string | null | undefined,
  clock: Clock,
): number | null {
  const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expiresMs)) return null;
  // trusted: expiresMs를 1ms 넘긴 때, untrusted: 남은 시간이 정확히 5분이 되는 때
  return clock.trusted ? expiresMs + 1 : expiresMs - UNTRUSTED_MARGIN_MS;
}
