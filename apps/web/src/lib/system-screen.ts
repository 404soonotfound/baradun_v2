import { CLOCK_TOLERANCE_MS, isTime, kstStamp } from "@/lib/snapshot/clock";
import type { SnapshotState } from "@/lib/snapshot/store";

// 시스템 화면 고르기 (BRD-38 · 노션 2장 SYS, 1장 L12·L15, 아키텍처 9.1 '점검·강제 업데이트')
// 점검·강제 업데이트는 배너가 아니라 화면 전체를 덮음. 지난 값은 store가 이미 비움(hidesLastValues)
// 둘 다면 강제 업데이트가 먼저(store가 minWebBuild를 점검보다 먼저 봄: 새 화면이 점검 여부를 다시 확인함)

export type SystemScreenKind = "maintenance" | "update_required";

export function systemScreen(
  phase: SnapshotState["phase"],
): SystemScreenKind | null {
  if (phase === "update_required" || phase === "maintenance") return phase;
  return null;
}

// 점검 끝 예정 시각(한국 시각, 오늘이면 HH:MM, 아니면 M/D HH:MM)
// 읽을 수 없거나, 지금 시각을 모르거나(NaN), 이미 지났으면 null → '끝나는 시각을 알 수 없어요'
// (지난 예정 시각을 그대로 보여 곧 끝날 것처럼 안내하지 않게. 2분 여유는 시계 보정과 같음)
export function maintenanceUntil(
  until: string | null | undefined,
  nowMs: number,
): string | null {
  if (!isTime(until)) return null;
  // nowMs가 NaN이면 비교가 false → null
  if (!(Date.parse(until) > nowMs - CLOCK_TOLERANCE_MS)) return null;
  return kstStamp(until, nowMs);
}
