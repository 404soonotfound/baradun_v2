import type { Beach, StationRef } from "@baradun/contracts";
import { useLocale, useTranslations } from "next-intl";

import { agencyKeyOf } from "@/lib/agencies";
import type { Locale } from "@/lib/i18n";
import { formatKm, joinMeta } from "@/lib/meta-join";

import { useTimeText } from "@/lib/snapshot/use-time-text";
import type { MetricKey } from "@/lib/snapshot/view";
import { beachZonesText } from "@/lib/zone-name";

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

  // 기관 이름: 데이터 값(한국어 원문) 중 아는 기관(lib/agencies 표)만 문구 키로("기상청" → 영어 "KMA").
  // 모르는 기관은 지어내지 않고 원문 그대로
  function agencyText(source: string): string {
    const key = agencyKeyOf(source);
    return key ? t(`observation.agency.${key}`) : source;
  }

  // '특보 없음' 근거 줄의 범위: 해변의 특보구역 이름 '강원중부앞바다, 강릉평지'(D18-11 ①).
  // 이름을 다 알 수 없으면 일반 이름 '해변 특보구역'('이 해변'은 쓰지 않음, D18-10)
  function zonesText(zones: Beach["warningZones"]): string {
    return beachZonesText(zones, locale as Locale) ?? t("warning.beachZones");
  }

  return { observationMeta, warningMeta, stationText, agencyText, zonesText };
}
