"use client";

import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/cn";

const PULL_THRESHOLD = 56;
const MAX_PULL = 84;

export interface PullToRefreshProps {
  refreshing: boolean;
  onRefresh: () => void;
  children: ReactNode;
  className?: string;
}

// 화면 맨 위에서 아래로 당겨 새로고침하는 래퍼(L16, BRD-137)
// 동작 줄이기(useReducedMotion)일 때는 당김 이동·회전 애니메이션 없이 문구만 표시함
export function PullToRefresh({
  refreshing,
  onRefresh,
  children,
  className,
}: PullToRefreshProps) {
  const t = useTranslations();
  const reducedMotion = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef<number | null>(null);
  const pullRef = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);

  // React의 onTouchMove는 passive 리스너라 기본 당겨서 새로고침을 막을 수 없어 non-passive 리스너를 따로 둠
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function onNativeTouchMove(e: TouchEvent) {
      if (startYRef.current === null || refreshing || window.scrollY > 0) return;
      const y = e.touches[0]?.clientY;
      if (y !== undefined && y > startYRef.current && e.cancelable) {
        e.preventDefault();
      }
    }
    el.addEventListener("touchmove", onNativeTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onNativeTouchMove);
  }, [refreshing]);

  function resetPull() {
    startYRef.current = null;
    pullRef.current = 0;
    setPullDistance(0);
  }

  function shouldIgnoreTouch(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    // 열린 시트·대화상자·지도 영역 안의 스와이프는 당김 새로고침에서 제외함
    if (
      target.closest(
        "dialog[open], [role='dialog'], .maplibregl-map, [data-pull-ignore]",
      )
    ) {
      return true;
    }
    let el: Element | null = target;
    while (el && el !== containerRef.current) {
      const { overflowY } = getComputedStyle(el);
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight &&
        el.scrollTop > 0
      ) {
        return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  function handleTouchStart(e: React.TouchEvent<HTMLDivElement>) {
    if (refreshing || window.scrollY > 0 || shouldIgnoreTouch(e.target)) return;
    const y = e.touches[0]?.clientY;
    if (y === undefined) return;
    startYRef.current = y;
  }

  function handleTouchMove(e: React.TouchEvent<HTMLDivElement>) {
    if (startYRef.current === null || refreshing) return;
    if (window.scrollY > 0) {
      resetPull();
      return;
    }
    const y = e.touches[0]?.clientY;
    if (y === undefined) return;
    const delta = y - startYRef.current;
    if (delta <= 0) {
      resetPull();
      return;
    }
    const nextPull = Math.min(MAX_PULL, Math.round(delta * 0.5));
    pullRef.current = nextPull;
    setPullDistance(nextPull);
  }

  function handleTouchEnd() {
    if (startYRef.current === null) return;
    const pulled = pullRef.current;
    resetPull();
    if (pulled >= PULL_THRESHOLD && !refreshing) {
      onRefresh();
    }
  }

  const showIndicator = refreshing || pullDistance > 8;
  const readyToRelease = pullDistance >= PULL_THRESHOLD;
  const statusText = refreshing
    ? t("refresh.refreshing")
    : readyToRelease
      ? t("refresh.release")
      : t("refresh.pull");

  return (
    <div
      ref={containerRef}
      className={className}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={resetPull}
    >
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "flex items-center justify-center gap-2 overflow-hidden text-caption text-text-muted",
          !reducedMotion && "transition-[height,opacity] duration-150",
          showIndicator ? "h-10 opacity-100" : "h-0 opacity-0",
        )}
      >
        {showIndicator && (
          <>
            <RefreshCw
              className={cn(
                "size-4 shrink-0",
                refreshing && !reducedMotion && "animate-spin",
              )}
              aria-hidden="true"
            />
            <span>{statusText}</span>
          </>
        )}
      </div>
      <div
        style={
          !reducedMotion && pullDistance > 0
            ? { transform: `translateY(${pullDistance}px)` }
            : undefined
        }
        className={
          !reducedMotion && pullDistance === 0
            ? "transition-transform duration-150"
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}

export interface RefreshButtonProps {
  refreshing: boolean;
  onRefresh: () => void;
  className?: string;
}

// 키보드·스크린 리더·데스크톱 사용자용 새로고침 버튼(L16, BRD-137)
export function RefreshButton({
  refreshing,
  onRefresh,
  className,
}: RefreshButtonProps) {
  const t = useTranslations();
  const reducedMotion = useReducedMotion();

  return (
    <button
      type="button"
      aria-busy={refreshing}
      aria-label={refreshing ? t("refresh.refreshing") : t("refresh.button")}
      onClick={() => {
        if (!refreshing) onRefresh();
      }}
      className={cn(
        "inline-flex min-h-touch items-center gap-1.5 rounded-full border border-border-default bg-bg-surface px-3 text-caption font-medium text-text-default hover:bg-bg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus",
        className,
      )}
    >
      <RefreshCw
        className={cn(
          "size-4 shrink-0 text-text-muted",
          refreshing && !reducedMotion && "animate-spin",
        )}
        aria-hidden="true"
      />
      <span>{t("refresh.button")}</span>
    </button>
  );
}
