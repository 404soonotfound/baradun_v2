"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  CONTENT,
  createLoadTimer,
  type LoadState,
  type LoadTimer,
} from "@/lib/loading-timing";
import { messages } from "@/lib/messages";
import { pendingNavigation, subscribeNavigation } from "@/lib/navigation";

// 로딩 공통 부품 (GH-462, 캔버스 로딩 보드 L0 · LS · LP · L9 · L10 · L2D)
// - 자리표시: 값이 들어올 박스와 같은 너비·높이. 글자 줄은 글자 크기×0.72 높이(0.72em)라 줄 높이가 그대로 남음
//   배지는 같은 크기 회색 알약(정상·실패 색을 미리 보이지 않음). 모두 aria-hidden
// - 반짝임은 globals.css .sk(화면 전체가 한 번에 흐름, background-attachment: fixed · 1.6초). 색은 토큰만
// - 시간 규칙은 lib/loading-timing(150ms · 400ms · 5초 · 15초)

const t = messages.loading;

// 처음 화면(정적 HTML·첫 hydration)인지. 첫 진입은 세션 확인 동안 이미 자리표시가 보이므로 150ms를 기다리지 않음
// 공통 틀이 첫 그리기를 마치면 markFirstPaint로 끔 → 그 뒤 페이지 이동으로 연 화면은 150ms 규칙대로
let firstPaint = true;
export function markFirstPaint(): void {
  firstPaint = false;
}

const browserClock = {
  now: () => Date.now(),
  setTimer: (fn: () => void, ms: number) => window.setTimeout(fn, ms),
  clearTimer: (handle: unknown) => window.clearTimeout(handle as number),
};

// 칸 하나의 로딩 시간 상태. pending: 아직 값(또는 실패)을 받지 못함. 다시 읽기는 pending으로 두지 않음(값 유지)
export function useLoadTiming(pending: boolean): LoadState {
  const [state, setState] = useState<LoadState>(() =>
    pending
      ? {
          phase: firstPaint ? "placeholder" : "wait",
          slow: false,
          timedOut: false,
          fade: false,
        }
      : CONTENT,
  );
  const current = useRef(state);
  useEffect(() => {
    current.current = state;
  }, [state]);
  const timer = useRef<LoadTimer | null>(null);
  useEffect(() => {
    const created = createLoadTimer(browserClock, setState);
    timer.current = created;
    return () => {
      created.dispose();
      timer.current = null;
    };
  }, []);
  useEffect(() => {
    const created = timer.current;
    if (!created) return;
    // 이미 자리표시가 보이는 중이면(첫 진입) 그대로 이어서 셈
    if (pending) created.start(current.current.phase === "placeholder");
    else created.finish();
  }, [pending]);
  return state;
}

// 칸 바깥 요소에 붙일 클래스: 기다리는 동안(150ms 전) 자리표시를 숨기고, 값이 오면 0.18초 페이드
export function loadClass(state: LoadState): string {
  if (state.phase === "wait") return "sk-wait";
  if (state.phase === "content" && state.fade) return "ld-fade";
  return "";
}

// ---- 자리표시 ----
// 크기는 Tailwind 클래스(예: w-[79px] h-[9px])로만 받음. 운영 사이트 CSP가 style-src 'self'라
// 정적 HTML의 style 속성은 막혀 크기가 0이 되고 콘솔에 위반이 남음 → style 속성을 쓰지 않음

// 글자 줄: className에 너비(예상 길이). 높이는 둘레 글자 크기×0.72(작은 글자 줄은 h-[8px] 등으로 바꿈)
export function SkLine({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`sk inline-block h-[0.72em] rounded-admin-badge align-middle ${className}`}
    />
  );
}

// 배지: 같은 크기 회색 알약(조금 진한 면). 기본 36×20
export function SkPill({ className = "w-9 h-5" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`sk sk-strong inline-block shrink-0 rounded-admin-badge align-middle ${className}`}
    />
  );
}

// 버튼: 작은 버튼과 같은 높이(PC 36 · 모바일·태블릿 44). className에 너비
export function SkButton({ className = "w-22" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`sk inline-block h-touch shrink-0 rounded-admin-control align-middle lg:h-admin-control ${className}`}
    />
  );
}

// 박스: 값이 들어올 상자와 같은 크기. className에 높이(너비 기본 가득)
export function SkBox({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`sk block w-full rounded-admin-box ${className}`}
    />
  );
}

// 차트: 같은 크기에 가로 눈금선 + 낮은 면(값이 어떤 모양일지 미리 그리지 않음). className에 높이
export function SkChart({
  className,
  lines = 4,
}: {
  className: string;
  // 가로 눈금선 수
  lines?: number;
}) {
  return (
    <span aria-hidden="true" className={`relative block w-full ${className}`}>
      <span className="absolute inset-0 flex flex-col justify-between">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="block border-t border-border-default" />
        ))}
      </span>
      <span className="sk sk-area absolute inset-x-0 bottom-0 h-[34%]" />
    </span>
  );
}

// 도넛: 같은 지름의 고리. className에 지름(size-[120px]), 굵기는 [--sk-ring:16px](기본 12px)
export function SkDonut({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`sk sk-ring block shrink-0 rounded-full ${className}`}
    />
  );
}

// ---- 진행 표시 ----

// 작은 회전 표시(다시 읽기 13px · 진행 중 버튼 14px). 동작 줄이기면 멈춘 고리
export function Spinner({
  size = 13,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      className={`ld-spin shrink-0 ${className}`}
    >
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </svg>
  );
}

// 화면 읽기에 '○○ 불러오는 중'을 한 번. 끝나면 비움(포커스는 옮기지 않음)
// 알림 영역은 처음부터 두어야 바뀐 글이 읽힘 → 늘 그리고 글만 바꿈
export function LoadingStatus({
  busy,
  label,
}: {
  busy: boolean;
  // 화면·칸 이름(예: 운영 홈)
  label: string;
}) {
  return (
    <span role="status" className="sr-only">
      {busy ? label : ""}
    </span>
  );
}

// 시간 제한(15초) 뒤 같은 칸 안의 실패: 무슨 일 → 영향 → 다음 행동 + 다시 시도
export function LoadFailed({
  onRetry,
  className = "",
}: {
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`flex flex-col items-start gap-1 text-body-s ${className}`}
    >
      <p className="font-semibold text-text-default">{t.timeoutTitle}</p>
      <p className="text-text-body">{t.timeoutBody}</p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-touch items-center text-label-s font-medium text-brand-default underline underline-offset-2 lg:min-h-0"
      >
        {t.retry}
      </button>
    </div>
  );
}

// 5초 넘음: 칸 아래 안내(값이 오면 사라짐)
export function SlowNote({ className = "" }: { className?: string }) {
  return (
    <p className={`text-label-s text-text-muted ${className}`}>{t.slow}</p>
  );
}

// 페이지 이동: 본문 위 2px 진행 막대(150ms 뒤 시작, lib/navigation). 부모가 relative
export function NavProgress() {
  const pending = useSyncExternalStore(
    subscribeNavigation,
    pendingNavigation,
    () => null,
  );
  if (!pending?.visible) return null;
  return (
    <div
      role="progressbar"
      aria-label={t.page}
      className="ld-bar absolute top-0 left-0 z-20 h-0.5 rounded-r-[2px] bg-brand-default"
    />
  );
}
