"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { MiniWaveChart } from "@/components/home/mini-wave-chart";
import { ReasonBadge } from "@/components/reason-badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { BeachSummary } from "@/lib/beach-summary";
import { localizedPath, type Locale } from "@/lib/i18n";
import { formatKm, joinMeta } from "@/lib/meta-join";
import {
  cardMetric,
  noValueNext,
  statusGroups,
  timeGroups,
  type CardMetric,
  type TimeGroup,
} from "@/lib/near-metric";
import { kstStamp } from "@/lib/snapshot/clock";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import type { BeachView, MetricKey, MetricView } from "@/lib/snapshot/view";

// 가까운 바다 카드 (노션 2장 HOME 7 · 3장 NearCard, Figma S_M01_01 171:379)
// 해변명·지역·거리 + 상태 배지 → 파고·수온·바람 3칸 → 근거 줄(특보 범위 → 기관 → 시각, 파고 측정 시각) + 현장 우선 문구
// 상태는 view를 그대로 씀(G1). 값이 없으면 0이 아니라 "–"(hidden) 또는 '가까운 관측 없음'(none)
// 모양 두 가지(Figma, BRD-129):
//   compact(모바일 171:478): 이름·배지 한 줄 → 3칸 → 근거 줄(특보 범위 · 파고 측정 시각) + 현장 우선 문구
//   wide(PC 181:851): 이름 + › → 배지 → 큰 파고 + 나머지 지표 한 줄 → 24시간 그래프 → 근거 줄.
//     현장 우선 문구는 묶음 제목 줄(home-screen)
// 근거 줄은 Figma 형식으로 줄임(#105 결정 1): 측정소 이름·거리는 상세에만. 출처는 홈 맨 아래 기상청 줄(BRD-113)

// PC 카드 큰 파고 옆 한 줄에 둘 나머지 지표(Figma 181:870 '파고 · 주기 6초 · 수온 21°C', #105 결정 2)
// 파주기는 신선도 60분이 지나면 view가 delayed로 줌 → '늦어짐'
// 바람은 Figma처럼 빼서 한 줄에 맞춤(바람 값은 상세에서)
const WIDE_OTHERS = [
  "wavePeriod",
  "waterTemp",
] as const satisfies readonly MetricKey[];

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

  // [3] 근거. Figma 카드처럼 줄 수를 줄임(#105 결정 1 · 사용자 확인 10/29)
  // 특보 범위: '특보 없음'은 범위·기관·확인 시각이 늘 함께(공통 규칙). 오래된 정보(B5)면 'HH:MM 확인 · 이후 확인 못 함'
  // 관측 시각: 대표 시각 한 번 + 다른 시각의 지표만 괄호로 "20분 전 측정(수온 50분 전)"(Codex P1). 측정소 이름·거리는 상세에만
  // 파고 값이 없으면 이유(가까운 관측 없음 · 측정이 늦어지고 있어요 · 파고 값 없음, Codex P2)
  let scopeText: string | null = null;
  let timeText: string | null = null;
  let waveStatus: string | null = null;
  let hasValue = false; // 카드에 보이는 지표 중 값이 하나라도 있는지(없으면 빈칸 없는 짧은 카드)
  const wave = cardMetric(
    view.kind === "ready" ? view.metrics.waveHeight : null,
    beach.stations.waveHeight !== null,
  );
  const waveLabel = t("observation.metric.waveHeight");
  if (view.kind === "ready") {
    const time = kstStamp(view.confirmedAt, nowMs);
    scopeText = view.stale
      ? confirmedUntilText(view.confirmedAt, nowMs)
      : view.badge.kind === "clear" && time
        ? t(
            variant === "wide"
              ? "home.near.badgeScope"
              : "home.near.clearScope",
            {
              time,
            },
          )
        : null;
    const shownKeys: readonly MetricKey[] =
      variant === "wide" ? ["waveHeight", ...WIDE_OTHERS] : CARD_METRICS;
    const groups = timeGroups(
      shownKeys.flatMap((key) => {
        const metric = cardMetric(
          view.metrics[key],
          beach.stations[key] !== null,
        );
        return metric.kind === "value"
          ? [{ key, observedAt: metric.observedAt }]
          : [];
      }),
      nowMs,
    );
    hasValue = groups.length > 0;
    const labels = (group: TimeGroup) =>
      group.keys.map((key) => t(`observation.metric.${key}`)).join("·");
    const fullAgo = (group: TimeGroup) =>
      group.minutes === null
        ? t("observation.timeUnknown")
        : t("observation.measuredAgo", { minutes: group.minutes });
    const shortAgo = (group: TimeGroup) =>
      `${labels(group)} ${
        group.minutes === null
          ? t("observation.timeUnknown")
          : t("observation.agoShort", { minutes: group.minutes })
      }`;
    const [lead, ...rest] = groups;
    if (lead) {
      // 파고 값이 있으면 대표 시각은 파고(맨 앞 묶음). 없으면 대표 묶음의 지표 이름을 붙임
      const main =
        wave.kind === "value"
          ? fullAgo(lead)
          : `${labels(lead)} ${fullAgo(lead)}`;
      timeText =
        rest.length > 0
          ? t("home.near.timeWithOthers", {
              main,
              others: rest.map(shortAgo).join(", "),
            })
          : main;
    }
    waveStatus =
      wave.kind === "none"
        ? joinMeta([waveLabel, t("observation.none")])
        : wave.kind === "delayed"
          ? joinMeta([waveLabel, t("observation.delayed")])
          : wave.kind === "missing"
            ? t("row.noValue")
            : null;
  }

  // 값이 하나도 없을 때의 이유 줄(같은 이유는 한 줄로 묶음)과 이유에 맞는 다음 행동(lib/near-metric.ts)
  const noValueKeys: readonly MetricKey[] =
    variant === "wide" ? ["waveHeight", ...WIDE_OTHERS] : CARD_METRICS;
  const reasonGroups = statusGroups(
    noValueKeys.map((key) => ({
      key,
      metric: cardMetric(
        view.kind === "ready" ? view.metrics[key] : null,
        beach.stations[key] !== null,
      ),
    })),
  );
  const GROUP_KEY = {
    none: "home.near.groupNone",
    delayed: "home.near.groupDelayed",
    missing: "home.near.groupMissing",
  } as const;
  const reasonLines = reasonGroups.map((group) =>
    t(GROUP_KEY[group.kind], {
      metrics: group.keys
        .map((key) => t(`observation.metric.${key}`))
        .join("·"),
    }),
  );
  const next = noValueNext(reasonGroups);
  const nextText =
    next === "waitNew"
      ? t("home.near.noValueNext")
      : next === "seeBadge"
        ? t("home.near.noStationNext")
        : null;

  const badge =
    // 첫 응답 전에는 배지 자리만 회색으로(빈 배지나 '특보 없음'을 미리 보이지 않게)
    view.kind === "ready" ? (
      <ReasonBadge label={view.badge} />
    ) : (
      <Skeleton className="h-badge w-20 rounded-badge" />
    );
  const href = localizedPath(locale, `/spots/${beach.slug}/`);

  // [4] PC(Figma 181:851): 이름 + › → 배지(옆에 특보 범위) → 큰 파고 + 나머지 지표 → 24시간 그래프 → 캡션 한 줄
  // 값이 하나도 없으면 큰 숫자·그래프 자리를 빼고 이유와 다음 행동만(빈칸 없는 짧은 카드)
  if (variant === "wide") {
    const others = WIDE_OTHERS.map((key) => ({
      key,
      metric: cardMetric(
        view.kind === "ready" ? view.metrics[key] : null,
        beach.stations[key] !== null,
      ),
    })).filter((item) => item.metric.kind !== "loading");
    const otherLine = others.map(({ key, metric }, index) => (
      <span key={key}>
        {(index > 0 || wave.kind === "value") && " · "}
        {/* 파주기 값은 상세와 같은 '파주기 6초' */}
        {key === "wavePeriod" && metric.kind === "value" ? (
          t("detail.sea.period", { value: metric.value })
        ) : (
          <>
            {t(`observation.metric.${key}`)}{" "}
            <InlineMetric
              metric={metric}
              none={t("observation.none")}
              delayed={t("observation.delayedShort")}
              empty={t("home.near.noValue")}
            />
          </>
        )}
      </span>
    ));
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
        {/* 배지 옆(좁으면 아래)에 특보 범위·기관·확인 시각 */}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {badge}
          {scopeText && (
            <span className="text-caption text-text-muted">{scopeText}</span>
          )}
        </span>
        {view.kind !== "ready" ? (
          <Skeleton className="h-[30px] w-24" />
        ) : !hasValue ? (
          // 값 없음: 이유(같은 이유는 한 줄) → 이유에 맞는 다음 행동
          <span className="flex flex-col gap-0.5 text-caption text-text-muted">
            {reasonLines.map((line) => (
              <span key={line} className="text-body-s">
                {line}
              </span>
            ))}
            {nextText && <span>{nextText}</span>}
          </span>
        ) : (
          <>
            <span className="flex flex-wrap items-baseline gap-x-1.5">
              {wave.kind === "value" ? (
                <>
                  <span className="text-num-card text-text-default">
                    {wave.value}
                  </span>
                  <span className="text-body font-bold text-text-default">
                    {wave.unit}
                  </span>
                  <span className="pl-1 text-caption text-text-muted">
                    {waveLabel}
                    {otherLine}
                  </span>
                </>
              ) : (
                <span className="flex flex-col text-caption text-text-muted">
                  <span className="text-body-s">{waveStatus}</span>
                  <span>{otherLine}</span>
                </span>
              )}
            </span>
            {/* 24시간 파고(상세와 같은 기록·규칙). 가까운 관측 없음이면 그리지 않음. 실패·빈 기록이면 자리도 비우지 않음 */}
            {wave.kind !== "none" && beach.stations.waveHeight && (
              <MiniWaveChart
                stationId={beach.stations.waveHeight.id}
                latest={
                  wave.kind === "value"
                    ? { t: Date.parse(wave.observedAt), v: wave.value }
                    : null
                }
                nowMs={nowMs}
              />
            )}
            {timeText && (
              <span className="text-caption text-text-muted">
                {wave.kind === "value"
                  ? joinMeta([t("home.near.last24h"), timeText])
                  : timeText}
              </span>
            )}
          </>
        )}
      </Link>
    );
  }

  // 모바일 근거 줄(Figma 171:499): 특보 범위 / 관측 시각 · 파고 / 현장 우선 문구
  const notes: string[] = [];
  if (scopeText) notes.push(scopeText);
  if (wave.kind === "value") {
    const line = joinMeta([timeText, `${waveLabel} ${wave.value}${wave.unit}`]);
    if (line) notes.push(line);
  } else if (view.kind === "ready" && !hasValue) {
    // 값이 하나도 없으면 칸 대신 이유 묶음 + 다음 행동(PC와 같은 규칙)
    notes.push(...reasonLines);
    if (nextText) notes.push(nextText);
  } else {
    if (waveStatus) notes.push(waveStatus);
    if (timeText) notes.push(timeText);
  }
  notes.push(t("safety.finalCall"));
  const noteList = (
    // 근거 줄 12/18.6(Figma 171:499)
    <span className="flex flex-col border-t border-border-default pt-[11px] text-note text-text-muted">
      {notes.map((note) => (
        <span key={note}>{note}</span>
      ))}
    </span>
  );

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

      {/* 값이 하나도 없으면 "–" 3칸 대신 근거 줄의 이유만(빈칸 없는 짧은 카드) */}
      {(view.kind !== "ready" || hasValue) && (
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
      )}

      {noteList}
    </Link>
  );
}

// [6] PC 나머지 지표 한 줄의 값 자리. 결측은 "–"를 보이고 화면 읽기에는 '값 없음'
function InlineMetric({
  metric,
  none,
  delayed,
  empty,
}: {
  metric: CardMetric;
  none: string;
  delayed: string;
  empty: string;
}) {
  if (metric.kind === "value") return <>{`${metric.value}${metric.unit}`}</>;
  if (metric.kind === "none") return <>{none}</>;
  if (metric.kind === "delayed") return <>{delayed}</>;
  return (
    <>
      <span aria-hidden="true">–</span>
      <span className="sr-only">{empty}</span>
    </>
  );
}

// [7] 지표 한 칸. metric이 null이면 아직 불러오는 중(회색 상자)
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
