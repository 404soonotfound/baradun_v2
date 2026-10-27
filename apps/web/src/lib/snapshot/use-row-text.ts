import { useTranslations } from "next-intl";

import { formatKm, joinMeta } from "@/lib/meta-join";
import { kstStamp } from "@/lib/snapshot/clock";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useTimeText } from "@/lib/snapshot/use-time-text";
import type { BeachView, MetricKey, MetricView } from "@/lib/snapshot/view";

// 목록 행(BeachRow)의 2·3줄 문구 (BRD-29 · 노션 3장 BeachRow). 탐색·검색·즐겨찾기가 같은 규칙을 씀
// 상태는 view를 그대로 씀(G1). 값 자리는 세 가지를 섞지 않음:
//   '가까운 관측 없음'(측정소 없음) · '측정이 늦어지고 있어요'(늦어짐) · '–'(일시 결측: 글리프에만, 문구 없음)
export function useRowText() {
  const t = useTranslations();
  const { badgeText, confirmedUntilText } = useBadgeText();
  const { measuredAgoText } = useTimeText();

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

  // 3줄째. 이용불가는 특보 이름만(S17)이라 값 줄을 두지 않음
  //   특보 없음: 범위 · 기관 · 확인 시각 + 값 / 판단불가: 값(+ 남은 사유) / 오래된 정보: "HH:MM 확인 · 이후 확인 못 함"
  function rowDetail(view: BeachView, nowMs: number): string | null {
    if (view.kind !== "ready") return null;
    const lines: (string | null)[] = [];
    if (view.stale) {
      lines.push(confirmedUntilText(view.confirmedAt, nowMs));
    } else if (view.badge.kind === "clear") {
      const time = kstStamp(view.confirmedAt, nowMs);
      lines.push(
        time
          ? t("home.near.clearScope", { time })
          : t("explore.row.clearScopeNoTime"),
      );
    }
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

  return { rowMeta, rowDetail };
}
