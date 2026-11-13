"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { useToast } from "@/components/ui/toast";
import { kstStamp } from "./clock";
import { diffBeachStatuses } from "./diff";
import type { SnapshotState } from "./store";
import { useBadgeText } from "./use-badge-text";
import { getSnapshotState, refreshSnapshot, useSnapshot } from "./use-snapshot";

const KST_OFFSET_MS = 9 * 60 * 60_000;
const EMPTY_CHANGED = new Map<string, string>();

function formatKstTime(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(11, 16);
}

// 당겨서 새로고침·새로고침 버튼 공통 훅(L16, BRD-137)
// 직전 화면 상태와 새 게시본을 메모리 안에서만 비교하고 결과 토스트와 바뀐 해변 이전 사유를 관리함
export function useManualRefresh(
  beaches: readonly { id: string; hidden?: boolean }[],
) {
  const t = useTranslations();
  const snapshot = useSnapshot();
  const { badgeText } = useBadgeText();
  const { message, show, hold } = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [changedState, setChangedState] = useState<{
    snapshot: SnapshotState;
    map: Map<string, string>;
  } | null>(null);
  const refreshingRef = useRef(false);

  const triggerRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);

    const prevState = getSnapshotState();
    try {
      await refreshSnapshot();
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }

    const nextState = getSnapshotState();
    if (nextState.phase !== "ready") return;

    if (!nextState.live) {
      setChangedState(null);
      const offline =
        typeof navigator !== "undefined" && !navigator.onLine;
      show({ text: t(offline ? "refresh.offline" : "refresh.failed") });
      return;
    }

    const diff = diffBeachStatuses(beaches, prevState, nextState);
    if (diff.size === 0) {
      setChangedState(null);
      show({ text: t("refresh.upToDate") });
      return;
    }

    const nextChanged = new Map<string, string>();
    for (const [id, prevBadge] of diff) {
      nextChanged.set(id, badgeText(prevBadge));
    }
    setChangedState({ snapshot: nextState, map: nextChanged });

    const time =
      kstStamp(nextState.manifest?.generatedAt, nextState.nowMs) ??
      formatKstTime(nextState.nowMs);
    show({
      text:
        time === null
          ? t("refresh.changedNoTime", { count: diff.size })
          : t("refresh.changed", { time, count: diff.size }),
    });
  }, [badgeText, beaches, show, t]);

  const changedFromById =
    changedState && snapshot === changedState.snapshot
      ? changedState.map
      : EMPTY_CHANGED;

  return {
    refreshing,
    changedFromById,
    triggerRefresh,
    toastMessage: message,
    holdToast: hold,
  };
}
