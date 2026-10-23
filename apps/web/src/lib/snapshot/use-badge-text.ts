import { useTranslations } from "next-intl";
import { kstStamp } from "@/lib/snapshot/clock";
import type { BadgeLabel } from "./view";

// 사유 → 화면 문구 (G1: 화면은 code를 문구로 바꾸기만 함, BRD-41)
// 배지에는 분류 이름보다 실제 사유(예: 풍랑주의보, 관측 지연)를 먼저 보여줌
export function useBadgeText() {
  const t = useTranslations();

  function badgeText(label: BadgeLabel): string {
    switch (label.kind) {
      case "clear":
        return t("verdict.clear.title");
      case "warning":
        return t("verdict.warning.title", {
          type: t(`warning.type.${label.type}`),
          level: t(`warning.level.${label.level}`),
        });
      case "warning_unknown":
        return t("verdict.unknownWarning.title");
      case "observation_delayed":
        return t("verdict.stale.title");
      case "restricted":
        return t("verdict.restricted.title");
      case "unconfirmed":
        return t("verdict.unconfirmed.title");
    }
  }

  // B5(view.stale일 때): "14:05 확인 · 이후 확인 못 함", 한국 날짜가 다르면 "10/20 14:05 확인 · …"(BRD-76).
  // 오프라인으로 며칠 전 스냅샷을 열어도 오늘 확인한 것처럼 읽히지 않게 함. 시각은 한국 시각(kstStamp).
  // 확인 시각을 모르면(null·읽을 수 없는 값) 시각 없이 '이후 확인 못 함'만 — 오래된 정보 표시가 사라지지 않게
  function confirmedUntilText(
    confirmedAt: string | null,
    nowMs: number,
  ): string {
    const time = kstStamp(confirmedAt, nowMs);
    if (time === null) return t("verdict.confirmedUnknown");

    return t("verdict.confirmedUntil", { time });
  }

  return { badgeText, confirmedUntilText };
}
