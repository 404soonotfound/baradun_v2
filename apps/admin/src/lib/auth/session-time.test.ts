import { describe, expect, it } from "vitest";
import {
  nextWakeAt,
  secondsLeft,
  sessionPhase,
  sessionTimes,
} from "./session-time";

// 세션 시각 (BRD-148, D16-A3·E1)

const MIN = 60_000;
const AUTH = 1_000_000_000_000;
const clock = (lastActivityMs = AUTH, accessExpMs = AUTH + 15 * MIN) => ({
  authTimeMs: AUTH,
  accessExpMs,
  lastActivityMs,
});

describe("sessionTimes", () => {
  it("갱신은 access 만료 1분 전, 유휴는 활동 + 60분(58분 경고), 상한은 최초 인증 + 8시간(2분 전 경고)", () => {
    expect(sessionTimes(clock())).toEqual({
      refreshAt: AUTH + 14 * MIN,
      idleWarnAt: AUTH + 58 * MIN,
      idleEndAt: AUTH + 60 * MIN,
      maxWarnAt: AUTH + 478 * MIN,
      maxEndAt: AUTH + 480 * MIN,
    });
  });

  it("8시간 상한 뒤로는 갱신하지 않는다", () => {
    const late = sessionTimes(clock(AUTH + 470 * MIN, AUTH + 490 * MIN));
    expect(late.refreshAt).toBe(AUTH + 480 * MIN);
  });
});

describe("sessionPhase", () => {
  const times = sessionTimes(clock());
  it.each([
    [27 * MIN, "active"],
    [58 * MIN, "idle_warning"],
    [60 * MIN, "idle_expired"],
  ])("유휴: 인증 뒤 %ims → %s", (offset, phase) => {
    expect(sessionPhase(times, AUTH + offset)).toBe(phase);
  });

  it("활동해도 8시간은 늘지 않고, 상한 경고·끝이 유휴보다 먼저다", () => {
    const busy = sessionTimes(clock(AUTH + 479 * MIN));
    expect(sessionPhase(busy, AUTH + 478 * MIN)).toBe("max_warning");
    expect(sessionPhase(busy, AUTH + 480 * MIN)).toBe("max_expired");
  });
});

describe("nextWakeAt", () => {
  it("지금 이후 가장 이른 경계에 깬다", () => {
    const times = sessionTimes(clock());
    expect(nextWakeAt(times, AUTH)).toBe(AUTH + 14 * MIN);
    expect(nextWakeAt(times, AUTH + 14 * MIN + 1)).toBe(AUTH + 14 * MIN + 1); // 갱신이 밀림 → 지금 바로
  });

  it("남은 초는 내림하고 0 아래로 내려가지 않는다", () => {
    expect(secondsLeft(AUTH + 1999, AUTH)).toBe(1);
    expect(secondsLeft(AUTH, AUTH + 5)).toBe(0);
  });
});
