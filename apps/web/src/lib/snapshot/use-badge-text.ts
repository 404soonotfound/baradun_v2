import { useFormatter, useTranslations } from "next-intl";

import { isTime } from "./clock";
import type { BadgeLabel } from "./view";

// 사유 → 화면 문구 (G1: 화면은 code를 문구로 바꾸기만 함, BRD-41)
// 배지에는 분류 이름보다 실제 사유(예: 풍랑주의보, 관측 지연)를 먼저 보여줌
export function useBadgeText() {
  const t = useTranslations();
  const format = useFormatter();

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

  // B5(view.stale일 때): "HH:MM 확인 · 이후 확인 못 함". 시각은 한국 시각(Provider의 timeZone Asia/Seoul).
  // 확인 시각을 모르면(null·읽을 수 없는 값) 시각 없이 '이후 확인 못 함'만 — 오래된 정보 표시가 사라지지 않게
  function confirmedUntilText(confirmedAt: string | null): string {
    if (!isTime(confirmedAt)) return t("verdict.confirmedUnknown");
    const time = format.dateTime(new Date(confirmedAt), {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    return t("verdict.confirmedUntil", { time });
  }

  return { badgeText, confirmedUntilText };
}
