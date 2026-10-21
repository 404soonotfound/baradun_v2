import type { StationRef } from "@baradun/contracts";
import { useLocale, useTranslations } from "next-intl";

import { formatKm, joinMeta } from "@/lib/meta-join";

import { useTimeText } from "@/lib/snapshot/use-time-text";
import type { MetricKey } from "@/lib/snapshot/view";

export function useMetaText() {
  const t = useTranslations();
  // 지금 화면 언어("ko" | "en"). 해변 측정소 이름에서 같은 언어를 꺼낼때 씀
  const locale = useLocale();
  const { measuredAgoText, issuedAtText } = useTimeText();

  // 측정소 조각: "연곡 파고부이 8.3km". 거리를 읽을 수 없으면 이름만
  function stationText(station: NonNullable<StationRef>): string {
    const name = station.name[locale];
    const km = formatKm(station.distanceKm);
    return km === null ? name : t("observation.station", { name, km });
  }

  // 측정소 없음: "파고 · 연곡 파고부이 8.3km · 10분 전 측정"
  function observationMeta(
    metric: MetricKey,
    station: StationRef,
    observedAt: string | null | undefined,
    nowMs: number,
  ): string {
    const label = t(`observation.metric.${metric}`);
    const parts =
      station === null
        ? [label, t(`observation.none`)]
        : [label, stationText(station), measuredAgoText(observedAt, nowMs)];
    return joinMeta(parts) ?? label;
  }

  // 특보 한 줄: "울진 앞바다 · 기상청 · 14:06 발표" (범위 -> 기관 -> 시각)
  function warningMeta(
    scope: string | null | undefined,
    source: string | null | undefined,
    publishedAt: string | null | undefined,
    nowMs: number,
  ): string | null {
    return joinMeta([scope, source, issuedAtText(publishedAt, nowMs)]);
  }

  return { observationMeta, warningMeta };
}
