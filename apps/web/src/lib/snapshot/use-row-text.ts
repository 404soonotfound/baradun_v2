import type { Beach } from "@baradun/contracts";
import { useTranslations } from "next-intl";

import { formatKm, joinMeta } from "@/lib/meta-join";
import { kstStamp } from "@/lib/snapshot/clock";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import { useTimeText } from "@/lib/snapshot/use-time-text";
import type { BeachView, MetricKey, MetricView } from "@/lib/snapshot/view";

// 목록 행(BeachRow)의 2·3줄 문구 (BRD-29 · 노션 3장 BeachRow). 탐색·검색·즐겨찾기가 같은 규칙을 씀
// 상태는 view를 그대로 씀(G1). 값 자리는 세 가지를 섞지 않음:
//   '가까운 관측 없음'(측정소 없음) · '측정이 늦어지고 있어요'(늦어짐) · '–'(일시 결측: 글리프에만, 문구 없음)
export function useRowText() {
  const t = useTranslations();
  const { badgeText, confirmedUntilText } = useBadgeText();
  const { measuredAgoText } = useTimeText();
  const { zonesText } = useMetaText();

  // 2줄째: "강원 양양 · 2.1km · 10분 전 측정". 값이 있는 파고만 측정 시각을 붙임
  function rowMeta(
    region: string,
    distanceKm: number | null,
    view: BeachView,
    nowMs: number,
  ): string | null {
    const km = distanceKm === null ? null : formatKm(distanceKm);
    const wave = view.kind === "ready" ? view.metrics.waveHeight : null;
    return joinMeta([
      region,
      km && `${km}km`,
      wave?.kind === "value" ? measuredAgoText(wave.observedAt, nowMs) : null,
    ]);
  }

  // 지표 한 칸 문구. 일시 결측('–')은 글리프가 보여 주므로 문구 없음
  function metricText(key: MetricKey, metric: MetricView): string | null {
    const label = t(`observation.metric.${key}`);
    switch (metric.kind) {
      case "value":
        return `${label} ${metric.value}${metric.unit}`;
      case "none":
        return `${label} · ${t("observation.none")}`;
      case "delayed":
        return `${label} · ${t("observation.delayed")}`;
      case "hidden":
        return null;
    }
  }

  // 근거 줄: 특보 없음이면 범위(해변 특보구역 이름, D18-11) · 기관 · 확인 시각, 오래된 정보면 "HH:MM 확인 · 이후 확인 못 함". 그 외는 null
  function rowBasis(
    view: BeachView,
    nowMs: number,
    zones: Beach["warningZones"],
  ): string | null {
    if (view.kind !== "ready") return null;
    if (view.stale) return confirmedUntilText(view.confirmedAt, nowMs);
    if (view.badge.kind !== "clear") return null;
    const time = kstStamp(view.confirmedAt, nowMs);
    const scope = zonesText(zones);
    return time
      ? t("home.near.clearScope", { zones: scope, time })
      : t("explore.row.clearScopeNoTime", { zones: scope });
  }

  // 3줄째. 이용불가는 특보 이름만(S17)이라 값 줄을 두지 않음
  //   특보 없음: 범위 · 기관 · 확인 시각 + 값 / 판단불가: 값(+ 남은 사유) / 오래된 정보: "HH:MM 확인 · 이후 확인 못 함"
  function rowDetail(
    view: BeachView,
    nowMs: number,
    zones: Beach["warningZones"],
  ): string | null {
    if (view.kind !== "ready") return null;
    const lines: (string | null)[] = [rowBasis(view, nowMs, zones)];
    // 배지로 쓴 첫 사유 뒤의 사유도 버리지 않음(모르는 사유는 일반 단어로 이미 바뀌어 있음)
    lines.push(...view.reasons.slice(1).map(badgeText));
    if (view.category !== "unavailable") {
      lines.push(
        metricText("waveHeight", view.metrics.waveHeight),
        view.metrics.wavePeriod.kind === "value"
          ? metricText("wavePeriod", view.metrics.wavePeriod)
          : null,
      );
    }
    return joinMeta(lines);
  }

  // --- 세 줄 목록 줄(탐색 시안 C · GH-529, 결정 기록 29장 D29-2) ---
  // 2줄째: "강원 강릉시 · 6.2km · 수온 21.4°C · 34분 전 측정". 수온 자리는 세 가지를 섞지 않음:
  //   값 + 그 값의 측정 시각 · '가까운 관측 없음'(측정소 없음) · '수온 · 측정이 늦어지고 있어요'(늦어짐). 일시 결측은 값 자리를 비움(0·정상으로 보이지 않게)
  function listMeta(
    region: string,
    distanceKm: number | null,
    view: BeachView,
    nowMs: number,
  ): string | null {
    const km = distanceKm === null ? null : formatKm(distanceKm);
    const temp = view.kind === "ready" ? view.metrics.waterTemp : null;
    return joinMeta([
      region,
      km && `${km}km`,
      temp?.kind === "none"
        ? t("observation.none")
        : temp && metricText("waterTemp", temp),
      temp?.kind === "value" ? measuredAgoText(temp.observedAt, nowMs) : null,
    ]);
  }

  // 넷째 줄(있을 때만): 칩이 말하지 못한 것. 구역·기관·확인 시각은 묶음 머리에 한 번만 두므로 여기에 넣지 않음
  //   오래된 정보: "HH:MM 확인 · 이후 확인 못 함" / 남은 사유(칩으로 쓴 첫 사유 뒤) / 판단불가: 파고 값·지연(+ 파주기)
  //   값을 보이면 그 값의 측정 시각을 바로 뒤에 붙임(2줄째 'n분 전 측정'은 수온의 시각이라 파고·파주기 시각으로 읽히지 않게)
  //   values: false면 값은 빼고 사유·확인 시각만(지도 카드: 측정소 줄을 두지 않으므로 출처 없는 값을 보이지 않음)
  function listNote(
    view: BeachView,
    nowMs: number,
    { values = true }: { values?: boolean } = {},
  ): string | null {
    if (view.kind !== "ready") return null;
    const lines: (string | null)[] = [
      view.stale ? confirmedUntilText(view.confirmedAt, nowMs) : null,
      ...view.reasons.slice(1).map(badgeText),
    ];
    if (values && view.category === "undetermined") {
      const wave = view.metrics.waveHeight;
      const period = view.metrics.wavePeriod;
      lines.push(
        metricText("waveHeight", wave),
        wave.kind === "value" ? measuredAgoText(wave.observedAt, nowMs) : null,
        period.kind === "value" ? metricText("wavePeriod", period) : null,
        period.kind === "value"
          ? measuredAgoText(period.observedAt, nowMs)
          : null,
      );
    }
    return joinMeta(lines);
  }

  return { rowMeta, rowBasis, rowDetail, listMeta, listNote };
}
