import type { BadgeLabel } from "./snapshot/view";

// 판단 배지 색 이름 4가지. StatusBadge의 tone 중 정보 배지(info) 제외
export type VerdictTone = "clear" | "blocked" | "unknown" | "stale";

export function badgeTone(label: BadgeLabel): VerdictTone {
  switch (label.kind) {
    case "clear":
      return "clear"; // 특보 없음
    case "warning":
    case "restricted":
      return "blocked"; // 이용불가: 특보 이름, 이용제한(모르는 사유)
    case "warning_unknown":
    case "unconfirmed":
      return "unknown"; // 판단불가: 특보 확인 못함 or 모르는 사유
    case "observation_delayed":
      return "stale"; // 판단불가: 관축지연
  }
}
