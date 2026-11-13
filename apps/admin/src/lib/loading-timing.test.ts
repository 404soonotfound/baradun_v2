import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLoadTimer,
  LOADING_TIMES,
  type LoadState,
} from "./loading-timing";

// 로딩 시간 규칙(D26-4, 보드 L0·LP): 150ms · 400ms · 5초 · 15초

function setup() {
  const states: LoadState[] = [];
  const timer = createLoadTimer(
    {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    (s) => states.push(s),
  );
  const last = () => states.at(-1);
  return { timer, states, last };
}

describe("createLoadTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("150ms 안 응답이면 자리표시를 한 번도 보이지 않고 페이드 없이 값으로 바꿈", () => {
    const { timer, states, last } = setup();
    timer.start();
    expect(last()?.phase).toBe("wait");
    vi.advanceTimersByTime(149);
    timer.finish();
    expect(states.some((s) => s.phase === "placeholder")).toBe(false);
    expect(last()).toMatchObject({ phase: "content", fade: false });
    // 남은 타이머가 나중에 자리표시·느림을 켜지 않음
    vi.advanceTimersByTime(LOADING_TIMES.timeout);
    expect(states.some((s) => s.phase === "placeholder")).toBe(false);
    expect(last()).toMatchObject({ slow: false, timedOut: false });
  });

  it("150ms가 지나면 자리표시를 보임", () => {
    const { timer, last } = setup();
    timer.start();
    vi.advanceTimersByTime(150);
    expect(last()?.phase).toBe("placeholder");
  });

  it("자리표시가 보였으면 최소 400ms 유지한 뒤 페이드로 값", () => {
    const { timer, last } = setup();
    timer.start();
    vi.advanceTimersByTime(150 + 100);
    timer.finish();
    expect(last()?.phase).toBe("placeholder");
    vi.advanceTimersByTime(299);
    expect(last()?.phase).toBe("placeholder");
    vi.advanceTimersByTime(1);
    expect(last()).toMatchObject({ phase: "content", fade: true });
  });

  it("400ms를 넘겨 온 응답은 바로 바꿈", () => {
    const { timer, last } = setup();
    timer.start();
    vi.advanceTimersByTime(150 + 500);
    timer.finish();
    expect(last()).toMatchObject({ phase: "content", fade: true });
  });

  it("5초가 지나면 느림 안내, 응답이 오면 끔", () => {
    const { timer, last } = setup();
    timer.start();
    vi.advanceTimersByTime(4_999);
    expect(last()?.slow).toBe(false);
    vi.advanceTimersByTime(1);
    expect(last()).toMatchObject({ phase: "placeholder", slow: true });
    timer.finish();
    expect(last()).toMatchObject({ phase: "content", slow: false });
  });

  it("15초가 지나면 시간 제한으로 실패, 늦게 온 응답은 무시", () => {
    const { timer, states, last } = setup();
    timer.start();
    vi.advanceTimersByTime(14_999);
    expect(last()?.timedOut).toBe(false);
    vi.advanceTimersByTime(1);
    expect(last()).toMatchObject({ phase: "content", timedOut: true });
    const count = states.length;
    timer.finish();
    expect(states.length).toBe(count);
  });

  it("다시 시도하면 시간 제한 상태를 지우고 처음부터", () => {
    const { timer, last } = setup();
    timer.start();
    vi.advanceTimersByTime(15_000);
    timer.start();
    expect(last()).toMatchObject({ phase: "wait", timedOut: false });
  });

  it("첫 진입(visible)은 바로 자리표시, 최소 유지 시간은 그때부터 셈", () => {
    const { timer, last } = setup();
    timer.start(true);
    expect(last()?.phase).toBe("placeholder");
    vi.advanceTimersByTime(100);
    timer.finish();
    expect(last()?.phase).toBe("placeholder");
    vi.advanceTimersByTime(300);
    expect(last()).toMatchObject({ phase: "content", fade: true });
  });

  it("dispose 뒤에는 상태를 바꾸지 않음", () => {
    const { timer, states } = setup();
    timer.start();
    const count = states.length;
    timer.dispose();
    vi.advanceTimersByTime(LOADING_TIMES.timeout);
    expect(states.length).toBe(count);
  });
});
