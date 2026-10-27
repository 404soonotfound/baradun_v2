"use client";

import type { Beach } from "@baradun/contracts";
import { useTranslations } from "next-intl";
import { useId } from "react";

import { WaveChart } from "@/components/detail/wave-chart";
import { WaveFigure } from "@/components/detail/wave-figure";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { joinMeta } from "@/lib/meta-join";
import type { DetailInfo } from "@/lib/snapshot/detail";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import { useTimeText } from "@/lib/snapshot/use-time-text";
import type { BeachView, MetricKey, MetricView } from "@/lib/snapshot/view";

// 바다 상태 (BRD-32 · 노션 2장 DET 5·6, 3장 SeaCard·StatGrid)
// 파고 큰 숫자 + 파주기 → 지표별 측정소 메타 → 파도 그림 → 24시간 파고. 그 아래 2×2: 수온 · 바람 · 파주기 · 이안류
// 값 자리는 세 가지로 구분: '가까운 관측 없음'(측정소 없음) / '측정이 늦어지고 있어요'(지연·만료, B4) / "–"(일시 결측).
// 파장은 표시하지 않음(B2-파장). 값은 0이나 정상으로 채우지 않음

type Ready = Extract<BeachView, { kind: "ready" }>;

// 측정소를 모르는 값은 출처를 붙일 수 없어 보이지 않음("–", 홈 카드와 같은 규칙)
export function shownMetric(
  view: Ready,
  stations: Beach["stations"],
  key: MetricKey,
): MetricView {
  const metric = view.metrics[key];
  return metric.kind === "value" && stations[key] === null
    ? { kind: "hidden" }
    : metric;
}

// 값 자리가 '가까운 관측 없음'이면 측정소 이름도 붙이지 않음(이름과 '관측 없음'이 함께 보여 모순되지 않게)
export function shownStation(
  metric: MetricView,
  stations: Beach["stations"],
  key: MetricKey,
): Beach["stations"][MetricKey] {
  return metric.kind === "none" ? null : stations[key];
}

// 값 한 칸의 글자. size: 큰 숫자(파고) · 보통(2×2)
export function MetricValue({
  metric,
  size = "m",
}: {
  metric: MetricView;
  size?: "xl" | "m";
}) {
  const t = useTranslations();
  if (metric.kind === "value") {
    return (
      <span
        className={cn(
          "font-bold text-text-default tabular-nums",
          size === "xl" ? "text-[40px] leading-none" : "text-num-m",
        )}
      >
        {metric.value}
        <span className="ml-0.5 text-caption font-normal text-text-muted">
          {metric.unit}
        </span>
      </span>
    );
  }
  if (metric.kind === "none") {
    return (
      <span className="text-body-s text-text-muted">
        {t("observation.none")}
      </span>
    );
  }
  if (metric.kind === "delayed") {
    return (
      <span className="text-body-s font-bold text-status-stale-fg">
        {t("observation.delayed")}
      </span>
    );
  }
  return (
    <span className="text-num-m text-text-muted">
      <span aria-hidden="true">–</span>
      <span className="sr-only">{t("home.near.noValue")}</span>
    </span>
  );
}

export function SeaCard({
  view,
  stations,
  nowMs,
}: {
  view: BeachView;
  stations: Beach["stations"];
  nowMs: number;
}) {
  const t = useTranslations("detail.sea");
  const titleId = useId();
  const { observationMeta } = useMetaText();

  if (view.kind !== "ready") {
    return (
      <section
        aria-busy="true"
        className="flex flex-col gap-3 rounded-card bg-bg-surface p-5 shadow-card"
      >
        <h2 className="text-title-s">{t("title")}</h2>
        <Skeleton className="h-10 w-24" />
        <Skeleton className="h-[140px] w-full" />
      </section>
    );
  }

  const wave = shownMetric(view, stations, "waveHeight");
  const period = shownMetric(view, stations, "wavePeriod");
  const meta = (key: MetricKey, metric: MetricView) =>
    observationMeta(
      key,
      shownStation(metric, stations, key),
      metric.kind === "value" ? metric.observedAt : null,
      nowMs,
    );

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-3 rounded-card bg-bg-surface p-5 shadow-card"
    >
      <h2 id={titleId} className="text-title-s text-text-default">
        {t("title")}
      </h2>
      {/* 파고 큰 숫자 + 파주기. 관측 지연이면 파고 숫자 대신 늦어짐 문구(B4) */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {wave.kind === "delayed" ? (
          <span className="text-body font-bold text-status-stale-fg">
            {t("waveDelayed")}
          </span>
        ) : (
          <MetricValue metric={wave} size="xl" />
        )}
        {period.kind === "value" && (
          <span className="text-body text-text-body">
            {t("period", { value: period.value })}
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-0.5 text-caption text-text-muted">
        <li>{meta("waveHeight", wave)}</li>
        <li>{meta("wavePeriod", period)}</li>
      </ul>
      <WaveFigure
        height={wave.kind === "value" ? wave.value : null}
        period={period.kind === "value" ? period.value : null}
        delayed={wave.kind === "delayed"}
      />
      {/* 값 자리가 '가까운 관측 없음'이면 그 측정소 기록도 그리지 않음(메타와 같은 규칙) */}
      <WaveChart
        stationId={shownStation(wave, stations, "waveHeight")?.id ?? null}
        nowMs={nowMs}
      />
    </section>
  );
}

// 2×2 지표 칸 (3장 StatGrid): 수온 · 바람 · 파주기 · 이안류. 칸마다 측정소 이름·거리
export function StatGrid({
  view,
  stations,
  ripCurrent,
  nowMs,
}: {
  view: BeachView;
  stations: Beach["stations"];
  ripCurrent: DetailInfo["ripCurrent"];
  nowMs: number;
}) {
  const t = useTranslations();
  const { stationText, agencyText } = useMetaText();
  const { issuedAtText, measuredAgoText } = useTimeText();
  if (view.kind !== "ready") return null;

  const keys = ["waterTemp", "wind", "wavePeriod"] as const;
  return (
    <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {keys.map((key) => {
        const metric = shownMetric(view, stations, key);
        const station = shownStation(metric, stations, key);
        return (
          <li
            key={key}
            className="flex flex-col gap-1 rounded-card bg-bg-surface p-4 shadow-card"
          >
            <span className="text-caption font-bold text-text-muted">
              {t(`observation.metric.${key}`)}
            </span>
            <MetricValue metric={metric} />
            {station && (
              <span className="text-caption text-text-muted">
                {joinMeta([
                  stationText(station),
                  metric.kind === "value"
                    ? measuredAgoText(metric.observedAt, nowMs)
                    : null,
                ])}
              </span>
            )}
          </li>
        );
      })}
      {/* 이안류: 정보만(D5). 기관 발표 단계 원문 그대로, 게시된 null이면 '제공 기간 아님', 읽을 수 없으면 "–" */}
      <li className="flex flex-col gap-1 rounded-card bg-bg-surface p-4 shadow-card">
        <span className="text-caption font-bold text-text-muted">
          {t("detail.stats.ripCurrent")}
        </span>
        {ripCurrent === "unknown" ? (
          <MetricValue metric={{ kind: "hidden" }} />
        ) : ripCurrent ? (
          <>
            <span className="text-body font-bold text-text-default">
              {ripCurrent.label}
            </span>
            <span className="text-caption text-text-muted">
              {joinMeta([
                agencyText(ripCurrent.source),
                issuedAtText(ripCurrent.publishedAt, nowMs),
              ])}
            </span>
          </>
        ) : (
          <span className="text-body-s text-text-muted">
            {t("detail.stats.ripNotProvided")}
          </span>
        )}
      </li>
    </ul>
  );
}
