"use client";

import {
  ChevronDown,
  ChevronUp,
  Cloud,
  CloudHail,
  CloudMoon,
  CloudRain,
  CloudRainWind,
  CloudSnow,
  CloudSun,
  type LucideIcon,
  Moon,
  Sun,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { WEATHER_COLUMN, WindRow } from "@/components/weather/wind-row";
import type { Locale } from "@/lib/i18n";
import { kstStamp } from "@/lib/snapshot/clock";
import type { WeatherView } from "@/lib/snapshot/weather";
import {
  type DayCell,
  type HourCell,
  hourCells,
  laterDays,
  monthDay,
  type SkyIcon,
  type SkyWord,
} from "@/lib/weather";

// 상세 날씨 카드 (BRD-185 · 결정 기록 18장 D18-1·D18-2·D18-8·D18-9·D18-10, 노션 2장 DET 6-1 · 3장 WeatherCard)
// 시안 ActR_D_WXM·WXMOPEN·WXMMID·WXMALL·ActR_D_PLD·PLDOPEN(실제 앱 작업 복사본의 마크업을 따름)
// 머리('날씨' + 지금 기온 · 발표 줄) → 시간 줄(시각 · 하늘 · 기온 선 · 강수확률) → 바람 줄 → 이후 며칠 펼침 → 참고 정보 문구
// 날씨는 참고 정보. 분류·관측 지연·대안 해변에 쓰지 않음(G1). 받은 값을 그리기만 하고 다시 계산하지 않음
// 값이 빠진 칸은 '–'(0·맑음으로 그리지 않음). 기온 선은 한 색, 좋음·나쁨 색 없음

const ICONS: Record<Exclude<SkyIcon, "unknown">, LucideIcon> = {
  sun: Sun,
  moon: Moon,
  cloudSun: CloudSun,
  cloudMoon: CloudMoon,
  cloud: Cloud,
  rain: CloudRain,
  shower: CloudRainWind,
  snow: CloudSnow,
  rainSnow: CloudHail,
};

// 강수는 브랜드 파랑, 해는 wx-sun 토큰, 나머지는 본문색(시안). 뜻은 글자(칸별 읽는 글)가 맡음
function SkyGlyph({ icon }: { icon: SkyIcon }) {
  if (icon === "unknown") {
    return (
      <span className="flex size-[18px] items-center justify-center text-[11px] text-text-muted">
        –
      </span>
    );
  }
  const Icon = ICONS[icon];
  const tone =
    icon === "sun"
      ? "text-wx-sun"
      : icon === "rain" ||
          icon === "shower" ||
          icon === "snow" ||
          icon === "rainSnow"
        ? "text-brand-default"
        : "text-text-body";
  return <Icon size={18} strokeWidth={2} className={tone} aria-hidden="true" />;
}

// 기온 선: 값이 이어진 구간마다 선, 칸마다 점과 숫자. 시안 높이 46(위 16 ~ 아래 38)
const LINE_H = 46;
function TemperatureLine({ cells }: { cells: readonly HourCell[] }) {
  const temps = cells.flatMap((c) =>
    c.temperature === null ? [] : [c.temperature],
  );
  const max = Math.max(...temps);
  const min = Math.min(...temps);
  const y = (t: number) => 16 + ((max - t) / (max - min || 1)) * 22;
  const x = (i: number) => i * WEATHER_COLUMN + WEATHER_COLUMN / 2;
  const runs: string[] = [];
  let run: string[] = [];
  cells.forEach((cell, i) => {
    if (cell.temperature === null) {
      if (run.length > 1) runs.push(run.join(" "));
      run = [];
    } else run.push(`${x(i)},${y(cell.temperature).toFixed(1)}`);
  });
  if (run.length > 1) runs.push(run.join(" "));
  return (
    <svg
      width={cells.length * WEATHER_COLUMN}
      height={LINE_H}
      className="block overflow-visible"
    >
      {runs.map((points, i) => (
        <polyline
          key={i}
          points={points}
          fill="none"
          className="stroke-chart"
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
      ))}
      {cells.map((cell, i) =>
        cell.temperature === null ? (
          <text
            key={i}
            x={x(i)}
            y={LINE_H / 2}
            textAnchor="middle"
            fontSize={11.5}
            className="fill-text-muted"
          >
            –
          </text>
        ) : (
          <g key={i}>
            <circle
              cx={x(i)}
              cy={y(cell.temperature)}
              r={2.4}
              className="fill-bg-surface stroke-chart"
              strokeWidth={1.4}
            />
            <text
              x={x(i)}
              y={y(cell.temperature) - 6}
              textAnchor="middle"
              fontSize={11.5}
              fontWeight={700}
              className="fill-text-default"
            >
              {Math.round(cell.temperature)}°
            </text>
          </g>
        ),
      )}
    </svg>
  );
}

export function WeatherCard({
  weather,
  region,
  locale,
  nowMs,
}: {
  weather: WeatherView;
  region: string; // '강원 강릉시'(D18-10 시·군 이름)
  locale: Locale;
  nowMs: number;
}) {
  const t = useTranslations("detail.weather");
  const titleId = useId();
  const laterId = useId();
  const [open, setOpen] = useState(false);

  if (weather.kind === "none") return null;

  const grid = weather.kind === "ready" ? weather.grid : null;
  const short = grid?.short ?? null;
  const cells = short ? hourCells(short.points, nowMs) : [];
  const nowStamp = grid?.now ? kstStamp(grid.now.observedAt, nowMs) : null;

  const head = (
    <div className="flex items-baseline justify-between gap-3">
      <h2
        id={titleId}
        className="shrink-0 text-title-s text-text-default lg:text-title-m"
      >
        {t("title")}
      </h2>
      {grid?.now && nowStamp && (
        <p className="min-w-0 text-right text-caption text-text-muted">
          {t.rich("now", {
            temperature: Math.round(grid.now.temperature),
            time: nowStamp,
            b: (chunks) => (
              <b className="text-label font-bold text-text-default tabular-nums">
                {chunks}
              </b>
            ),
          })}
        </p>
      )}
    </div>
  );

  // 불러오는 중: 카드 자리만(값을 미리 보이지 않음)
  if (weather.kind === "loading") {
    return (
      <section
        aria-labelledby={titleId}
        className="flex flex-col gap-2.5 rounded-card bg-bg-surface p-4 shadow-card lg:px-5 lg:py-4"
      >
        {head}
        <div role="status" className="flex flex-col gap-2">
          <Skeleton className="h-[120px] w-full" />
          <span className="text-caption text-text-muted">{t("loading")}</span>
        </div>
      </section>
    );
  }

  // 전부 못 받음(파일·격자·단기예보 없음): 카드 자리에 안내 한 줄. 특보·측정값은 그대로(시안 WXMALL)
  if (!short || cells.length === 0) {
    return (
      <section
        aria-labelledby={titleId}
        className="flex flex-col gap-2.5 rounded-card bg-bg-surface p-4 shadow-card lg:gap-0 lg:p-0"
      >
        <div className="lg:px-5 lg:pt-4">{head}</div>
        <p className="text-body-s text-text-body lg:px-5 lg:pt-2 lg:pb-4">
          {t.rich("failed", {
            b: (chunks) => <b className="text-text-default">{chunks}</b>,
          })}
        </p>
      </section>
    );
  }

  const issued = kstStamp(short.issuedAt, nowMs);
  const dayText = (cell: HourCell) => t(`day.${cell.day}`);
  const skyText = (word: SkyWord | null) =>
    word ? t(`sky.${word}`) : t("skyUnknown");
  const valueText = (
    key: "temperature" | "pop" | "windSpeed",
    v: number | null,
  ) => (v === null ? t("noValue") : t(key, { value: Math.round(v) }));

  const width = cells.length * WEATHER_COLUMN;
  const dayStarts = cells.flatMap((cell, i) => (cell.dayStart ? [i] : []));

  const later =
    weather.kind === "ready"
      ? laterDays(short, weather.midLand, weather.midTa, nowMs)
      : { days: [], midFailed: true };
  const weekday = (date: string) =>
    new Intl.DateTimeFormat(locale, {
      weekday: "short",
      timeZone: "Asia/Seoul",
    }).format(new Date(`${date}T03:00:00Z`));
  const range =
    later.days.length === 0
      ? null
      : later.days.length === 1
        ? weekday(later.days[0]!.date)
        : `${weekday(later.days[0]!.date)}~${weekday(later.days.at(-1)!.date)}`;
  const Chevron = open ? ChevronUp : ChevronDown;

  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-card bg-bg-surface p-4 shadow-card lg:gap-0 lg:p-0"
    >
      <div className="flex flex-col gap-1 pb-1.5 lg:px-5 lg:pt-4 lg:pb-2">
        {head}
        {issued && (
          <p className="text-[11.5px] text-text-muted">
            {t("issued", { region, time: issued })}
          </p>
        )}
      </div>

      <div className="relative -mx-4 lg:mx-0">
        {/* 화면 읽기: 칸마다 한 문장. 그림 줄은 aria-hidden */}
        <ol className="sr-only">
          {cells.map((cell) => (
            <li key={cell.at}>
              {t("cell", {
                day: dayText(cell),
                hour: t("hour", { hour: cell.hour }),
                sky: skyText(cell.word),
                temperature: valueText("temperature", cell.temperature),
                pop: valueText("pop", cell.pop),
                wind: valueText("windSpeed", cell.windSpeed),
              })}
            </li>
          ))}
        </ol>
        {/* 모바일은 옆으로 넘기고 오른쪽 끝을 흐리게, PC는 한 줄(칸이 많으면 넘김) */}
        <div
          aria-hidden="true"
          className="overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:px-5"
        >
          <div className="relative" style={{ width }}>
            {dayStarts
              .filter((i) => i > 0)
              .map((i) => (
                <span
                  key={i}
                  className="absolute top-0 bottom-0 w-px bg-border-default"
                  style={{ left: i * WEATHER_COLUMN }}
                />
              ))}
            <div className="relative h-4">
              {dayStarts.map((i) => {
                const cell = cells[i]!;
                return (
                  <span
                    key={i}
                    className="absolute top-0 pl-1 text-[11px] leading-4 font-bold whitespace-nowrap text-text-default"
                    style={{ left: i * WEATHER_COLUMN }}
                  >
                    {dayText(cell)}
                    {cell.day > 0 && (
                      <span className="ml-1 font-medium text-text-muted tabular-nums">
                        {monthDay(cell.date)}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
            <div className="flex">
              {cells.map((cell) => (
                <div
                  key={cell.at}
                  className="flex flex-col items-center gap-1"
                  style={{ width: WEATHER_COLUMN }}
                >
                  <span className="text-[11px] leading-[14px] text-text-muted tabular-nums">
                    {t("hour", { hour: cell.hour })}
                  </span>
                  <SkyGlyph icon={cell.icon} />
                </div>
              ))}
            </div>
            <TemperatureLine cells={cells} />
            <div className="flex">
              {cells.map((cell) => (
                <span
                  key={cell.at}
                  className="text-center text-[11px] font-bold text-brand-default tabular-nums"
                  style={{ width: WEATHER_COLUMN }}
                >
                  {cell.pop === null ? "–" : `${Math.round(cell.pop)}%`}
                </span>
              ))}
            </div>
            <div className="mt-2 border-t border-border-default pt-1.5">
              <span className="block text-[11px] text-text-muted">
                {t.rich("wind", {
                  b: (chunks) => <b className="text-text-body">{chunks}</b>,
                })}
              </span>
              <WindRow cells={cells} />
            </div>
          </div>
        </div>
        <span className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-bg-surface to-transparent lg:hidden" />
      </div>

      {(later.days.length > 0 || later.midFailed) && (
        <div className="flex flex-col border-t border-border-default lg:mx-5">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={laterId}
            onClick={() => setOpen((v) => !v)}
            className="flex h-11 items-center justify-between gap-2 text-label-s font-bold text-text-default"
          >
            <span>
              {open ? (
                t("less")
              ) : (
                <>
                  {/* 중기예보만 못 받았으면 받기로 한 날 수(글피 + 3일)를 말하고 요일 범위는 빼(받은 날만 범위가 됨) */}
                  {t("more", {
                    count: later.days.length + (later.midFailed ? 3 : 0),
                  })}
                  {range && !later.midFailed && (
                    <span className="ml-1.5 font-medium text-text-muted">
                      {range}
                    </span>
                  )}
                </>
              )}
            </span>
            <Chevron size={16} aria-hidden="true" />
          </button>
          <div id={laterId} hidden={!open} className="pb-3">
            <div className="flex flex-col gap-2">
              {range && (
                <p className="text-[11.5px] text-text-muted">
                  {t.rich("laterHead", {
                    range,
                    b: (chunks) => <b className="text-text-body">{chunks}</b>,
                  })}
                </p>
              )}
              {later.days.length > 0 && (
                <ul className="flex flex-col divide-y divide-border-default lg:grid lg:grid-cols-4 lg:gap-2 lg:divide-y-0">
                  {later.days.map((day) => (
                    <LaterDay
                      key={day.date}
                      day={day}
                      label={t("dayCell", {
                        weekday: weekday(day.date),
                        date: monthDay(day.date),
                        sky: skyText(day.word),
                        pop: valueText("pop", day.pop),
                        min: valueText("temperature", day.min),
                        max: valueText("temperature", day.max),
                      })}
                      weekday={weekday(day.date)}
                    />
                  ))}
                </ul>
              )}
              {later.midFailed && (
                <div className="flex flex-col gap-0.5 rounded-[10px] bg-bg-subtle px-3 py-2.5">
                  <span className="text-label-s font-bold text-text-default">
                    {t("midFailedTitle")}
                  </span>
                  <span className="text-caption text-text-body">
                    {t("midFailedBody")}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <p className="text-caption text-text-muted lg:px-5 lg:pb-4">
        {t("note")}
      </p>
    </section>
  );
}

function LaterDay({
  day,
  label,
  weekday,
}: {
  day: DayCell;
  label: string;
  weekday: string;
}) {
  return (
    <li
      aria-label={label}
      className="flex h-10 items-center gap-2.5 lg:h-auto lg:flex-col lg:items-start lg:gap-1 lg:rounded-[10px] lg:bg-bg-subtle lg:px-3 lg:py-2.5"
    >
      <span
        aria-hidden="true"
        className="w-14 shrink-0 text-label-s font-bold text-text-default lg:w-auto"
      >
        {weekday}{" "}
        <span className="font-medium text-text-muted tabular-nums">
          {monthDay(day.date)}
        </span>
      </span>
      <span
        aria-hidden="true"
        className="flex flex-1 items-center gap-2 lg:w-full"
      >
        <SkyGlyph icon={day.icon} />
        <span className="text-[11.5px] font-bold text-brand-default tabular-nums">
          {day.pop === null ? "–" : `${Math.round(day.pop)}%`}
        </span>
        <span className="ml-auto text-label-s tabular-nums">
          <span className="text-text-muted">
            {day.min === null ? "–" : `${Math.round(day.min)}°`}
          </span>
          <span className="text-text-muted"> / </span>
          <b className="text-text-default">
            {day.max === null ? "–" : `${Math.round(day.max)}°`}
          </b>
        </span>
      </span>
    </li>
  );
}
