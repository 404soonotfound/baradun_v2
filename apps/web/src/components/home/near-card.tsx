"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { SkyGlyph } from "@/components/detail/weather-card";
import { MiniWaveChart } from "@/components/home/mini-wave-chart";
import { ReasonBadge } from "@/components/reason-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { type Activity, useActivity } from "@/lib/activity";
import type { BeachSummary } from "@/lib/beach-summary";
import { compassPoint } from "@/lib/direction";
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
import { useStationHistory } from "@/lib/snapshot/history";
import { useBadgeText } from "@/lib/snapshot/use-badge-text";
import { useMetaText } from "@/lib/snapshot/use-meta-text";
import type { BeachView, MetricKey } from "@/lib/snapshot/view";
import { useBeachWeather, type WeatherView } from "@/lib/snapshot/weather";
import { waveChart } from "@/lib/wave-chart";
import { hourCells, kstDay, type HourCell } from "@/lib/weather";

// 홈 해변 카드 (노션 2장 HOME 7 · 3장 NearCard, 11/5 홈 v3 시안 ActR_M_V3SW·SF·SC · P_V3*)
// 모바일·PC 같은 모양: 배지 + › → 이름 → 거리(또는 지역) · 측정 시각 → 큰 값 2칸 → 회색 그림 칸 → 아래 한 줄
// 고른 활동에 맞춘 요약(상세는 활동과 관계없이 같은 순서). 상태는 view를 그대로 씀(G1)
//   수영: 수온 · 파고 / 오늘 날씨 줄 / 바람
//   서핑: 파고 · 파주기 / 24시간 파고 선 / 파도 방향 · 바람
//   스쿠버다이빙: 파고 · 바람 / 앞으로 바람(상세 날씨 카드 바람 줄과 같은 모양, D18-5) / 수온 · 파도 방향
// 값이 없으면 0이 아니라 '가까운 관측 없음' · '늦어짐' · "–". 날씨는 참고 정보라 분류에 쓰지 않음
// 특보 범위 줄(D18-11 ①)은 카드마다 남김: 묶음 머리 한 줄로 줄이는 시안은 노션 결정 전이라 보류

type CardLayout = {
  big: readonly [MetricKey, MetricKey];
  line: readonly MetricKey[];
};

// 빈 상태 미리보기(activity-empty)도 같은 칸 이름을 씀
export const CARD_LAYOUT: Record<Activity, CardLayout> = {
  swimming: { big: ["waterTemp", "waveHeight"], line: ["wind"] },
  surfing: {
    big: ["waveHeight", "wavePeriod"],
    line: ["waveDirection", "wind"],
  },
  scuba: { big: ["waveHeight", "wind"], line: ["waterTemp", "waveDirection"] },
};

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
  distanceKm: number | null; // 위치가 없으면 null(거리 대신 지역)
  view: BeachView;
  nowMs: number;
}) {
  const t = useTranslations();
  const activity = useActivity();
  const { confirmedUntilText } = useBadgeText();
  const { zonesText } = useMetaText();
  const layout = CARD_LAYOUT[activity];

  const metricOf = (key: MetricKey): CardMetric =>
    cardMetric(
      view.kind === "ready" ? view.metrics[key] : null,
      beach.stations[key] !== null,
    );
  const shownKeys = [...layout.big, ...layout.line];

  // [2] 근거: 특보 범위(범위·기관·확인 시각이 늘 함께) + 관측 시각(대표 시각 한 번, 다른 시각은 괄호)
  let scopeText: string | null = null;
  let timeText: string | null = null;
  let hasValue = false;
  if (view.kind === "ready") {
    const time = kstStamp(view.confirmedAt, nowMs);
    scopeText = view.stale
      ? confirmedUntilText(view.confirmedAt, nowMs)
      : view.badge.kind === "clear" && time
        ? t("home.near.clearScope", {
            zones: zonesText(beach.warningZones),
            time,
          })
        : null;
    const groups = timeGroups(
      shownKeys.flatMap((key) => {
        const metric = metricOf(key);
        return metric.kind === "value"
          ? [{ key, observedAt: metric.observedAt }]
          : [];
      }),
      nowMs,
    );
    hasValue = groups.length > 0;
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
      timeText =
        rest.length > 0
          ? t("home.near.timeWithOthers", {
              main: ago(lead),
              others: rest.map(shortAgo).join(", "),
            })
          : ago(lead);
    }
  }

  // 값이 하나도 없을 때의 다음 행동(lib/near-metric.ts)
  const next =
    view.kind === "ready" && !hasValue
      ? noValueNext(
          statusGroups(
            shownKeys.map((key) => ({ key, metric: metricOf(key) })),
          ),
        )
      : null;
  const nextText =
    next === "waitNew"
      ? t("home.near.noValueNext")
      : next === "seeBadge"
        ? t("home.near.noStationNext")
        : null;

  const km = distanceKm === null ? null : formatKm(distanceKm);
  const meta = joinMeta([km ? `${km}km` : beach.region, timeText]);

  // 아래 한 줄: '바람 5.9m/s' · '파도 방향 남남동쪽에서' · '수온 21.6°C'
  const lineText = (key: MetricKey) => {
    const metric = metricOf(key);
    const label = t(`observation.metric.${key}`);
    if (metric.kind === "value") {
      return key === "waveDirection"
        ? t("home.card.directionFrom", {
            dir: t(`observation.direction.${compassPoint(metric.value)}`),
          })
        : `${label} ${metric.value}${metric.unit}`;
    }
    if (metric.kind === "none") return `${label} ${t("observation.none")}`;
    if (metric.kind === "delayed")
      return `${label} ${t("observation.delayedShort")}`;
    if (metric.kind === "missing") return `${label} ${t("home.near.noValue")}`;
    return null;
  };
  const lines = layout.line.flatMap((key) => {
    const text = lineText(key);
    return text ? [text] : [];
  });

  return (
    <Link
      href={localizedPath(locale, `/spots/${beach.slug}/`)}
      className="group flex h-full flex-col gap-3 rounded-[16px] border border-border-default bg-bg-surface px-4 pt-3.5 pb-4 shadow-card transition-colors hover:border-border-strong"
    >
      <span className="flex items-center justify-between gap-2">
        {/* 첫 응답 전에는 배지 자리만 회색으로(빈 배지나 '특보 없음'을 미리 보이지 않게) */}
        {view.kind === "ready" ? (
          <ReasonBadge label={view.badge} />
        ) : (
          <Skeleton className="h-badge w-20 rounded-badge" />
        )}
        <ChevronRight
          aria-hidden="true"
          size={16}
          className="shrink-0 text-text-muted group-hover:text-text-default"
        />
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="truncate text-[17px] leading-[1.3] font-bold tracking-[-0.3px] text-text-default">
          {beach.name}
        </span>
        {meta && (
          <span className="truncate text-caption text-text-muted">{meta}</span>
        )}
      </span>

      <span className="grid grid-cols-2 gap-3">
        {layout.big.map((key) => (
          <BigMetric
            key={key}
            label={t(`observation.metric.${key}`)}
            metric={metricOf(key)}
          />
        ))}
      </span>

      {activity === "swimming" && (
        <TodayWeather beachId={beach.id} region={beach.region} nowMs={nowMs} />
      )}
      {activity === "surfing" && (
        <WaveStrip
          stationId={beach.stations.waveHeight?.id ?? null}
          wave={metricOf("waveHeight")}
          nowMs={nowMs}
        />
      )}
      {activity === "scuba" && <WindAhead beachId={beach.id} nowMs={nowMs} />}

      <span className="mt-auto flex flex-col gap-1 text-caption">
        {lines.length > 0 && (
          <span className="flex flex-wrap gap-x-1 text-text-body">
            {lines.map((line, index) => (
              <span key={line} className="whitespace-nowrap">
                {index > 0 && <span aria-hidden="true">· </span>}
                {line}
              </span>
            ))}
          </span>
        )}
        {scopeText && <span className="text-text-muted">{scopeText}</span>}
        {nextText && <span className="text-text-muted">{nextText}</span>}
        {/* 모바일은 카드 근처에 현장 우선 문구. PC는 묶음 아래 줄에 한 번(home-screen) */}
        <span className="text-note text-text-muted lg:hidden">
          {t("safety.finalCall")}
        </span>
      </span>
    </Link>
  );
}

// [3] 큰 값 한 칸. 값이 없으면 이유 글자(0으로 그리지 않음)
function BigMetric({ label, metric }: { label: string; metric: CardMetric }) {
  const t = useTranslations();
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-caption text-text-muted">{label}</span>
      {metric.kind === "loading" ? (
        <Skeleton className="h-[26px] w-16" />
      ) : metric.kind === "value" ? (
        <span className="flex items-baseline gap-0.5 text-text-default">
          <span className="text-[26px] leading-none font-bold tracking-[-0.6px] tabular-nums">
            {metric.value}
          </span>
          <span className="text-label-s font-bold">
            {metric.unit === "s" ? t("home.card.seconds") : metric.unit}
          </span>
        </span>
      ) : (
        <span className="flex h-[26px] items-end text-label-s font-bold text-text-muted">
          {metric.kind === "none" ? (
            t("observation.none")
          ) : metric.kind === "delayed" ? (
            t("observation.delayedShort")
          ) : (
            <>
              <span aria-hidden="true">–</span>
              <span className="sr-only">{t("home.near.noValue")}</span>
            </>
          )}
        </span>
      )}
    </span>
  );
}

// 회색 그림 칸 틀(시안 rounded 10 · 안쪽 높이 49)
function PictureBox({ children }: { children: React.ReactNode }) {
  return (
    <span className="block rounded-[10px] bg-bg-subtle px-3 pt-2.5 pb-2">
      {children}
    </span>
  );
}

function PictureNote({ children }: { children: React.ReactNode }) {
  return (
    <PictureBox>
      <span className="flex h-[49px] items-center text-caption text-text-muted">
        {children}
      </span>
    </PictureBox>
  );
}

// 오늘(한국 날짜) 남은 3시간 칸. 지금 시각을 모르면 빈 배열(hourCells)
function todayCells(weather: WeatherView, nowMs: number): HourCell[] {
  if (weather.kind !== "ready" || weather.grid.short === null) return [];
  return hourCells(weather.grid.short.points, nowMs).filter(
    (cell) => cell.day === 0,
  );
}

// [4] 수영: 오늘 날씨 줄 (11/5 결정: 하루 요약)
// 하늘 = 오늘 남은 첫 3시간 칸, 강수확률 = 오늘 남은 칸 중 가장 높은 값(값이 있는 칸만), 최저·최고 = publisher 오늘 값
// 지금 기온은 실황이라 시각을 따로 붙임(예보 발표 시각과 섞지 않음). 값이 없는 자리는 그리지 않음(0·맑음으로 채우지 않음)
function TodayWeather({
  beachId,
  region,
  nowMs,
}: {
  beachId: string;
  region: string;
  nowMs: number;
}) {
  const t = useTranslations();
  const weather = useBeachWeather(beachId);
  if (weather.kind === "none") return null;
  if (weather.kind === "loading") {
    return (
      <PictureBox>
        <Skeleton className="h-[49px] w-full" />
      </PictureBox>
    );
  }
  if (weather.kind === "failed") {
    return <PictureNote>{t("home.card.weatherFailed")}</PictureNote>;
  }
  const { grid } = weather;
  const cells = todayCells(weather, nowMs);
  const first = cells[0] ?? null;
  const pops = cells.flatMap((c) => (c.pop === null ? [] : [c.pop]));
  const pop = pops.length > 0 ? Math.round(Math.max(...pops)) : null;
  // publisher 오늘 값은 그 날짜가 지금 한국 날짜일 때만 '오늘'로 씀(이전 파일·시각 모름이면 그리지 않음)
  const isToday = Number.isFinite(nowMs) && grid.today.date === kstDay(nowMs);
  const min = isToday ? grid.today.min : null;
  const max = isToday ? grid.today.max : null;
  const now = grid.now;
  const nowTime = now ? kstStamp(now.observedAt, nowMs) : null;
  const issued = grid.short ? kstStamp(grid.short.issuedAt, nowMs) : null;
  if (min === null && max === null && !now && !first) {
    return <PictureNote>{t("home.card.weatherFailed")}</PictureNote>;
  }

  const round = (v: number) => Math.round(v);
  // 읽는 글: 값이 있는 것만 ", "로 이음
  const label = [
    first?.word
      ? t("home.card.todaySky", {
          region,
          sky: t(`detail.weather.sky.${first.word}`),
        })
      : t("home.card.today", { region }),
    now && nowTime
      ? t("home.card.nowAt", {
          temperature: round(now.temperature),
          time: nowTime,
        })
      : null,
    min !== null ? t("home.card.min", { value: round(min) }) : null,
    max !== null ? t("home.card.max", { value: round(max) }) : null,
    pop !== null ? t("home.card.pop", { value: pop }) : null,
    issued ? t("home.card.issued", { time: issued }) : null,
  ]
    .filter(Boolean)
    .join(", ");
  // 막대: 오늘 최저~최고 칸, 점 = 지금 기온(범위 밖이면 끝에 붙임)
  const dot =
    now && min !== null && max !== null
      ? Math.min(
          100,
          Math.max(0, ((now.temperature - min) / (max - min || 1)) * 100),
        )
      : null;

  return (
    <PictureBox>
      <span
        role="img"
        aria-label={label}
        className="flex h-[49px] flex-col justify-center gap-1"
      >
        <span aria-hidden="true" className="flex items-center gap-2.5">
          <span className="flex w-7 shrink-0 flex-col items-center leading-none">
            {first && <SkyGlyph icon={first.icon} />}
            {pop !== null && (
              <span className="mt-0.5 text-[10px] font-bold text-brand-default">
                {pop}%
              </span>
            )}
          </span>
          <span className="w-8 shrink-0 text-right text-label-s font-medium text-text-muted tabular-nums">
            {min === null ? "–" : `${round(min)}°`}
          </span>
          <span className="relative h-1.5 flex-1 rounded-full bg-chart/25">
            {dot !== null && (
              <span
                className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg-subtle bg-text-default"
                style={{ left: `${dot}%` }}
              />
            )}
          </span>
          <span className="w-8 shrink-0 text-label-s font-bold text-text-default tabular-nums">
            {max === null ? "–" : `${round(max)}°`}
          </span>
        </span>
        <span
          aria-hidden="true"
          className="truncate text-[10.5px] text-text-muted"
        >
          {joinMeta([
            t("home.card.todayTemp"),
            now && nowTime
              ? t("home.card.nowShort", {
                  temperature: round(now.temperature),
                  time: nowTime,
                })
              : null,
            issued ? t("home.card.issuedShort", { time: issued }) : null,
          ])}
        </span>
      </span>
    </PictureBox>
  );
}

// [5] 서핑: 24시간 파고 선(상세와 같은 기록·규칙) + 최고·최저(그린 값에서 표시용으로만 셈)
function WaveStrip({
  stationId,
  wave,
  nowMs,
}: {
  stationId: string | null;
  wave: CardMetric;
  nowMs: number;
}) {
  const t = useTranslations();
  const history = useStationHistory(stationId);
  if (stationId === null || wave.kind === "none") {
    return <PictureNote>{t("home.card.waveNoStation")}</PictureNote>;
  }
  if (history.kind === "loading") {
    return (
      <PictureBox>
        <Skeleton className="h-[49px] w-full" />
      </PictureBox>
    );
  }
  // 받지 못함·지금 시각 모름은 '기록 없음'이 아니라 실패로 알림(실패를 빈 기록으로 보이지 않게)
  if (history.kind === "failed" || !Number.isFinite(nowMs)) {
    return <PictureNote>{t("home.card.waveFailed")}</PictureNote>;
  }
  const latest =
    wave.kind === "value"
      ? { t: Date.parse(wave.observedAt), v: wave.value }
      : null;
  const chart =
    history.history !== null
      ? waveChart(history.history.points, nowMs, latest)
      : null;
  if (!chart || chart.kind === "empty") {
    return <PictureNote>{t("home.card.waveNoRecord")}</PictureNote>;
  }
  // 최고는 그래프 읽는 글(MiniWaveChart)과 같은 maxV, 최저도 그린 점 + 지금 값에서 셈
  const minV = Math.min(
    ...chart.runs.flat().map((p) => p.v),
    ...(chart.current ? [chart.current.v] : []),
  );
  return (
    <PictureBox>
      <span className="flex h-[49px] w-full flex-col justify-between">
        <MiniWaveChart
          stationId={stationId}
          latest={latest}
          nowMs={nowMs}
          className="h-9"
        />
        <span
          aria-hidden="true"
          className="flex justify-between text-[10.5px] leading-none text-text-muted"
        >
          <span>{t("detail.chart.dayAgo")}</span>
          <span>
            {t("home.card.waveRange", { max: chart.maxV, min: minV })}
          </span>
          <span>{t("detail.chart.now")}</span>
        </span>
      </span>
    </PictureBox>
  );
}

// [6] 스쿠버다이빙: 앞으로 바람 7칸(3시간 간격). 칸 폭은 카드 폭에 맞춰 나눔(상세 바람 줄은 36px 고정)
const WIND_CELLS = 7;
function WindAhead({ beachId, nowMs }: { beachId: string; nowMs: number }) {
  const t = useTranslations();
  const weather = useBeachWeather(beachId);
  if (weather.kind === "none") return null;
  if (weather.kind === "loading") {
    return (
      <PictureBox>
        <Skeleton className="h-[49px] w-full" />
      </PictureBox>
    );
  }
  const short = weather.kind === "ready" ? weather.grid.short : null;
  const cells = short
    ? hourCells(short.points, nowMs).slice(0, WIND_CELLS)
    : [];
  const issued = short ? kstStamp(short.issuedAt, nowMs) : null;
  if (cells.length === 0 || !issued) {
    return <PictureNote>{t("home.card.windFailed")}</PictureNote>;
  }
  const label = t("home.card.windAheadLabel", {
    cells: cells
      .map((cell) =>
        cell.windSpeed === null || cell.windTo === null
          ? t("home.card.windCellNoValue", { hour: cell.hour })
          : t("home.card.windCell", {
              hour: cell.hour,
              dir: t(
                `observation.direction.${compassPoint((cell.windTo + 180) % 360)}`,
              ),
              speed: Math.round(cell.windSpeed),
            }),
      )
      .join(", "),
    time: issued,
  });
  // 면 그래프: 값이 이어진 구간마다 한 조각(값이 없는 칸에서 끊음, 0으로 그리지 않음)
  const max = Math.max(1, ...cells.map((c) => c.windSpeed ?? 0));
  const x = (i: number) => i * 10 + 5;
  const y = (v: number) => 20 - (v / max) * 17;
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  cells.forEach((cell, i) => {
    if (cell.windSpeed === null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push({ x: x(i), y: y(cell.windSpeed) });
  });
  if (run.length) runs.push(run);

  return (
    <PictureBox>
      <span role="img" aria-label={label} className="flex flex-col gap-1">
        <span
          aria-hidden="true"
          className="flex items-baseline justify-between gap-2"
        >
          <span className="truncate text-[10.5px] text-text-muted">
            {t.rich("home.card.windAhead", {
              b: (chunks) => <b className="text-text-body">{chunks}</b>,
            })}
          </span>
          <span className="shrink-0 text-[10.5px] text-text-muted">
            {t("home.card.forecastAt", { time: issued })}
          </span>
        </span>
        <span aria-hidden="true" className="grid grid-cols-7">
          {cells.map((cell) => (
            <span key={cell.at} className="flex flex-col items-center gap-0.5">
              <span className="text-[10px] leading-none text-text-muted tabular-nums">
                {t("detail.weather.hour", { hour: cell.hour })}
              </span>
              <span className="text-text-body">
                {cell.windTo === null || cell.windSpeed === null ? (
                  <span className="block size-[11px]" />
                ) : (
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 12 12"
                    className="shrink-0"
                    style={{
                      transform: `rotate(${Math.round(cell.windTo)}deg)`,
                    }}
                  >
                    <path
                      d="M6 10.5V1.8M2.6 5.1 6 1.6l3.4 3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              <span className="text-label-s leading-none font-bold text-text-default tabular-nums">
                {cell.windSpeed === null ? "–" : Math.round(cell.windSpeed)}
              </span>
            </span>
          ))}
        </span>
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${WIND_CELLS * 10} 20`}
          preserveAspectRatio="none"
          className="block h-5 w-full"
        >
          {runs.map((points) => {
            const line = points
              .map((p, j) => `${j ? "L" : "M"}${p.x},${p.y.toFixed(1)}`)
              .join(" ");
            return (
              <g key={points[0]!.x}>
                <path
                  d={`${line} L${points.at(-1)!.x},20 L${points[0]!.x},20 Z`}
                  className="fill-chart"
                  fillOpacity={0.14}
                />
                <path
                  d={line}
                  fill="none"
                  className="stroke-chart"
                  strokeWidth={1.6}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              </g>
            );
          })}
        </svg>
      </span>
    </PictureBox>
  );
}
