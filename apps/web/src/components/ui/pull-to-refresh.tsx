"use client";

import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useRef, useState } from "react";

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
  const startYRef = useRef<number | null>(null);
  const pullRef = useRef(0);
  const [pullDistance, setPullDistance] = useState(0);

  function resetPull() {
    startYRef.current = null;
    pullRef.current = 0;
    setPullDistance(0);
  }

  function handleTouchStart(e: React.TouchEvent<HTMLDivElement>) {
    if (refreshing || window.scrollY > 0) return;
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
      className={cn("relative", className)}
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
