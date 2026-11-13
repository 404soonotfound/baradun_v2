"use client";

import { useEffect, useState } from "react";

// 응답이 10초를 넘기면 '응답이 늦어요' 안내(화면 설계서 6장 공통 시간, E1). 데이터 게시·내 계정이 함께 씀
export const SLOW_MS = 10_000;

// 기다리는 동안 SLOW_MS를 넘기면 true(이전 값은 그대로 보여 줌)
export function useSlow(waiting: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      window.clearTimeout(timer);
      setSlow(false);
    };
  }, [waiting]);
  return waiting && slow;
}
