"use client";

import type { Beach } from "@baradun/contracts";
import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";

import { WaveChart } from "@/components/detail/wave-chart";
import { WaveFigure } from "@/components/detail/wave-figure";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import type { Locale } from "@/lib/i18n";
import { joinMeta } from "@/lib/meta-join";
import type { DetailInfo } from "@/lib/snapshot/detail";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import { useTimeText } from "@/lib/snapshot/use-time-text";
import type { BeachView, MetricKey, MetricView } from "@/lib/snapshot/view";

// 바다 상태 (BRD-32 · 노션 2장 DET 5·6, 3장 SeaCard·StatGrid · Figma 220:3650·183:816, BRD-129)
// 모바일: 제목 줄(파고 측정소 · 측정 시각) → 파고 큰 숫자 + 파주기 → 파도 그림 → 지난 24시간 파고. 그 아래 2×2: 수온 · 바람 · 파주기 · 이안류
// PC(lg): '지금 바다' 제목 줄 → 4칸(파고 · 파주기 · 수온 · 바람) → 파도 크기 비교 | 지난 24시간 파고 + 이안류 한 줄
// 값 자리는 세 가지로 구분: '가까운 관측 없음'(측정소 없음) / '측정이 늦어지고 있어요'(지연·만료, B4) / "–"(일시 결측).
// 파장은 표시하지 않음(B2-파장). 값은 0이나 정상으로 채우지 않음. 풍향은 받는 값이 없어 두지 않음(Figma '북동풍')

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

// 값 한 칸의 글자. size: xl 모바일 파고(40) · l PC 4칸(28) · m 모바일 2×2(22). 단위는 한 칸 띄운 보조 글자
const VALUE_SIZE = {
  xl: {
    value: "text-[40px] leading-none tracking-[-1.6px]",
    unit: "text-[16px]",
  },
  l: {
    value: "text-[28px] leading-[1.45] tracking-[-0.8px]",
    unit: "text-body-s",
  },
  m: { value: "text-[22px] leading-[1.45]", unit: "text-caption" },
};

export function MetricValue({
  metric,
  size = "m",
}: {
  metric: MetricView;
  size?: keyof typeof VALUE_SIZE;
}) {
  const t = useTranslations();
  if (metric.kind === "value") {
    return (
      <span
        className={cn(
          "font-bold text-text-default tabular-nums",
          VALUE_SIZE[size].value,
        )}
      >
        {metric.value}
        <span
          className={cn(
            "ml-1 font-medium tracking-normal text-text-muted",
            VALUE_SIZE[size].unit,
          )}
        >
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
    <span
      className={cn(
        "font-bold text-text-muted",
        size === "m"
          ? "text-[22px] leading-[1.45]"
          : "text-[28px] leading-[1.45]",
      )}
    >
      <span aria-hidden="true">–</span>
      <span className="sr-only">{t("home.near.noValue")}</span>
    </span>
  );
}

export function SeaCard({
  view,
  stations,
  ripCurrent,
  nowMs,
  kmaSource,
}: {
  view: BeachView;
  stations: Beach["stations"];
  ripCurrent: DetailInfo["ripCurrent"];
  nowMs: number;
  kmaSource: boolean; // 24시간 파고 캡션에 기상청 출처를 붙일 실제 자료인지(showsKmaSource)
}) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const titleId = useId();
  const { measuredAgoText } = useTimeText();

  const title = (
    <>
      <span className="lg:hidden">{t("detail.sea.title")}</span>
      <span className="hidden lg:inline">{t("detail.sea.titleWide")}</span>
    </>
  );

  if (view.kind !== "ready") {
    return (
      <section
        aria-busy="true"
        className="flex flex-col gap-3 rounded-card bg-bg-surface p-4 shadow-card lg:px-5"
      >
        <h2 className="text-title-s text-text-default lg:text-title-m">
          {title}
        </h2>
        <Skeleton className="h-10 w-24" />
        <Skeleton className="h-[150px] w-full" />
      </section>
    );
  }

  const wave = shownMetric(view, stations, "waveHeight");
  const period = shownMetric(view, stations, "wavePeriod");
  // 제목 줄 오른쪽: 파고 측정소 · 측정 시각(Figma '강릉 해양기상부이 · 10분 전 측정'). 측정소 거리는 정보 출처 칸에 둠
  const waveStation = shownStation(wave, stations, "waveHeight");
  const headMeta = joinMeta([
    waveStation?.name[locale],
    wave.kind === "value" ? measuredAgoText(wave.observedAt, nowMs) : null,
  ]);

  return (
    <section
      aria-labelledby={titleId}
      className="@container flex flex-col gap-3 rounded-card bg-bg-surface p-4 shadow-card lg:gap-0 lg:p-0"
    >
      <div className="flex items-baseline justify-between gap-3 lg:px-5 lg:pt-4">
        <h2
          id={titleId}
          className="shrink-0 text-title-s text-text-default lg:text-title-m"
        >
          {title}
        </h2>
        {headMeta && (
          <p className="min-w-0 text-right text-caption text-text-muted">
            {headMeta}
          </p>
        )}
      </div>

      {/* 모바일: 파고 큰 숫자 + 파주기. 관측 지연이면 파고 숫자 대신 늦어짐 문구(B4) */}
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 lg:hidden">
        {wave.kind === "delayed" ? (
          <span className="text-body font-bold text-status-stale-fg">
            {t("detail.sea.waveDelayed")}
          </span>
        ) : (
          <MetricValue metric={wave} size="xl" />
        )}
        {period.kind === "value" && (
          <span className="text-body-s text-text-body">
            {t("detail.sea.period", { value: period.value })}
          </span>
        )}
      </div>

      {/* PC: 4칸(Figma 183:820). 칸마다 측정소 · 측정 시각 */}
      <WideStats view={view} stations={stations} nowMs={nowMs} />

      {/* 그림 | 그래프 두 열은 카드가 넓을 때만(카드 너비 42rem 이상, 1280 화면 740px). 좁은 PC(1024 → 484px)에서
          두 열이면 그래프가 116px로 줄어 글자를 읽기 어려워 모바일처럼 세로로 둠(Codex P2) */}
      <div className="flex flex-col gap-3 lg:px-5 lg:pt-4 lg:pb-[18px] @2xl:grid @2xl:grid-cols-[300px_minmax(0,1fr)] @2xl:gap-7">
        <div className="flex flex-col gap-1.5">
          <h3 className="hidden text-label text-text-default lg:block">
            {t("detail.figure.title")}
          </h3>
          <WaveFigure
            height={wave.kind === "value" ? wave.value : null}
            period={period.kind === "value" ? period.value : null}
            delayed={wave.kind === "delayed"}
          />
        </div>
        <div className="flex flex-col gap-1 border-t border-border-default pt-[13px] @2xl:border-0 @2xl:pt-0">
          {/* 값 자리가 '가까운 관측 없음'이면 그 측정소 기록도 그리지 않음(메타와 같은 규칙) */}
          <WaveChart
            stationId={waveStation?.id ?? null}
            latest={
              wave.kind === "value"
                ? { t: Date.parse(wave.observedAt), v: wave.value }
                : null
            }
            nowMs={nowMs}
            sourceShown={kmaSource}
          />
          <RipLine ripCurrent={ripCurrent} nowMs={nowMs} />
        </div>
      </div>
    </section>
  );
}

// PC 4칸: 파고 · 파주기 · 수온 · 바람(Figma 183:820: 칸 사이 세로 줄, 아래 구분선)
function WideStats({
  view,
  stations,
  nowMs,
}: {
  view: Ready;
  stations: Beach["stations"];
  nowMs: number;
}) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const { measuredAgoText } = useTimeText();
  const keys = ["waveHeight", "wavePeriod", "waterTemp", "wind"] as const;
  return (
    <ul className="hidden border-b border-border-default px-5 pt-3.5 pb-[17px] lg:grid lg:grid-cols-4">
      {keys.map((key, index) => {
        const metric = shownMetric(view, stations, key);
        const station = shownStation(metric, stations, key);
        return (
          <li
            key={key}
            className={cn(
              "flex min-w-0 flex-col gap-0.5",
              index > 0 && "border-l border-border-default pl-[19px]",
            )}
          >
            <span className="text-caption text-text-muted">
              {t(`observation.metric.${key}`)}
            </span>
            <MetricValue metric={metric} size="l" />
            {station && (
              <span className="text-caption text-text-muted">
                {joinMeta([
                  station.name[locale],
                  metric.kind === "value"
                    ? measuredAgoText(metric.observedAt, nowMs)
                    : null,
                ])}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// 이안류 글자: 정보만(D5). 기관 발표 단계 원문 그대로, 게시된 null이면 '제공 기간 아님', 읽을 수 없으면 "–"
// 제공 기간(Figma '6~8월 제공')은 받는 값이 없어 쓰지 않음
function useRipText(ripCurrent: DetailInfo["ripCurrent"], nowMs: number) {
  const t = useTranslations();
  const { agencyText } = useMetaText();
  const { issuedAtText } = useTimeText();
  if (ripCurrent === "unknown") return null;
  if (ripCurrent === null)
    return { label: t("detail.stats.ripNotProvided"), meta: null };
  return {
    label: ripCurrent.label,
    meta: joinMeta([
      agencyText(ripCurrent.source),
      issuedAtText(ripCurrent.publishedAt, nowMs),
    ]),
  };
}

// PC: 그래프 아래 '이안류 · 제공 기간 아님' 한 줄(Figma 183:986)
function RipLine({
  ripCurrent,
  nowMs,
}: {
  ripCurrent: DetailInfo["ripCurrent"];
  nowMs: number;
}) {
  const t = useTranslations();
  const rip = useRipText(ripCurrent, nowMs);
  return (
    <p className="hidden text-caption text-text-muted lg:block">
      {joinMeta([
        t("detail.stats.ripCurrent"),
        rip ? rip.label : t("home.near.noValue"),
        rip?.meta,
      ])}
    </p>
  );
}

// 모바일 2×2 지표 카드 (3장 StatGrid · Figma card.grid2 220:3713): 수온 · 바람 · 파주기 · 이안류
// 한 카드 안 4칸, 칸 사이 구분선. 칸마다 측정소 이름 · 측정 시각
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
  const locale = useLocale() as Locale;
  const { measuredAgoText } = useTimeText();
  const rip = useRipText(ripCurrent, nowMs);
  if (view.kind !== "ready") return null;

  const keys = ["waterTemp", "wind", "wavePeriod"] as const;
  // 칸 구분선: 왼쪽 칸은 오른쪽 줄, 위 줄은 아래 줄
  const cell = (index: number) =>
    cn(
      "flex min-w-0 flex-col gap-0.5 border-border-default px-4 pt-3.5 pb-[15px]",
      index % 2 === 0 && "border-r",
      index < 2 && "border-b",
    );
  return (
    <ul className="grid grid-cols-2 rounded-card bg-bg-surface shadow-card lg:hidden">
      {keys.map((key, index) => {
        const metric = shownMetric(view, stations, key);
        const station = shownStation(metric, stations, key);
        return (
          <li key={key} className={cell(index)}>
            <span className="text-caption text-text-muted">
              {t(`observation.metric.${key}`)}
            </span>
            <MetricValue metric={metric} />
            {station && (
              <span className="text-caption text-text-muted">
                {joinMeta([
                  station.name[locale],
                  metric.kind === "value"
                    ? measuredAgoText(metric.observedAt, nowMs)
                    : null,
                ])}
              </span>
            )}
          </li>
        );
      })}
      <li className={cell(3)}>
        <span className="text-caption text-text-muted">
          {t("detail.stats.ripCurrent")}
        </span>
        {rip ? (
          <>
            <span className="text-title-s leading-[28px] text-text-default">
              {rip.label}
            </span>
            {rip.meta && (
              <span className="text-caption text-text-muted">{rip.meta}</span>
            )}
          </>
        ) : (
          <MetricValue metric={{ kind: "hidden" }} />
        )}
      </li>
    </ul>
  );
}
