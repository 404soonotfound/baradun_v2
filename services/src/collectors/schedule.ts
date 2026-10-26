import { KST_OFFSET_MS } from "../core/warnings/time";

// 슬롯·요청 시각 계산. 기상청 API의 시각 인자는 KST, 저장은 UTC(아키텍처 6.3)
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// 격자(주기·시작 분)에서 now 이전의 가장 늦은 시각(UTC ms). 예: 30분 주기·10분 → :10/:40
export function slotStart(
  nowMs: number,
  schedule: { periodMinutes: number; offsetMinutes: number },
): number {
  const periodMs = schedule.periodMinutes * MINUTE_MS;
  const offsetMs = schedule.offsetMinutes * MINUTE_MS;
  return Math.floor((nowMs - offsetMs) / periodMs) * periodMs + offsetMs;
}

const pad = (n: number) => String(n).padStart(2, "0");

// UTC ms → KST 벽시계 글자. "minute": yyyymmddHHMM(슬롯 id·관측 tm), "day": yyyymmdd(특보 fromTmFc·toTmFc)
export function formatKst(ms: number, unit: "minute" | "day"): string {
  const kst = new Date(ms + KST_OFFSET_MS); // KST 벽시계를 UTC 칸으로 읽음
  const day = `${kst.getUTCFullYear()}${pad(kst.getUTCMonth() + 1)}${pad(kst.getUTCDate())}`;
  return unit === "day"
    ? day
    : `${day}${pad(kst.getUTCHours())}${pad(kst.getUTCMinutes())}`;
}

// KST 날짜 기준 n일 전(요청 범위 시작)
export function kstDaysBefore(nowMs: number, days: number): string {
  return formatKst(nowMs - days * DAY_MS, "day");
}
