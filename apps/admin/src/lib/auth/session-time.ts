import { SESSION } from "./policy";

// 세션 시각 계산 (BRD-148, D16-A3·E1). 시계·타이머 없이 순수 계산만 둠(테스트 대상)
// - 갱신: access 만료 1분 전. 단, 8시간 상한 뒤로는 갱신하지 않음
// - 유휴: 마지막 활동 + 30분에 끝, 2분 전 경고
// - 상한: 최초 인증(auth_time) + 8시간에 끝, 2분 전 경고. 활동해도 늘지 않음

export interface SessionClock {
  readonly authTimeMs: number;
  readonly accessExpMs: number;
  readonly lastActivityMs: number;
}

export interface SessionTimes {
  readonly refreshAt: number;
  readonly idleWarnAt: number;
  readonly idleEndAt: number;
  readonly maxWarnAt: number;
  readonly maxEndAt: number;
}

export type SessionPhase =
  "active" | "idle_warning" | "max_warning" | "idle_expired" | "max_expired";

export function sessionTimes(clock: SessionClock): SessionTimes {
  const maxEndAt = clock.authTimeMs + SESSION.maxMs;
  const idleEndAt = clock.lastActivityMs + SESSION.idleMs;
  return {
    refreshAt: Math.min(clock.accessExpMs - SESSION.refreshEarlyMs, maxEndAt),
    idleWarnAt: idleEndAt - SESSION.warnBeforeMs,
    idleEndAt,
    maxWarnAt: maxEndAt - SESSION.warnBeforeMs,
    maxEndAt,
  };
}

// 상한이 먼저(연장할 수 없으므로 '계속 쓰기'로 풀리지 않는 경고를 앞에 둠)
export function sessionPhase(times: SessionTimes, nowMs: number): SessionPhase {
  if (nowMs >= times.maxEndAt) return "max_expired";
  if (nowMs >= times.idleEndAt) return "idle_expired";
  if (nowMs >= times.maxWarnAt) return "max_warning";
  if (nowMs >= times.idleWarnAt) return "idle_warning";
  return "active";
}

// 다음에 깨어날 시각: 지금 이후의 경계 중 가장 이른 것. 갱신 시각이 지났으면 지금 바로
export function nextWakeAt(times: SessionTimes, nowMs: number): number {
  const future = [
    times.refreshAt,
    times.idleWarnAt,
    times.idleEndAt,
    times.maxWarnAt,
    times.maxEndAt,
  ].filter((t) => t > nowMs);
  if (times.refreshAt <= nowMs && times.refreshAt < times.maxEndAt) {
    return nowMs;
  }
  return future.length > 0 ? Math.min(...future) : nowMs;
}

// 경고·종료 화면에 보여 줄 남은 초(내림)
export function secondsLeft(endAt: number, nowMs: number): number {
  return Math.max(0, Math.floor((endAt - nowMs) / 1000));
}
