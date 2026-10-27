"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import { ReasonBadge } from "@/components/reason-badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { BeachSummary } from "@/lib/beach-summary";
import { localizedPath, type Locale } from "@/lib/i18n";
import { formatKm, joinMeta } from "@/lib/meta-join";
import { kstStamp } from "@/lib/snapshot/clock";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useTimeText } from "@/lib/snapshot/use-time-text";
import type { BeachView, MetricView } from "@/lib/snapshot/view";

// 가까운 바다 카드 (노션 2장 HOME 7 · 3장 NearCard, Figma S_M01_01 171:379)
// 해변명·지역·거리 + 상태 배지 → 파고·수온·바람 3칸 → 근거 줄(범위 → 기관 → 시각) + 현장 우선 문구
// 상태는 view를 그대로 씀(G1). 값이 없으면 0이 아니라 "–"(hidden) 또는 '가까운 관측 없음'(none)

// [1] Vue: props: { locale, beach, distanceKm, view, nowMs }
export function NearCard({
  locale,
  beach,
  distanceKm,
  view,
  nowMs,
}: {
  locale: Locale;
  beach: BeachSummary;
  distanceKm: number | null; // 위치가 없으면 null(거리 대신 지역만)
  view: BeachView;
  nowMs: number;
}) {
  const t = useTranslations();
  const { confirmedUntilText } = useBadgeText();
  const { measuredAgoText } = useTimeText();

  // [2] 거리: 2.1 → "2.1km". joinMeta가 null·빈 칸을 빼고 " · "로 이어 줌
  const km = distanceKm === null ? null : formatKm(distanceKm);
  const place = joinMeta([beach.region, km && `${km}km`]);

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
    const wave = view.metrics.waveHeight;
    if (wave.kind === "value") {
      // "10분 전 측정 · 파고 0.6m"
      const measured = joinMeta([
        measuredAgoText(wave.observedAt, nowMs),
        `${t("observation.metric.waveHeight")} ${wave.value}${wave.unit}`,
      ]);
      if (measured) notes.push(measured);
    }
  }
  notes.push(t("safety.finalCall"));

  // [4] 카드 전체가 상세로 가는 링크
  return (
    <Link
      href={localizedPath(locale, `/spots/${beach.slug}/`)}
      className="flex flex-col gap-3 rounded-card bg-bg-surface p-4 shadow-card"
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
        {/* 첫 응답 전에는 배지 자리만 회색으로(빈 배지나 '특보 없음'을 미리 보이지 않게) */}
        {view.kind === "ready" ? (
          <ReasonBadge label={view.badge} />
        ) : (
          <Skeleton className="h-badge w-20 rounded-badge" />
        )}
      </span>

      <span className="grid grid-cols-3 divide-x divide-border-default">
        <MetricCell
          label={t("observation.metric.waveHeight")}
          metric={view.kind === "ready" ? view.metrics.waveHeight : null}
          none={t("observation.none")}
          empty={t("home.near.noValue")}
        />
        <MetricCell
          label={t("observation.metric.waterTemp")}
          metric={view.kind === "ready" ? view.metrics.waterTemp : null}
          none={t("observation.none")}
          empty={t("home.near.noValue")}
        />
        <MetricCell
          label={t("observation.metric.wind")}
          metric={view.kind === "ready" ? view.metrics.wind : null}
          none={t("observation.none")}
          empty={t("home.near.noValue")}
        />
      </span>

      <span className="flex flex-col gap-0.5 border-t border-border-default pt-2.5 text-caption text-text-muted">
        {notes.map((note) => (
          <span key={note}>{note}</span>
        ))}
      </span>
    </Link>
  );
}

// [5] 지표 한 칸. metric이 null이면 아직 불러오는 중(회색 상자)
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
    <span className="flex flex-col gap-0.5 pl-3 first:pl-0">
      <span className="text-caption text-text-muted">{label}</span>
      {metric === null ? (
        <Skeleton className="h-6 w-12" />
      ) : metric.kind === "value" ? (
        <span className="text-num-m font-bold text-text-default">
          {metric.value}
          <span className="text-caption font-normal text-text-muted">
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
