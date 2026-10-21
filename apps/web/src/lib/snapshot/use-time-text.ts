import { useTranslations } from "next-intl";
import { kstStamp, minutesAgo } from "./clock";

export function useTimeText() {
  const t = useTranslations();

  // 측정값 옆: "10분 전 측정" / "Measured 10 min ago"
  function measuredAgoText(
    observedAt: string | null | undefined,
    nowMs: number,
  ): string | null {
    const minutes = minutesAgo(observedAt, nowMs);
    return minutes === null ? null : t("observation.measuredAgo", { minutes });
  }

  // 특보 발표 시각: "14:05 발표", 날짜가 다르면 "10/20 14:05 발표"
  function issuedAtText(
    publishedAt: string | null | undefined,
    nowMs: number,
  ): string | null {
    const time = kstStamp(publishedAt, nowMs);
    return time === null ? null : t("observation.issuedAt", { time });
  }

  return { measuredAgoText, issuedAtText };
}
