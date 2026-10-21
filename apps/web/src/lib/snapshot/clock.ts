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

// 계약 date-time(RFC 3339): 시간대(Z·±hh:mm)가 있어야 함. 없으면 Date.parse가 기기 현지 시각으로 읽어 KST·UTC가 섞임
const DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

// 존재하는 날짜·시각인지도 확인. Date.parse는 2월 30일·24시를 다음 날로 넘겨 읽어서 형식 검사만으로는 통과함
export function isTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number) as [number, number, number, number, number, number];
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  // 그 달의 마지막 날(다음 달 0일). Date.UTC는 0~99년을 1900년대로 읽어 setUTCFullYear로 연도를 그대로 넣음
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(year, month, 0);
  const daysInMonth = lastDay.getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

// 계약 형식 시각 → ms. 형식이 다르면(시간대 없음 등) NaN
function parseTime(value: string | null | undefined): number {
  return isTime(value) ? Date.parse(value) : NaN;
}

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
  const expiresMs = parseTime(expiresAt);
  // 지금 시각을 모르면(NaN) 만료로 봄. NaN 비교는 항상 false라 따로 막지 않으면 유효로 보임
  if (!Number.isFinite(expiresMs) || !Number.isFinite(nowMs)) return true;
  if (clock.trusted) return nowMs > expiresMs;
  return expiresMs - nowMs <= UNTRUSTED_MARGIN_MS;
}

// 다음에 만료 판정이 바뀌는 시각(보정된 시각, ms). 이 시각에 화면을 다시 계산함
export function expiryDeadline(
  expiresAt: string | null | undefined,
  clock: Clock,
): number | null {
  const expiresMs = parseTime(expiresAt);
  if (!Number.isFinite(expiresMs)) return null;
  // trusted: expiresMs를 1ms 넘긴 때, untrusted: 남은 시간이 정확히 5분이 되는 때
  return clock.trusted ? expiresMs + 1 : expiresMs - UNTRUSTED_MARGIN_MS;
}

// --- 시각 문구용 값 ---
// 문구 키({minutes}분 전 측정, {time} 발표, {time} 확인)에 넣을 값만 만듦. 문구는 use-time-text.ts가 붙임

// 한국 표준시 = UTC+9
const KST_OFFSET_MS = 9 * 60 * 60_000;

// "n분 전 측정"의 n. 지난 시간분을 분 단위로 내림(10분 59초 -> 10)
// 1분이 안됐거나 측정 시각이 조금 뒤(기기 보정 허용 : 2분 안)여도 1 - "0분 전" 음수를 보이지 않음
// 시각을 읽을 수 없거나 지금 시각을 모르면(NaN) null -> 화면은 시각 줄을 그리지 않음
export function minutesAgo(
  observedAt: string | null | undefined,
  nowMs: number,
): number | null {
  const observeMs = parseTime(observedAt);
  if (!Number.isFinite(observeMs) || !Number.isFinite(nowMs)) return null;
  return Math.max(1, Math.floor((nowMs - observeMs) / 60_000));
}

// ms -> 한국 시각 조각. 9시간 더한 뒤 UTC로 읽으면 한국의 날짜 시각이 나옴
// toISOString() = "2026-10-21T05:00.00.000Z" 꼴. slice(시작, 끝)으로 필요한 글자만 자름
function kstParts(ms: number) {
  const iso = new Date(ms + KST_OFFSET_MS).toISOString();
  return {
    day: iso.slice(0, 10), // 2026-10-21 (같은 날인지 비교용)
    month: iso.slice(5, 7), // 10
    date: iso.slice(8, 10), // 21
    hour: iso.slice(11, 13), // 14 (24시간제)
    minute: iso.slice(14, 16), // 05
  };
}

// 발표 확인 시각 글자. 한국 시각 기준 오늘이면 "14:05", 날짜가 다르면 "10/20 14:05" (한국어 영어 같은 규칙)
// 시각을 읽을 수 없거나 지금 시각을 모르면 null
export function kstStamp(
  at: string | null | undefined,
  nowMs: number,
): string | null {
  const atMs = parseTime(at);
  if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return null;
  const a = kstParts(atMs);
  const time = `${a.hour}:${a.minute}`;
  return a.day === kstParts(nowMs).day ? time : `${a.month}/${a.date} ${time}`;
}
