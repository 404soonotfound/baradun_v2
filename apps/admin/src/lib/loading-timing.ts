// 로딩 시간 규칙 (GH-462, 결정 기록 D26-4 · 화면 설계서 6장 ADM-STATE · 캔버스 로딩 보드 L0·LS·LP)
// 0~150ms: 아무것도 바꾸지 않음 → 150ms: 자리표시 → 한 번 뜨면 최소 400ms 유지 → 5초: '평소보다 오래 걸려요'
// → 15초: 시간 제한(같은 칸 안에서 실패). 값 교체는 0.18초 페이드(globals.css .ld-fade)
// 시계·타이머를 밖에서 받아 단위 테스트에서 가짜 시계로 확인함

export const LOADING_TIMES = {
  delay: 150,
  minShown: 400,
  slow: 5_000,
  timeout: 15_000,
} as const;

// wait: 응답 기다림(150ms 전, 자리만 잡고 보이지 않음) · placeholder: 자리표시 보임 · content: 값(또는 실패)
export type LoadPhase = "wait" | "placeholder" | "content";

export interface LoadState {
  readonly phase: LoadPhase;
  // 5초 넘음
  readonly slow: boolean;
  // 15초 넘음. 칸은 실패 문구로 바꿈
  readonly timedOut: boolean;
  // 자리표시가 보였다가 값으로 바뀜 → 0.18초 페이드. 바로 온 값은 페이드 없이
  readonly fade: boolean;
}

export const CONTENT: LoadState = {
  phase: "content",
  slow: false,
  timedOut: false,
  fade: false,
};

export interface LoadClock {
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

export interface LoadTimer {
  // 요청 시작. visible이면 150ms를 기다리지 않고 바로 자리표시(첫 진입: 정적 HTML이 이미 자리표시를 그림)
  start(visible?: boolean): void;
  // 응답 도착(성공·실패 모두)
  finish(): void;
  dispose(): void;
}

export function createLoadTimer(
  clock: LoadClock,
  onChange: (state: LoadState) => void,
): LoadTimer {
  let state: LoadState = CONTENT;
  let shownAt = 0;
  let timers: unknown[] = [];

  const set = (next: Partial<LoadState>) => {
    state = { ...state, ...next };
    onChange(state);
  };
  const clear = () => {
    for (const handle of timers) clock.clearTimer(handle);
    timers = [];
  };
  const at = (ms: number, fn: () => void) => {
    timers.push(clock.setTimer(fn, ms));
  };
  const show = () => {
    shownAt = clock.now();
    set({ phase: "placeholder" });
  };

  return {
    start(visible = false) {
      clear();
      state = { phase: "wait", slow: false, timedOut: false, fade: false };
      if (visible) show();
      else {
        onChange(state);
        at(LOADING_TIMES.delay, show);
      }
      at(LOADING_TIMES.slow, () => set({ slow: true }));
      at(LOADING_TIMES.timeout, () => {
        clear();
        set({ phase: "content", slow: false, timedOut: true, fade: true });
      });
    },
    finish() {
      if (state.phase === "content") return;
      clear();
      if (state.phase === "wait") {
        // 150ms 안 응답: 자리표시 없이 바로 값
        set({ phase: "content", slow: false, fade: false });
        return;
      }
      const left = shownAt + LOADING_TIMES.minShown - clock.now();
      const done = () => set({ phase: "content", slow: false, fade: true });
      if (left <= 0) done();
      else at(left, done);
    },
    dispose: clear,
  };
}
