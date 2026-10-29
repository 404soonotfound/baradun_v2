"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { ReasonBadge } from "@/components/reason-badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { BeachSummary } from "@/lib/beach-summary";
import { localizedPath, type Locale } from "@/lib/i18n";
import { formatKm, joinMeta } from "@/lib/meta-join";
import { kstStamp } from "@/lib/snapshot/clock";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import type { BeachView, MetricKey, MetricView } from "@/lib/snapshot/view";

// 가까운 바다 카드 (노션 2장 HOME 7 · 3장 NearCard, Figma S_M01_01 171:379)
// 해변명·지역·거리 + 상태 배지 → 파고·수온·바람 3칸 → 근거 줄(특보 범위 → 기관 → 시각, 지표별 측정소 → 관측 시각) + 현장 우선 문구
// 상태는 view를 그대로 씀(G1). 값이 없으면 0이 아니라 "–"(hidden) 또는 '가까운 관측 없음'(none)
// 모양 두 가지(Figma, BRD-129):
//   compact(모바일 171:478): 이름·배지 한 줄 → 3칸 → 근거 줄 + 현장 우선 문구
//   wide(PC 181:851): 이름 + › → 배지 → 큰 파고 + 나머지 지표 한 줄 → 근거 줄. 현장 우선 문구는 묶음 제목 줄(home-screen)

// 카드에 보이는 지표 3칸(순서 = 칸 순서)
const CARD_METRICS = [
  "waveHeight",
  "waterTemp",
  "wind",
] as const satisfies readonly MetricKey[];

// [1] Vue: props: { locale, beach, distanceKm, view, nowMs, variant }
export function NearCard({
  locale,
  beach,
  distanceKm,
  view,
  nowMs,
  variant = "compact",
}: {
  locale: Locale;
  beach: BeachSummary;
  distanceKm: number | null; // 위치가 없으면 null(거리 대신 지역만)
  view: BeachView;
  nowMs: number;
  variant?: "compact" | "wide";
}) {
  const t = useTranslations();
  const { confirmedUntilText } = useBadgeText();
  const { observationMeta } = useMetaText();

  // [2] 거리: 2.1 → "2.1km". joinMeta가 null·빈 칸을 빼고 " · "로 이어 줌
  const km = distanceKm === null ? null : formatKm(distanceKm);
  const place = joinMeta([beach.region, km && `${km}km`]);

  // 칸에 보일 지표. null = 아직 불러오는 중.
  // 측정소 정보가 없는 값은 출처를 붙일 수 없어 보이지 않음("–")
  function shownMetric(key: (typeof CARD_METRICS)[number]): MetricView | null {
    if (view.kind !== "ready") return null;
    const metric = view.metrics[key];
    return metric.kind === "value" && beach.stations[key] === null
      ? { kind: "hidden" }
      : metric;
  }

  // [3] 근거 줄. 배지 '특보 없음'은 범위·기관·시각이 함께 있어야 함(공통 규칙)
  const notes: string[] = [];
  if (view.kind === "ready") {
    const time = kstStamp(view.confirmedAt, nowMs);
    if (view.stale) {
      // 오프라인·만료(B5): "14:05 확인 · 이후 확인 못 함"
      notes.push(confirmedUntilText(view.confirmedAt, nowMs));
    } else if (view.badge.kind === "clear" && time) {
      notes.push(t("home.near.clearScope", { time }));
    }
    // 값을 보인 지표마다 출처·관측 시각: "수온 · 연곡 파고부이 8.3km · 10분 전 측정"
    // 지표마다 측정소·관측 시각이 다를 수 있어 따로 적음. 특보 출처(기상청)와 섞지 않음
    for (const key of CARD_METRICS) {
      const metric = shownMetric(key);
      const station = beach.stations[key];
      if (metric?.kind === "value" && station !== null) {
        notes.push(observationMeta(key, station, metric.observedAt, nowMs));
      }
    }
  }
  // 현장 우선 문구: 모바일은 카드마다, PC는 카드 4장 위 묶음 제목 줄에 한 번(Figma 181:849)
  if (variant === "compact") notes.push(t("safety.finalCall"));

  const badge =
    // 첫 응답 전에는 배지 자리만 회색으로(빈 배지나 '특보 없음'을 미리 보이지 않게)
    view.kind === "ready" ? (
      <ReasonBadge label={view.badge} />
    ) : (
      <Skeleton className="h-badge w-20 rounded-badge" />
    );
  const noteList = (
    <span className="flex flex-col gap-0.5 border-t border-border-default pt-[11px] text-caption text-text-muted">
      {notes.map((note) => (
        <span key={note}>{note}</span>
      ))}
    </span>
  );
  const href = localizedPath(locale, `/spots/${beach.slug}/`);

  // [4] PC: 큰 파고 + 나머지 지표 한 줄("파고 · 수온 21°C · 바람 3m/s")
  if (variant === "wide") {
    const wave = shownMetric("waveHeight");
    // 파고가 '가까운 관측 없음'이면 그 문구에 지표 이름을 붙이고 이 줄에서는 뺌
    const others = joinMeta([
      wave?.kind === "none" ? null : t("observation.metric.waveHeight"),
      ...CARD_METRICS.filter((key) => key !== "waveHeight").map((key) => {
        const metric = shownMetric(key);
        return metric?.kind === "value"
          ? `${t(`observation.metric.${key}`)} ${metric.value}${metric.unit}`
          : null;
      }),
    ]);
    return (
      <Link
        href={href}
        className="flex h-full flex-col gap-2.5 rounded-card bg-bg-surface px-4 pt-4 pb-3.5 shadow-card"
      >
        <span className="flex items-start justify-between gap-2">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-title-card text-text-default">
              {beach.name}
            </span>
            {place && (
              <span className="text-caption text-text-muted">{place}</span>
            )}
          </span>
          <ChevronRight
            aria-hidden="true"
            size={16}
            className="shrink-0 text-text-default"
          />
        </span>
        <span className="flex">{badge}</span>
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          {wave === null ? (
            <Skeleton className="h-[30px] w-20" />
          ) : wave.kind === "value" ? (
            <>
              <span className="text-num-card text-text-default">
                {wave.value}
              </span>
              <span className="text-body font-bold text-text-default">
                {wave.unit}
              </span>
            </>
          ) : wave.kind === "none" ? (
            <span className="text-body-s text-text-muted">
              {joinMeta([
                t("observation.metric.waveHeight"),
                t("observation.none"),
              ])}
            </span>
          ) : (
            <span className="text-num-card text-text-muted">
              <span aria-hidden="true">–</span>
              <span className="sr-only">{t("home.near.noValue")}</span>
            </span>
          )}
          {others && (
            <span className="pl-1 text-caption text-text-muted">{others}</span>
          )}
        </span>
        {noteList}
      </Link>
    );
  }

  // [5] 모바일: 카드 전체가 상세로 가는 링크
  return (
    <Link
      href={href}
      className="flex h-full flex-col gap-3 rounded-card bg-bg-surface p-4 shadow-raised"
    >
      <span className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-title-m text-text-default">
            {beach.name}
          </span>
          {place && (
            <span className="text-caption text-text-muted">{place}</span>
          )}
        </span>
        {badge}
      </span>

      <span className="grid grid-cols-3 divide-x divide-border-default">
        {CARD_METRICS.map((key) => (
          <MetricCell
            key={key}
            label={t(`observation.metric.${key}`)}
            metric={shownMetric(key)}
            none={t("observation.none")}
            empty={t("home.near.noValue")}
          />
        ))}
      </span>

      {noteList}
    </Link>
  );
}

// [6] 지표 한 칸. metric이 null이면 아직 불러오는 중(회색 상자)
function MetricCell({
  label,
  metric,
  none,
  empty,
}: {
  label: string;
  metric: MetricView | null;
  none: string; // '가까운 관측 없음'
  empty: string; // "–"를 화면 읽기에서 읽어 줄 말
}) {
  return (
    <span className="flex flex-col pl-[13px] first:pl-0">
      <span className="text-caption text-text-muted">{label}</span>
      {metric === null ? (
        <Skeleton className="h-6 w-12" />
      ) : metric.kind === "value" ? (
        <span className="text-num-m font-bold text-text-default">
          {metric.value}
          <span className="text-caption font-medium text-text-muted">
            {metric.unit}
          </span>
        </span>
      ) : metric.kind === "none" ? (
        <span className="text-body-s text-text-muted">{none}</span>
      ) : (
        <span className="text-num-m text-text-muted">
          <span aria-hidden="true">–</span>
          <span className="sr-only">{empty}</span>
        </span>
      )}
    </span>
  );
}
