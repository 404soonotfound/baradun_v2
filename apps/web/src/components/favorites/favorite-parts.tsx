"use client";

import { Star } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { BeachIllustration } from "@/components/beach-illustration";
import { shownMetric, shownStation } from "@/components/detail/sea-card";
import { useShownPhoto } from "@/components/map/beach-photo";
import { ZoneName } from "@/components/zone-name";
import type { BeachSummary } from "@/lib/beach-summary";
import { cn } from "@/lib/cn";
import type { Locale } from "@/lib/i18n";
import { formatKm, joinMeta, META_SEPARATOR } from "@/lib/meta-join";
import { timeGroups, type TimeGroup } from "@/lib/near-metric";
import { viewedTime } from "@/lib/recent-visits";
import { kstStamp } from "@/lib/snapshot/clock";
import { deriveDetail } from "@/lib/snapshot/detail";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import { useTimeText } from "@/lib/snapshot/use-time-text";
import type { BeachView, MetricView, ViewSource } from "@/lib/snapshot/view";
import { zoneScopeText } from "@/lib/zone-name";

// 즐겨찾기 표·모바일 덩어리가 함께 쓰는 부품과 줄 데이터 정리 (GH-530)

export type ReadyView = Extract<BeachView, { kind: "ready" }>;

export type FavoriteItem = {
  beach: BeachSummary;
  view: ReadyView;
  distanceKm: number | null;
  visitedAt: string | null;
};

const METRIC_KEYS = ["waveHeight", "wavePeriod", "waterTemp"] as const;

export function FavoriteThumb({ photo }: { photo: BeachSummary["photo"] }) {
  const { shown, onError, checkBroken } = useShownPhoto(photo);
  if (shown === null) {
    // 바로 옆에 해변 이름이 있어 decorative로 이름을 뺌(D29-4)
    return (
      <BeachIllustration
        decorative
        className="h-[42px] w-14 shrink-0 rounded-[9px]"
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={checkBroken}
      src={shown.url}
      alt=""
      loading="lazy"
      onError={onError}
      className="photo-dim h-[42px] w-14 shrink-0 rounded-[9px] object-cover"
    />
  );
}

export function FavoriteStarButton({
  beachId,
  beachName,
  isFavorite,
  onClick,
  className,
}: {
  beachId: string;
  beachName: string;
  isFavorite: boolean;
  onClick: () => void;
  className?: string;
}) {
  const t = useTranslations("favorites");
  return (
    <button
      type="button"
      data-favorite-star={beachId}
      aria-label={
        isFavorite
          ? t("remove", { name: beachName })
          : t("add", { name: beachName })
      }
      onClick={onClick}
      className={cn(
        "flex size-touch shrink-0 items-center justify-center rounded-full hover:bg-bg-subtle focus-visible:-outline-offset-2",
        className,
      )}
    >
      <Star
        aria-hidden="true"
        size={19}
        className={
          isFavorite ? "fill-favorite text-favorite" : "text-text-muted"
        }
      />
    </button>
  );
}

export function FavoriteMetricValue({
  metric,
  size = "md",
}: {
  metric: MetricView;
  size?: "md" | "sm";
}) {
  const t = useTranslations();
  if (metric.kind === "value") {
    return (
      <span
        className={cn(
          "font-bold whitespace-nowrap text-text-default tabular-nums",
          size === "md" ? "text-title-card" : "text-title-s",
        )}
      >
        {metric.value}
        <span className="ml-0.5 text-caption font-normal text-text-muted">
          {metric.unit}
        </span>
      </span>
    );
  }
  if (metric.kind === "delayed") {
    return (
      <span className="text-caption font-bold text-status-stale-fg">
        {t("observation.delayedShort")}
      </span>
    );
  }
  if (metric.kind === "none") {
    return (
      <span className="text-caption text-text-muted">
        {t("observation.none")}
      </span>
    );
  }
  return (
    <span className="text-body-s font-bold text-text-muted">
      <span aria-hidden="true">–</span>
      <span className="sr-only">{t("home.near.noValue")}</span>
    </span>
  );
}

/**
 * 해변 한 줄의 지역·거리·본 시각, 특보 근거, 3개 측정값, 측정 시각·측정소를 한곳에서 정리함.
 * PC 표와 모바일 덩어리가 같은 규칙으로 그려져 값이 어긋나지 않음.
 */
export function useFavoriteRowMeta(
  item: FavoriteItem,
  snapshot: ViewSource,
  nowMs: number,
) {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const { badgeText, confirmedUntilText } = useBadgeText();
  const { issuedAtText } = useTimeText();
  const { agencyText, zonesText } = useMetaText();
  const { beach, view, distanceKm, visitedAt } = item;

  const km = distanceKm === null ? null : formatKm(distanceKm);
  const viewed = visitedAt ? viewedTime(visitedAt, nowMs) : null;
  const viewedText =
    viewed === null
      ? null
      : viewed.day === "today"
        ? t("favorites.recent.viewedToday", { time: viewed.time })
        : viewed.day === "yesterday"
          ? t("favorites.recent.viewedYesterday", { time: viewed.time })
          : t("favorites.recent.viewedOn", {
              month: viewed.month,
              date: viewed.date,
              time: viewed.time,
            });
  const metaLine = joinMeta([beach.region, km && `${km}km`, viewedText]);

  const detail = deriveDetail(beach.id, view, snapshot);
  const extraReasons = view.reasons.slice(1).map(badgeText);

  function renderScopeText(scope: string): ReactNode {
    if (locale === "ko") return scope;
    const localized = zoneScopeText(scope, locale);
    return localized.untranslated ? (
      <span lang="ko">{localized.text}</span>
    ) : (
      localized.text
    );
  }

  let zone: ReactNode = zonesText(beach.warningZones);
  let sourceTime: string;

  if (view.stale) {
    if (view.category === "unavailable" && detail.warnings[0]) {
      zone = <ZoneName zone={detail.warnings[0]} />;
      sourceTime =
        joinMeta([
          detail.warningSource && agencyText(detail.warningSource),
          confirmedUntilText(view.confirmedAt, nowMs),
        ]) ?? confirmedUntilText(view.confirmedAt, nowMs);
    } else {
      sourceTime = confirmedUntilText(view.confirmedAt, nowMs);
    }
  } else if (view.category === "unavailable") {
    const basis0 =
      detail.basis.find((basis) => basis.code === "warning") ?? detail.basis[0];
    const warning0 = detail.warnings[0];
    if (warning0) {
      zone = <ZoneName zone={warning0} />;
    } else if (basis0?.scope) {
      zone = renderScopeText(basis0.scope);
    }
    const rawSource = basis0?.source ?? detail.warningSource;
    const source = rawSource ? agencyText(rawSource) : null;
    const at = basis0?.at ?? warning0?.publishedAt ?? null;
    const stamp = kstStamp(at, nowMs);
    if (source && stamp) {
      sourceTime = t("favorites.warning.issued", { source, time: stamp });
    } else {
      sourceTime =
        joinMeta([source, issuedAtText(at, nowMs)]) ??
        confirmedUntilText(view.confirmedAt, nowMs);
    }
  } else if (view.category === "clear" || detail.warningConfirmedNone) {
    // 특보 없음, 또는 판단불가지만 특보 없음은 확인된 경우(관측 지연 등): 기관·확인 시각
    const time = kstStamp(view.confirmedAt, nowMs);
    const agency = detail.warningSource
      ? agencyText(detail.warningSource)
      : t("observation.agency.kma");
    sourceTime = time
      ? t("favorites.warning.checked", { source: agency, time })
      : t("favorites.warning.checkedNoTime", { source: agency });
  } else {
    const basis0 = detail.basis[0];
    if (basis0?.scope) zone = renderScopeText(basis0.scope);
    sourceTime =
      joinMeta([
        basis0?.source && agencyText(basis0.source),
        confirmedUntilText(basis0?.at ?? view.confirmedAt, nowMs),
      ]) ?? confirmedUntilText(view.confirmedAt, nowMs);
  }

  const wave = shownMetric(view, beach.stations, "waveHeight");
  const period = shownMetric(view, beach.stations, "wavePeriod");
  const temp = shownMetric(view, beach.stations, "waterTemp");
  const metricsByKey: Record<(typeof METRIC_KEYS)[number], MetricView> = {
    waveHeight: wave,
    wavePeriod: period,
    waterTemp: temp,
  };
  const allNone =
    wave.kind === "none" && period.kind === "none" && temp.kind === "none";

  let measuredAgo: string | null = null;
  let stationNames: string | null = null;

  if (!allNone) {
    const observedItems = METRIC_KEYS.flatMap((key) => {
      const metric = metricsByKey[key];
      return metric.kind === "value"
        ? [{ key, observedAt: metric.observedAt }]
        : [];
    });
    const groups = timeGroups(observedItems, nowMs);
    const ago = (group: TimeGroup) =>
      group.minutes === null
        ? t("observation.timeUnknown")
        : t("observation.measuredAgo", { minutes: group.minutes });
    const shortAgo = (group: TimeGroup) =>
      `${group.keys.map((key) => t(`observation.metric.${key}`)).join("·")} ${
        group.minutes === null
          ? t("observation.timeUnknown")
          : t("observation.agoShort", { minutes: group.minutes })
      }`;
    const [lead, ...rest] = groups;
    if (lead) {
      measuredAgo =
        rest.length > 0
          ? t("home.near.timeWithOthers", {
              main: ago(lead),
              others: rest.map(shortAgo).join(", "),
            })
          : ago(lead);
    } else if (
      wave.kind === "delayed" ||
      period.kind === "delayed" ||
      temp.kind === "delayed"
    ) {
      measuredAgo = t("observation.delayed");
    }

    const names: string[] = [];
    for (const key of METRIC_KEYS) {
      const metric = metricsByKey[key];
      if (metric.kind !== "value" && metric.kind !== "delayed") continue;
      const station = shownStation(metric, beach.stations, key);
      const name = station?.name[locale];
      if (name && !names.includes(name)) names.push(name);
    }
    stationNames = names.length > 0 ? names.join(META_SEPARATOR) : null;
  }

  return {
    metaLine,
    warningInfo: { zone, sourceTime, extraReasons },
    wave,
    period,
    temp,
    allNone,
    measuredAgo,
    stationNames,
  };
}
