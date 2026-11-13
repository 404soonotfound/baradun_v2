"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { useToast } from "@/components/ui/toast";
import { kstStamp } from "./clock";
import { diffBeachStatuses } from "./diff";
import { useBadgeText } from "./use-badge-text";
import { getSnapshotState, refreshSnapshot } from "./use-snapshot";

const KST_OFFSET_MS = 9 * 60 * 60_000;

function formatKstTime(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(11, 16);
}

// 당겨서 새로고침·새로고침 버튼 공통 훅(L16, BRD-137)
// 직전 화면 상태와 새 게시본을 메모리 안에서만 비교하고 결과 토스트와 바뀐 해변 이전 사유를 관리함
export function useManualRefresh(
  beaches: readonly { id: string; hidden?: boolean }[],
) {
  const t = useTranslations();
  const { badgeText } = useBadgeText();
  const { message, show, hold } = useToast();
  const [refreshing, setRefreshing] = useState(false);
  const [changedFromById, setChangedFromById] = useState<Map<string, string>>(
    () => new Map(),
  );
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
      setChangedFromById(new Map());
      const offline =
        typeof navigator !== "undefined" && !navigator.onLine;
      show({ text: t(offline ? "refresh.offline" : "refresh.failed") });
      return;
    }

    const diff = diffBeachStatuses(beaches, prevState, nextState);
    if (diff.size === 0) {
      setChangedFromById(new Map());
      show({ text: t("refresh.upToDate") });
      return;
    }

    const nextChanged = new Map<string, string>();
    for (const [id, prevBadge] of diff) {
      nextChanged.set(id, badgeText(prevBadge));
    }
    setChangedFromById(nextChanged);

    const time =
      kstStamp(nextState.manifest?.generatedAt, nextState.nowMs) ??
      formatKstTime(nextState.nowMs);
    show({ text: t("refresh.changed", { time, count: diff.size }) });
  }, [badgeText, beaches, show, t]);

  return {
    refreshing,
    changedFromById,
    triggerRefresh,
    toastMessage: message,
    holdToast: hold,
  };
}
