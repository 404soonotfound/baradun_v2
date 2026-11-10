"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import type { BeachName } from "@/lib/beach-names";
import {
  alarmInfo,
  allIncidents,
  incidentKey,
  groupedAlarms,
  logsUrl,
  matchesFilter,
  barCounts,
  barState,
  cloudWatchUrl,
  fetchCollection,
  incidentMinutes,
  incidentTimeline,
  kstHour,
  lambdaUrl,
  lowestHour,
  overallHourly,
  reasonOf,
  SOURCE_ROWS,
  sourceState,
  successRate,
  sumCounts,
  versionTime,
  type AlarmState,
  type AlarmView,
  type BarState,
  type CollectionView,
  type HourCounts,
  type JobCollection,
  type JobIncident,
  type RunFailure,
  type SourceFilter,
  type SourceRow,
  type SourceState,
  type TimelineEvent,
} from "@/lib/collection";
import { kstDateTime } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import { AdminShell } from "./admin-shell";
import { Button, Notice } from "./ui";

// 데이터 수집 현황 (BRD-149·GH-376, 화면 설계서 6장 ADM-COLLECT, 시안 4차 V9·VM2 + 2026-11-10 시안)
// - 요약 4칸(정상 출처·7일 성공·관측 지연 해변·마지막 게시) · 출처별 표(PC)/카드(모바일) · 시간별 성공률 선 그래프
//   · 장애 기록 7일 → 장애 상세 시트 · 알림(CloudWatch 경보)
// - 수집기가 남긴 실행 기록·게시 요약·경보만 씀. 기록이 없으면 '기록 없음', 요약·경보를 못 읽으면 '확인 못 함'
//   (정상·'영향 없음'·'경보 없음'·0으로 보지 않음)
// - 지연 기준(D15-9)은 서버가 내려준 값 그대로. 관측 지연 해변 수는 publisher가 게시할 때 계산한 그대로
// - 해양수산부 운영 기간은 수집기가 없고 저장소 파일이 원본 → 수집하지 않는다고 그대로 보여 줌
// - 읽기 전용. 판단 상태를 바꾸는 조작·사유 메모 없음(G1, 메모는 쓰기 API·감사 기록이 필요해 후속)

const t = messages.collection;

type Beaches = Readonly<Record<string, BeachName>>;

const SEASON_FILE =
  "https://github.com/404soonotfound/baradun_v2/blob/main/data/beach-meta.json";

const BADGE =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-admin-badge px-2 text-label-s font-medium whitespace-nowrap";

const STATE_BADGE: Record<SourceState, string> = {
  ok: "bg-info-bg text-info-fg ring-1 ring-border-default",
  late: "bg-status-stale-bg text-status-stale-fg ring-1 ring-status-stale-border",
  unchecked:
    "bg-bg-surface text-text-body outline-1 outline-border-strong outline-dashed -outline-offset-1",
  partial:
    "bg-status-stale-bg text-status-stale-fg outline-1 outline-status-stale-border outline-dashed -outline-offset-1",
  failed:
    "bg-status-blocked-bg text-status-blocked-fg ring-1 ring-danger-border",
  none: "bg-bg-surface text-text-muted ring-1 ring-border-strong",
};

// 상태 점. 점 모양도 상태마다 다르게 둠(색만으로 나누지 않음). 글자가 상태를 말함
const STATE_DOT: Record<SourceState, string> = {
  ok: "size-2 rounded-full bg-brand-default",
  late: "size-2 rounded-full border-2 border-status-stale-fg",
  unchecked: "size-2 rounded-full border border-dashed border-text-body",
  partial: "size-2 rotate-45 bg-status-stale-fg",
  failed: "size-2 bg-danger-border",
  none: "size-2 rounded-full border border-border-strong",
};

function StateBadge({ state }: { state: SourceState }) {
  return (
    <span className={`${BADGE} ${STATE_BADGE[state]}`}>
      <span aria-hidden="true" className={STATE_DOT[state]} />
      {t.state[state]}
    </span>
  );
}

const ALARM_BADGE: Record<AlarmState, SourceState> = {
  ALARM: "failed",
  OK: "ok",
  INSUFFICIENT_DATA: "none",
  unknown: "none",
};

function AlarmBadge({ state }: { state: AlarmState }) {
  const tone = ALARM_BADGE[state];
  return (
    <span className={`${BADGE} ${STATE_BADGE[tone]}`}>
      <span aria-hidden="true" className={STATE_DOT[tone]} />
      {t.alarmState[state]}
    </span>
  );
}

// 새 탭으로 여는 바깥 링크(AWS 콘솔·GitHub). 화면 안 이동이 아니라 <a>를 씀
function ExternalLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`font-medium text-brand-default underline underline-offset-2 ${className}`}
    >
      {children}
      <span className="sr-only"> {t.newTab}</span>
    </a>
  );
}

function rateText(rate: number | null): string {
  return rate === null ? t.never : `${rate}%`;
}

function reasonText(failure: RunFailure): string {
  const { key, value } = reasonOf(failure);
  const base = fill(t.reason[key], { value });
  return failure.count && failure.count > 1
    ? fill(t.reasonCount, { reason: base, count: failure.count })
    : base;
}

function sourceName(job: string): string {
  return job in t.source ? t.source[job as keyof typeof t.source] : job;
}

// 24시간 막대 한 칸. 높이도 상태마다 다르게 둠(실패는 높게, 지연은 중간, 기록 없음은 낮게)
const BAR: Record<BarState, string> = {
  ok: "h-4 bg-brand-default",
  late: "h-2.5 bg-status-stale-fg",
  failed: "h-5 bg-danger-border",
  none: "h-1 bg-border-strong",
};

function DayBars({ job }: { job: JobCollection | undefined }) {
  const day = job?.day ?? { runs: 0, ok: 0 };
  const hourly = job?.hourly ?? [];
  const counts = barCounts(hourly);
  // 예전 응답(overdue null)은 지연을 판정하지 못함 → '지연 0시간'이 아니라 '지연 확인 못 함'
  const lateUnknown = job?.overdue === null;
  const values = {
    runs: day.runs,
    ok: day.ok,
    failed: counts.failed,
    late: counts.late,
    none: counts.none,
  };
  const label =
    day.runs === 0 && counts.late === 0
      ? t.dayNone
      : fill(lateUnknown ? t.dayBarsLateUnknown : t.dayBars, values);
  return (
    <span role="img" aria-label={label} className="flex h-5 items-end gap-px">
      {hourly.map((bucket) => (
        <span
          key={bucket.hour}
          aria-hidden="true"
          className={`w-1.5 rounded-[1px] ${BAR[barState(bucket)]}`}
        />
      ))}
    </span>
  );
}

function BarLegend() {
  const states: readonly BarState[] = ["ok", "late", "failed", "none"];
  return (
    <ul
      aria-label={t.legendTitle}
      className="flex flex-wrap items-end gap-x-4 gap-y-1 text-label-s text-text-body"
    >
      {states.map((state) => (
        <li key={state} className="flex items-end gap-1.5">
          <span className="flex h-5 items-end" aria-hidden="true">
            <span className={`w-1.5 rounded-[1px] ${BAR[state]}`} />
          </span>
          {t.bar[state]}
        </li>
      ))}
    </ul>
  );
}

// 상태 배지가 어느 실행 기준인지 함께 보여 줌(오래전 실행의 '정상'을 지금 정상으로 읽지 않게)
function LastRun({ job }: { job: JobCollection | undefined }) {
  if (!job?.lastRun) return null;
  return (
    <p className="mt-1 text-label-s whitespace-nowrap text-text-muted tabular-nums">
      {fill(t.lastRun, { time: kstDateTime(job.lastRun.startedAt) })}
    </p>
  );
}

// 예전 응답(legacy)은 지연 기준을 모르니 기준 줄을 빼 '지연 표시 안 함'으로 읽지 않게 함
function Cycle({
  row,
  job,
  legacy,
}: {
  row: SourceRow;
  job: JobCollection | undefined;
  legacy: boolean;
}) {
  const late = job?.lateAfterMinutes;
  return (
    <span className="flex flex-col gap-0.5">
      <span>{t.cycle[row.job]}</span>
      {job && !legacy && (
        <span className="text-label-s text-text-muted">
          {late == null ? t.cycleNoLate : fill(t.cycleLate, { minutes: late })}
        </span>
      )}
    </span>
  );
}

function rowJob(view: CollectionView, row: SourceRow) {
  return view.jobs.find((j) => j.job === row.job);
}

function Summary({ view }: { view: CollectionView }) {
  const jobs = SOURCE_ROWS.map((row) => rowJob(view, row));
  const okCount = jobs.filter((job) => sourceState(job) === "ok").length;
  // 지연을 판정하지 못한 출처가 있으면 정상 출처 수는 '확인 못 함'(0/5로 보이지 않게)
  const unchecked = jobs.filter(
    (job) => sourceState(job) === "unchecked",
  ).length;
  const judgment = SOURCE_ROWS.filter((row) => row.judgment).length;
  // 화면 줄(SOURCE_ROWS)과 같은 수집기만 셈(정상 출처 수와 기준을 맞춤)
  const week = sumCounts(jobs.map((job) => job?.week ?? { runs: 0, ok: 0 }));
  const rate = successRate(week);
  const { publish } = view;
  // 요약이 없으면 버전 시각만(검증 통과·해변 수는 요약에서만 알 수 있음)
  const published = publish?.publishedAt ?? versionTime(view.publishedVersion);
  const card =
    "flex flex-col gap-1 rounded-admin-box border border-border-default bg-bg-surface px-4 py-3";
  const value = "text-title-l font-semibold text-text-default tabular-nums";
  const hint = "text-label-s text-text-muted";
  const label = "text-label-s font-medium text-text-body";
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div className={card}>
        <dt className={label}>{t.kpiSources}</dt>
        <dd className={value}>
          {unchecked > 0 ? t.kpiUnknown : `${okCount}/${SOURCE_ROWS.length}`}
        </dd>
        <dd className={hint}>
          {unchecked > 0
            ? fill(t.kpiSourcesUnchecked, { count: unchecked })
            : fill(t.kpiSourcesHint, { judgment })}
        </dd>
      </div>
      <div className={card}>
        <dt className={label}>{t.kpiWeek}</dt>
        <dd className={value}>{rate === null ? t.kpiWeekNone : `${rate}%`}</dd>
        {rate !== null && (
          <dd className={hint}>
            {fill(t.kpiWeekHint, { failed: week.runs - week.ok })}
          </dd>
        )}
      </div>
      <div className={card}>
        <dt className={label}>{t.kpiDelayed}</dt>
        <dd className={value}>
          {publish
            ? fill(t.kpiDelayedValue, { count: publish.delayedBeaches })
            : t.kpiUnknown}
        </dd>
        <dd className={hint}>
          {publish
            ? fill(t.kpiDelayedHint, { total: publish.beachCount })
            : t.kpiDelayedUnknownHint}
        </dd>
      </div>
      <div className={card}>
        <dt className={label}>{t.kpiPublish}</dt>
        <dd className={value}>
          {published ? kstDateTime(published) : t.kpiPublishNone}
        </dd>
        {published && (
          <dd className={hint}>
            {publish
              ? fill(t.kpiPublishHint, { count: publish.beachCount })
              : t.kpiPublishHintNoSummary}
          </dd>
        )}
      </div>
    </dl>
  );
}

function SourceName({ row }: { row: SourceRow }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium text-text-default">{t.source[row.job]}</span>
      <span className="text-label-s text-text-muted">
        {row.judgment ? t.judgment : t.reference}
      </span>
    </span>
  );
}

// 그 출처의 가장 최근 장애 상세로 바로 감. 장애가 없으면 '—'
function IncidentJump({
  row,
  incidents,
  onOpen,
}: {
  row: SourceRow;
  incidents: readonly JobIncident[];
  onOpen: (index: number) => void;
}) {
  const index = incidents.findIndex((i) => i.job === row.job);
  const count = incidents.filter((i) => i.job === row.job).length;
  if (index < 0) return <span className="text-text-muted">{t.never}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpen(index)}
      aria-label={fill(t.incidentsOfLabel, {
        source: t.source[row.job],
        count,
      })}
      className="min-h-touch rounded-admin-control px-1 text-body-s lg:min-h-admin-control font-medium whitespace-nowrap text-brand-default underline underline-offset-2 hover:bg-bg-page"
    >
      {fill(t.incidentsOf, { count })}
    </button>
  );
}

function SourceTable({
  view,
  legacy,
  incidents,
  onOpen,
}: {
  view: CollectionView;
  legacy: boolean;
  incidents: readonly JobIncident[];
  onOpen: (index: number) => void;
}) {
  const cell = "border-b border-border-default px-3 py-2.5 align-middle";
  const [filter, setFilter] = useState<SourceFilter>("all");
  const states = SOURCE_ROWS.map((row) => sourceState(rowJob(view, row)));
  const filters: readonly SourceFilter[] = [
    "all",
    "judgment",
    "reference",
    "problem",
  ];
  const count = (f: SourceFilter) =>
    SOURCE_ROWS.filter((row, i) => matchesFilter(f, row, states[i]!)).length;
  const rows = SOURCE_ROWS.filter((row, i) =>
    matchesFilter(filter, row, states[i]!),
  );
  // 운영 기간은 수집하지 않는 참고 정보라 전체·참고에서만 보여 줌
  const showSeason = filter === "all" || filter === "reference";
  return (
    <section aria-labelledby="collection-sources">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <h2
          id="collection-sources"
          className="text-title-s font-semibold text-text-default"
        >
          {t.tableTitle}
        </h2>
        <BarLegend />
      </div>
      <div
        role="group"
        aria-label={t.filterLabel}
        className="mb-2 flex flex-wrap gap-1.5"
      >
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className="inline-flex min-h-touch items-center gap-1.5 rounded-admin-control border border-border-default bg-bg-surface px-3 text-body-s text-text-body hover:bg-bg-page aria-pressed:border-brand-default aria-pressed:font-semibold aria-pressed:text-brand-default lg:min-h-admin-control"
          >
            {t.filter[f]}
            <span className="text-text-muted tabular-nums">{count(f)}</span>
          </button>
        ))}
      </div>
      {rows.length === 0 && !showSeason && (
        <p className="rounded-admin-box border border-border-default bg-bg-surface px-4 py-3 text-body-s text-text-muted">
          {t.filterEmpty}
        </p>
      )}
      {/* 태블릿·PC: 표 */}
      {(rows.length > 0 || showSeason) && (
        <table className="hidden w-full border-separate border-spacing-0 overflow-hidden rounded-admin-box border border-border-default bg-bg-surface text-body md:table">
          <thead>
            <tr className="bg-bg-page text-left text-label-s font-semibold text-text-body">
              {[
                t.colSource,
                t.colState,
                t.colDay,
                t.colLastSuccess,
                t.colCycle,
                t.colWeek,
                t.incidentsTitle,
              ].map((label) => (
                <th
                  key={label}
                  scope="col"
                  className="border-b border-border-default px-3 py-2 first:pl-4"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const job = rowJob(view, row);
              return (
                <tr key={row.job}>
                  <th
                    scope="row"
                    className={`${cell} pl-4 text-left font-normal`}
                  >
                    <SourceName row={row} />
                  </th>
                  <td className={cell}>
                    <StateBadge state={sourceState(job)} />
                    <LastRun job={job} />
                    {job?.truncated && (
                      <p className="mt-1 text-label-s text-text-muted">
                        {t.truncated}
                      </p>
                    )}
                  </td>
                  <td className={cell}>
                    <DayBars job={job} />
                  </td>
                  <td className={`${cell} whitespace-nowrap tabular-nums`}>
                    {job?.lastSuccessAt
                      ? kstDateTime(job.lastSuccessAt)
                      : t.never}
                  </td>
                  <td className={`${cell} text-body-s text-text-body`}>
                    <Cycle row={row} job={job} legacy={legacy} />
                  </td>
                  <td className={`${cell} tabular-nums`}>
                    {rateText(job ? successRate(job.week) : null)}
                  </td>
                  <td className={cell}>
                    <IncidentJump
                      row={row}
                      incidents={incidents}
                      onOpen={onOpen}
                    />
                  </td>
                </tr>
              );
            })}
            {showSeason && (
              <tr>
                <th
                  scope="row"
                  className="px-3 py-2.5 pl-4 text-left font-normal"
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium text-text-default">
                      {t.season}
                    </span>
                    <span className="text-label-s text-text-muted">
                      {t.reference}
                    </span>
                  </span>
                </th>
                <td className="px-3 py-2.5">
                  <span className={`${BADGE} ${STATE_BADGE.none}`}>
                    {t.seasonState}
                  </span>
                </td>
                <td
                  colSpan={5}
                  className="px-3 py-2.5 text-body-s text-text-body"
                >
                  {t.seasonHint}{" "}
                  <ExternalLink href={SEASON_FILE}>{t.seasonLink}</ExternalLink>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {/* 모바일(VM2): 카드. 표의 값을 빼지 않음 */}
      {(rows.length > 0 || showSeason) && (
        <ul className="flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface md:hidden">
          {rows.map((row) => {
            const job = rowJob(view, row);
            return (
              <li key={row.job} className="flex flex-col gap-2 px-4 py-3">
                <span className="flex items-start justify-between gap-3">
                  <SourceName row={row} />
                  <StateBadge state={sourceState(job)} />
                </span>
                <LastRun job={job} />
                <DayBars job={job} />
                <dl className="grid grid-cols-3 gap-2 text-body-s">
                  <div>
                    <dt className="text-label-s text-text-muted">
                      {t.colLastSuccess}
                    </dt>
                    <dd className="text-text-default tabular-nums">
                      {job?.lastSuccessAt
                        ? kstDateTime(job.lastSuccessAt)
                        : t.never}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-label-s text-text-muted">
                      {t.colCycle}
                    </dt>
                    <dd className="text-text-default">
                      <Cycle row={row} job={job} legacy={legacy} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-label-s text-text-muted">
                      {t.colWeek}
                    </dt>
                    <dd className="text-text-default tabular-nums">
                      {rateText(job ? successRate(job.week) : null)}
                    </dd>
                  </div>
                </dl>
                {job?.truncated && (
                  <p className="text-label-s text-text-muted">{t.truncated}</p>
                )}
                <span>
                  <IncidentJump
                    row={row}
                    incidents={incidents}
                    onOpen={onOpen}
                  />
                </span>
              </li>
            );
          })}
          {showSeason && (
            <li className="flex flex-col gap-1 px-4 py-3">
              <span className="flex items-start justify-between gap-3">
                <span className="font-medium text-text-default">
                  {t.season}
                </span>
                <span className={`${BADGE} ${STATE_BADGE.none}`}>
                  {t.seasonState}
                </span>
              </span>
              <span className="text-body-s text-text-body">
                {t.seasonHint}{" "}
                <ExternalLink href={SEASON_FILE}>{t.seasonLink}</ExternalLink>
              </span>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function hourLabel(bucket: HourCounts): string {
  const hour = kstHour(bucket.hour);
  return bucket.runs === 0
    ? fill(t.hourlyBarEmpty, { hour })
    : fill(t.hourlyBar, { hour, ok: bucket.ok, runs: bucket.runs });
}

// 시간별 성공률 선 그래프(0~100%). 실행이 없는 칸은 선을 끊음(0%로 그리지 않음)
// 가장 낮은 칸에 말풍선. 화면 읽기 프로그램에는 칸별 값 목록을 따로 둠
const CHART_W = 240;
const CHART_H = 80;

function Hourly({ view }: { view: CollectionView }) {
  const hourly = overallHourly(view.jobs);
  const lowest = lowestHour(hourly);
  const any = hourly.some((b) => b.runs > 0);
  const summary = !any
    ? t.hourlyEmpty
    : lowest
      ? fill(t.hourlyLowest, {
          hour: kstHour(lowest.hour),
          rate: successRate(lowest) ?? 0,
        })
      : t.hourlyFine;
  const step = hourly.length > 1 ? CHART_W / (hourly.length - 1) : 0;
  const point = (bucket: HourCounts, i: number) => ({
    x: i * step,
    y: (1 - bucket.ok / bucket.runs) * CHART_H,
  });
  // 실행이 있는 칸끼리 이어진 조각. 앞뒤가 비어 점 하나뿐인 조각은 같은 점을 두 번 넣어 둥근 끝으로 점을 그림
  const segments: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length === 1) current.push(current[0]!);
    if (current.length) segments.push(current.join(" "));
    current = [];
  };
  hourly.forEach((bucket, i) => {
    if (bucket.runs === 0) {
      flush();
      return;
    }
    const { x, y } = point(bucket, i);
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  flush();
  const lowIndex = lowest ? hourly.indexOf(lowest) : -1;
  const low = lowest && lowIndex >= 0 ? point(lowest, lowIndex) : null;
  const ticks = hourly
    .map((bucket, i) => ({ bucket, i }))
    .filter(({ i }) => i % 6 === 0 || i === hourly.length - 1);

  return (
    <section
      aria-labelledby="collection-hourly"
      className="rounded-admin-box border border-border-default bg-bg-surface px-4 py-3"
    >
      <h2
        id="collection-hourly"
        className="text-title-s font-semibold text-text-default"
      >
        {t.hourlyTitle}
      </h2>
      <p className="text-label-s text-text-muted">{t.hourlyAll}</p>
      {any && (
        <div className="mt-3 flex gap-2" aria-hidden="true">
          <div className="flex h-24 flex-col justify-between pb-0 text-label-s text-text-muted tabular-nums">
            {[100, 50, 0].map((rate) => (
              <span key={rate}>{fill(t.axisPercent, { rate })}</span>
            ))}
          </div>
          <div className="relative flex-1">
            <svg
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              preserveAspectRatio="none"
              className="h-24 w-full overflow-visible"
            >
              {[0, 0.5, 1].map((r) => (
                <line
                  key={r}
                  x1={0}
                  x2={CHART_W}
                  y1={r * CHART_H}
                  y2={r * CHART_H}
                  className="stroke-border-default"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {segments.map((points) => (
                <polyline
                  key={points}
                  points={points}
                  fill="none"
                  className="stroke-brand-default"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
            {low && lowest && (
              <>
                <span
                  className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-bg-surface bg-danger-border"
                  style={{
                    left: `${(low.x / CHART_W) * 100}%`,
                    top: `${(low.y / CHART_H) * 96}px`,
                  }}
                />
                <span
                  className="absolute -translate-x-1/2 -translate-y-full rounded-admin-control bg-text-default px-1.5 py-0.5 text-label-s whitespace-nowrap text-bg-surface tabular-nums"
                  style={{
                    left: `clamp(2.5rem, ${(low.x / CHART_W) * 100}%, calc(100% - 2.5rem))`,
                    top: `${Math.max((low.y / CHART_H) * 96 - 8, 0)}px`,
                  }}
                >
                  {fill(t.hourlyCallout, {
                    hour: kstHour(lowest.hour),
                    rate: successRate(lowest) ?? 0,
                  })}
                </span>
              </>
            )}
            <div className="relative mt-1 h-4 text-label-s text-text-muted tabular-nums">
              {ticks.map(({ bucket, i }) => (
                <span
                  key={bucket.hour}
                  className="absolute -translate-x-1/2 whitespace-nowrap first:translate-x-0 last:-translate-x-full"
                  style={{ left: `${(i * step * 100) / CHART_W}%` }}
                >
                  {fill(t.hourlyAxis, { hour: kstHour(bucket.hour) })}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
      <ol className="sr-only" aria-label={t.hourlyChart}>
        {hourly.map((bucket) => (
          <li key={bucket.hour}>{hourLabel(bucket)}</li>
        ))}
      </ol>
      <p className="mt-2 text-body-s text-text-body">{summary}</p>
    </section>
  );
}

function incidentHeadline(incident: JobIncident): string {
  if (incident.kind === "stations") {
    return `${sourceName(incident.job)} · ${fill(t.incidentStations, {
      count: incident.stations.length,
    })}`;
  }
  const first = incident.failures[0];
  const more = incident.failures.length - 1;
  return [
    sourceName(incident.job),
    first && ` · ${reasonText(first)}`,
    more > 0 && ` ${fill(t.incidentMore, { count: more })}`,
  ]
    .filter(Boolean)
    .join("");
}

function OngoingBadge({ ended }: { ended: boolean }) {
  return (
    <span
      className={`${BADGE} ${ended ? STATE_BADGE.none : STATE_BADGE.failed}`}
    >
      <span
        aria-hidden="true"
        className={ended ? STATE_DOT.none : STATE_DOT.failed}
      />
      {ended ? t.incidentResolved : t.incidentOngoing}
    </span>
  );
}

// 목록 줄의 해변 영향 요약(해양 관측만). 응답에 영향이 없으면 '확인 못 함'(영향 없음으로 보지 않음)
function impactSummary(incident: JobIncident): string | null {
  if (incident.job !== "collect-ocean") return null;
  const { impact } = incident;
  if (!impact || impact.status === "unknown") return t.incidentImpact.unknown;
  if (impact.status === "none") return t.incidentImpact.none;
  return fill(t.incidentImpact.affected, {
    count: impact.delayedBeachIds.length,
  });
}

const PAGE_SIZE = 5;

function Incidents({
  incidents,
  nowMs,
  onOpen,
}: {
  incidents: readonly JobIncident[];
  nowMs: number;
  onOpen: (index: number) => void;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(incidents.length / PAGE_SIZE));
  // 다시 불러와 장애가 줄면 마지막 쪽으로
  const current = Math.min(page, pages - 1);
  const from = current * PAGE_SIZE;
  const shown = incidents.slice(from, from + PAGE_SIZE);
  return (
    <section
      aria-labelledby="collection-incidents"
      className="rounded-admin-box border border-border-default bg-bg-surface px-4 py-3"
    >
      <h2
        id="collection-incidents"
        tabIndex={-1}
        className="text-title-s font-semibold text-text-default outline-none"
      >
        {t.incidentsTitle}{" "}
        <span className="text-text-muted tabular-nums">{incidents.length}</span>
      </h2>
      {incidents.length === 0 ? (
        <p className="mt-2 text-body-s text-text-muted">{t.incidentsEmpty}</p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-border-default">
          {shown.map((incident, i) => {
            const index = from + i;
            const first = incident.failures[0];
            const impact = impactSummary(incident);
            return (
              <li key={incidentKey(incident)}>
                <button
                  type="button"
                  onClick={() => onOpen(index)}
                  className="flex w-full items-start justify-between gap-3 rounded-admin-control py-2.5 text-left hover:bg-bg-page"
                >
                  <span className="flex flex-col gap-0.5">
                    <span className="text-body text-text-default">
                      {incidentHeadline(incident)}
                    </span>
                    {first?.message && (
                      <span className="text-label-s break-all text-text-muted">
                        {first.message}
                      </span>
                    )}
                    <span className="text-label-s text-text-muted tabular-nums">
                      {t.incidentKind[incident.kind]} ·{" "}
                      {fill(t.incidentMeta, {
                        time: kstDateTime(incident.startedAt),
                        minutes: incidentMinutes(incident, nowMs),
                        runs: incident.runs,
                      })}
                      {impact && ` · ${impact}`}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <OngoingBadge ended={incident.endedAt !== null} />
                    <span className="text-label-s text-brand-default">
                      {t.incidentOpen}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {pages > 1 && (
        <nav
          aria-label={t.pagerLabel}
          className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-border-default pt-2"
        >
          <span className="text-label-s text-text-muted tabular-nums">
            {fill(t.pager, {
              total: incidents.length,
              from: from + 1,
              to: from + shown.length,
              size: PAGE_SIZE,
            })}
          </span>
          {/* 끝 쪽에서 disabled로 바꾸면 누른 버튼의 포커스가 사라져 aria-disabled로 둠(시트 이전·다음과 같음) */}
          <span className="flex gap-1.5">
            <Button
              variant="secondary"
              size="small"
              aria-disabled={current === 0}
              onClick={() => current > 0 && setPage(current - 1)}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
            >
              {t.prev}
            </Button>
            <Button
              variant="secondary"
              size="small"
              aria-disabled={current >= pages - 1}
              onClick={() => current < pages - 1 && setPage(current + 1)}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
            >
              {t.next}
            </Button>
          </span>
        </nav>
      )}
    </section>
  );
}

function alarmTitle(alarm: Pick<AlarmView, "id">): string {
  const { kind, source } = alarmInfo(alarm.id);
  if (kind === "other" && source === null) {
    return alarm.id in t.alarmOther
      ? t.alarmOther[alarm.id as keyof typeof t.alarmOther]
      : alarm.id;
  }
  const name =
    source === "publish"
      ? t.alarmSourcePublish
      : source
        ? t.source[source]
        : alarm.id;
  return fill(t.alarmKind[kind], {
    source: kind === "other" ? alarm.id : name,
  });
}

// 경보를 읽었는지에 따라 지역(콘솔 링크용)
function alarmRegion(view: CollectionView): string | null {
  return view.alarms.status === "ok" ? view.alarms.region : null;
}

function Alerts({ view }: { view: CollectionView }) {
  const { alarms } = view;
  return (
    <section
      aria-labelledby="collection-alerts"
      className="rounded-admin-box border border-border-default bg-bg-surface px-4 py-3"
    >
      <h2
        id="collection-alerts"
        className="text-title-s font-semibold text-text-default"
      >
        {t.alertsTitle}
      </h2>
      <p className="text-label-s text-text-muted">{t.alertsHint}</p>
      {alarms.status !== "ok" ? (
        <div className="mt-2">
          <Notice tone="warn" title={t.alertsUnavailable}>
            <p>{t.alertsUnavailableHint}</p>
          </Notice>
        </div>
      ) : alarms.list.length === 0 ? (
        <p className="mt-2 text-body-s text-text-muted">{t.alertsEmpty}</p>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {groupedAlarms(alarms.list).map((group) => (
            <section
              key={group.kind}
              aria-labelledby={`alert-group-${group.kind}`}
              className="flex flex-col"
            >
              <h3
                id={`alert-group-${group.kind}`}
                className="text-body font-semibold text-text-default"
              >
                {t.alertGroup[group.kind]}
              </h3>
              <p className="text-label-s text-text-muted">
                {t.alertGroupHint[group.kind]}
              </p>
              <ul className="mt-1 flex flex-col divide-y divide-border-default">
                {group.alarms.map((alarm) => (
                  <li
                    key={alarm.id}
                    className="flex items-start justify-between gap-3 py-2"
                  >
                    <span className="flex flex-col gap-0.5">
                      <span className="text-body-s text-text-default">
                        {alarmTitle(alarm)}
                      </span>
                      <span className="text-label-s text-text-muted tabular-nums">
                        {alarm.windowMinutes === null
                          ? t.alarmWindowUnknown
                          : fill(t.alarmWindow, {
                              minutes: alarm.windowMinutes,
                            })}
                        {alarm.state === "ALARM" &&
                          alarm.stateUpdatedAt &&
                          ` · ${fill(t.alarmSince, { time: kstDateTime(alarm.stateUpdatedAt) })}`}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <AlarmBadge state={alarm.state} />
                      <ExternalLink
                        href={cloudWatchUrl(alarms.region, alarm.name)}
                        className="text-label-s"
                      >
                        {t.alarmLink}
                      </ExternalLink>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

// ── 장애 상세 시트 ──

function SheetSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-t border-border-default pt-3">
      <h3 className="text-body font-semibold text-text-default">{title}</h3>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-2 text-body-s">
      <dt className="text-text-muted">{label}</dt>
      <dd className="break-words text-text-default">{children}</dd>
    </div>
  );
}

function Cause({ incident }: { incident: JobIncident }) {
  const stations = incident.kind === "stations";
  const responses = incident.failures.filter((f) => f.code || f.message);
  return (
    <SheetSection title={t.causeTitle}>
      <dl className="flex flex-col gap-1.5">
        <Field label={t.causeWhat}>
          {fill(stations ? t.causeWhatStations : t.causeWhatFailure, {
            runs: incident.runs,
          })}
        </Field>
        <Field label={t.causeReason}>
          {stations ? (
            t.causeReasonStations
          ) : (
            <ul className="flex flex-col gap-0.5">
              {incident.failures.map((f) => (
                <li key={`${f.source}|${f.reason}`}>{reasonText(f)}</li>
              ))}
            </ul>
          )}
        </Field>
        {!stations && (
          <Field label={t.causeResponse}>
            {responses.length === 0 ? (
              <span className="text-text-muted">{t.causeResponseNone}</span>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {responses.map((f) => (
                  <li key={`${f.source}|${f.reason}`} className="break-all">
                    {[f.code, f.message].filter(Boolean).join(" · ")}
                  </li>
                ))}
              </ul>
            )}
          </Field>
        )}
        <Field label={t.causeBasis}>
          {stations ? (
            fill(t.causeBasisStations, { count: incident.stations.length })
          ) : (
            <ul className="flex flex-col gap-0.5">
              {incident.failures.map((f) => (
                <li
                  key={`${f.source}|${f.reason}`}
                  className="font-mono text-label-s break-all"
                >
                  {fill(t.causeBasisValue, {
                    source: f.source,
                    reason: f.reason,
                  })}
                </li>
              ))}
            </ul>
          )}
        </Field>
      </dl>
      {incident.missingTruncated && (
        <p className="text-body-s text-text-body">{t.causeTruncated}</p>
      )}
    </SheetSection>
  );
}

function Impact({
  incident,
  beaches,
}: {
  incident: JobIncident;
  beaches: Beaches;
}) {
  // 해변 영향은 해양 관측만(다른 수집기는 관측소를 쓰지 않음)
  if (incident.job !== "collect-ocean") return null;
  const { impact } = incident;
  const names = new Map(impact?.stations.map((s) => [s.id, s]) ?? []);
  return (
    <SheetSection title={t.impactTitle}>
      {!impact ? (
        <p className="text-body-s text-text-body">{t.impactMissing}</p>
      ) : impact.status === "unknown" ? (
        <p className="text-body-s text-text-body">
          <span className="font-medium text-text-default">
            {t.impactUnknown}
          </span>{" "}
          {impact.reason ? t.impactUnknownReason[impact.reason] : ""}
        </p>
      ) : impact.status === "none" ? (
        <p className="text-body-s text-text-body">
          {impact.wholeSource ? t.impactNoneWhole : t.impactNone}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-body-s font-medium text-text-default">
            {fill(
              impact.wholeSource ? t.impactAffectedWhole : t.impactAffected,
              {
                count: impact.delayedBeachIds.length,
              },
            )}
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {impact.delayedBeachIds.map((id) => (
              <li
                key={id}
                className="rounded-admin-badge bg-bg-page px-2 py-0.5 text-label-s text-text-body"
              >
                {beaches[id]?.name ?? id}
              </li>
            ))}
          </ul>
        </div>
      )}
      {impact?.wholeSource && (
        <p className="text-body-s text-text-body">{t.impactWhole}</p>
      )}
      {incident.stations.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-body-s font-medium text-text-default">
            {t.stationsTitle}
          </h4>
          <ul className="flex flex-col divide-y divide-border-default">
            {incident.stations.map((gap) => {
              const info = names.get(gap.id);
              return (
                <li key={gap.id} className="flex flex-col gap-0.5 py-1.5">
                  <span className="text-body-s text-text-default">
                    {info?.name
                      ? fill(t.stationName, { name: info.name, id: gap.id })
                      : gap.id}
                  </span>
                  <span className="text-label-s text-text-muted tabular-nums">
                    {fill(t.stationMissing, {
                      from: kstDateTime(gap.firstMissingAt),
                      to: kstDateTime(gap.lastMissingAt),
                    })}{" "}
                    ·{" "}
                    {gap.returnedAt
                      ? fill(t.stationReturned, {
                          time: kstDateTime(gap.returnedAt),
                        })
                      : t.stationNotReturned}
                  </span>
                  <span className="text-label-s text-text-muted tabular-nums">
                    {info && info.beaches !== null && info.waveBeaches !== null
                      ? fill(t.stationBeaches, {
                          beaches: info.beaches,
                          wave: info.waveBeaches,
                        })
                      : t.stationBeachesUnknown}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </SheetSection>
  );
}

function timelineText(event: TimelineEvent): string {
  switch (event.type) {
    case "alarm":
      return fill(t.timeline.alarm, { name: alarmTitle(event.alarm) });
    case "returned":
      return fill(t.timeline.returned, { station: event.station });
    default:
      return t.timeline[event.type];
  }
}

function Timeline({
  incident,
  nowIso,
}: {
  incident: JobIncident;
  nowIso: string;
}) {
  return (
    <SheetSection title={t.timelineTitle}>
      <ol className="flex flex-col gap-1.5 border-l-2 border-border-default pl-3">
        {incidentTimeline(incident, nowIso).map((event, i) => (
          <li
            key={`${event.type}|${event.at}|${i}`}
            className="flex flex-col text-body-s"
          >
            <span className="text-label-s text-text-muted tabular-nums">
              {kstDateTime(event.at)}
            </span>
            <span className="text-text-default">{timelineText(event)}</span>
          </li>
        ))}
      </ol>
    </SheetSection>
  );
}

function Alarms({
  incident,
  view,
}: {
  incident: JobIncident;
  view: CollectionView;
}) {
  const region = alarmRegion(view);
  const list = view.alarms.status === "ok" ? view.alarms.list : [];
  // 빠진 관측소는 실행 상태를 바꾸지 않아 경보가 울리지 않음 → 서버가 경보를 붙이지 않음(읽기 실패가 아님)
  if (incident.kind === "stations") {
    return (
      <SheetSection title={t.alarmsTitle}>
        <p className="text-body-s text-text-body">{t.alarmsStations}</p>
      </SheetSection>
    );
  }
  // 실패 장애의 null·없음은 읽지 못함('경보 없음'이 아님)
  const events = incident.alarms ?? null;
  return (
    <SheetSection title={t.alarmsTitle}>
      {events === null || region === null ? (
        <p className="text-body-s text-text-body">{t.alarmsUnread}</p>
      ) : events.length === 0 ? (
        <p className="text-body-s text-text-body">{t.alarmsNone}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-default">
          {events.map((event) => {
            const fn = list.find((a) => a.name === event.name)?.functionName;
            return (
              <li
                key={`${event.name}|${event.at}`}
                className="flex flex-col gap-0.5 py-1.5"
              >
                <span className="text-body-s text-text-default">
                  {alarmTitle(event)}
                </span>
                <span className="text-label-s text-text-muted tabular-nums">
                  {kstDateTime(event.at)}
                </span>
                <span className="flex gap-3 text-label-s">
                  <ExternalLink href={cloudWatchUrl(region, event.name)}>
                    {t.alarmLink}
                  </ExternalLink>
                  {fn && (
                    <>
                      <ExternalLink href={logsUrl(region, fn)}>
                        {t.logsLink}
                      </ExternalLink>
                      <ExternalLink href={lambdaUrl(region, fn)}>
                        {t.lambdaLink}
                      </ExternalLink>
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SheetSection>
  );
}

// 닫힘 동작 시간(ms). 동작 줄이기를 켰으면 바로 닫음
const CLOSE_MS = 200;

// 장애 상세 시트: 오른쪽 패널(모달 <dialog>, 문의 상세 패널과 같은 방식). 모바일은 화면 너비 전체
// 포커스는 시트 안에 갇히고 Esc·바깥(딤) 누르기·닫기 버튼으로 닫음. ↑↓(또는 이전·다음 버튼)로 장애를 옮김
function IncidentSheet({
  incidents,
  index,
  nonce,
  view,
  beaches,
  onMove,
  onClosed,
}: {
  incidents: readonly JobIncident[];
  index: number;
  // 열 때마다 바뀌는 값. 닫히는 동작(0.2초) 중에 다시 열어도 showModal을 다시 부르게 함
  nonce: number;
  view: CollectionView;
  beaches: Beaches;
  onMove: (index: number) => void;
  onClosed: (nonce: number) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, [nonce]);
  const close = () => ref.current?.close();
  const total = incidents.length;
  const move = (next: number) => {
    if (next >= 0 && next < total) onMove(next);
  };
  // ↑↓는 문서에서 받음(끝에서 버튼이 눌리지 않는 상태가 돼도 시트가 계속 키를 받게)
  const latest = useRef({ index, total, onMove });
  useEffect(() => {
    latest.current = { index, total, onMove };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { index: at, total: count, onMove: go } = latest.current;
      const next =
        e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : null;
      if (next === null) return;
      e.preventDefault();
      if (next >= 0 && next < count) go(next);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const incident = incidents[index];
  if (!incident) return null;
  const nowMs = Date.parse(view.generatedAt);
  return (
    <dialog
      ref={ref}
      aria-labelledby="incident-sheet-title"
      aria-describedby="incident-sheet-keys"
      onClose={() => {
        const reduce = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        // 닫을 때의 nonce를 넘김 → 그사이 다시 열었으면 부모가 지우지 않음
        const closed = nonce;
        window.setTimeout(() => onClosed(closed), reduce ? 0 : CLOSE_MS);
      }}
      onClick={(e) => {
        // 시트 안 빈 곳·여백도 target이 <dialog>라 좌표로 바깥(딤)인지 가림
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        const inside =
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom;
        if (!inside) close();
      }}
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-[480px] max-w-full overflow-y-auto border-l border-border-default bg-bg-surface px-6 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-text-default shadow-floating transition-[translate,overlay,display] transition-discrete duration-200 ease-out not-open:translate-x-full backdrop:bg-[rgb(11_26_44/0.4)] backdrop:transition-[opacity,overlay,display] backdrop:transition-discrete backdrop:duration-200 not-open:backdrop:opacity-0 starting:open:translate-x-full starting:open:backdrop:opacity-0 motion-reduce:transition-none motion-reduce:backdrop:transition-none"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => move(index - 1)}
              aria-disabled={index === 0}
              aria-label={t.sheetPrev}
              className="flex size-touch items-center justify-center rounded-admin-control text-body text-text-body hover:bg-bg-page aria-disabled:text-text-muted aria-disabled:opacity-50"
            >
              <span aria-hidden="true">↑</span>
            </button>
            <button
              type="button"
              onClick={() => move(index + 1)}
              aria-disabled={index === total - 1}
              aria-label={t.sheetNext}
              className="flex size-touch items-center justify-center rounded-admin-control text-body text-text-body hover:bg-bg-page aria-disabled:text-text-muted aria-disabled:opacity-50"
            >
              <span aria-hidden="true">↓</span>
            </button>
            <span className="text-label-s text-text-muted tabular-nums">
              {fill(t.sheetPosition, { index: index + 1, total })}
            </span>
          </span>
          <button
            type="button"
            onClick={close}
            className="flex min-h-touch items-center rounded-admin-control px-2 text-body-s font-medium text-text-body hover:bg-bg-page"
          >
            {t.close}
          </button>
        </div>
        <p id="incident-sheet-keys" className="text-label-s text-text-muted">
          {t.sheetKeys}
        </p>

        <div className="flex flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <OngoingBadge ended={incident.endedAt !== null} />
            <span className="text-label-s text-text-muted">
              {t.incidentKind[incident.kind]}
            </span>
          </span>
          <h2
            id="incident-sheet-title"
            className="text-title-s font-semibold text-text-default"
            aria-live="polite"
          >
            {incidentHeadline(incident)}
          </h2>
        </div>

        <dl className="flex flex-col gap-1.5">
          <Field label={t.startedAt}>
            <span className="tabular-nums">
              {kstDateTime(incident.startedAt)}
            </span>
          </Field>
          <Field label={t.endedAt}>
            <span className="tabular-nums">
              {incident.endedAt ? kstDateTime(incident.endedAt) : t.notEnded}
            </span>
          </Field>
          <Field label={t.duration}>
            <span className="tabular-nums">
              {fill(t.durationValue, {
                minutes: incidentMinutes(incident, nowMs),
                runs: incident.runs,
              })}
            </span>
          </Field>
        </dl>

        <Cause incident={incident} />
        <Impact incident={incident} beaches={beaches} />
        <Timeline incident={incident} nowIso={view.generatedAt} />
        <Alarms incident={incident} view={view} />
      </div>
    </dialog>
  );
}

function LoadingPlaceholder() {
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="text-body-s text-text-muted">{t.loading}</span>
      <div
        aria-hidden="true"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="h-[88px] rounded-admin-box border border-border-default bg-bg-page"
          />
        ))}
      </div>
      <span
        aria-hidden="true"
        className="h-64 rounded-admin-box border border-border-default bg-bg-page"
      />
    </div>
  );
}

function CollectionBody({ beaches }: { beaches: Beaches }) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const demo = snapshot.status !== "signed_out" && snapshot.pool === "demo";
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}|${generation}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: OpsResult<CollectionView & { readonly legacy: boolean }>;
  } | null>(null);
  // 시트는 장애 번호가 아니라 장애 키로 듦(다시 불러와 목록이 바뀌어도 다른 장애로 바뀌지 않게)
  const [sheet, setSheet] = useState<{ key: string; nonce: number } | null>(
    null,
  );
  const nonce = useRef(0);
  // 비동기 결과·닫힘 타이머에서 지금 시트를 보려고 ref로도 둠
  const sheetRef = useRef(sheet);
  useEffect(() => {
    sheetRef.current = sheet;
  });
  // 시트를 닫으면 포커스를 연 버튼으로 돌려줌
  const opener = useRef<HTMLElement | null>(null);
  // 연 버튼이 사라졌으면(그 장애가 목록에서 빠짐) 장애 기록 제목으로(포커스가 문서 맨 앞으로 떨어지지 않게)
  const restoreFocus = () => {
    const target = opener.current;
    if (target && document.contains(target)) target.focus();
    else document.getElementById("collection-incidents")?.focus();
  };
  const focusPending = useRef(false);
  useEffect(() => {
    if (sheet === null && focusPending.current) {
      focusPending.current = false;
      restoreFocus();
    }
  });

  useEffect(() => {
    let live = true;
    void fetchCollection(() => session.accessToken()).then((result) => {
      if (!live) return;
      setLoaded({ key, result });
      // 새 결과에 연 장애가 없으면(불러오기 실패 포함) 시트를 닫음. 남겨 두면 나중에 저절로 다시 열림
      const keys = result.ok
        ? new Set(allIncidents(result.body.jobs).map(incidentKey))
        : new Set<string>();
      const current = sheetRef.current;
      if (current && !keys.has(current.key)) {
        sheetRef.current = null;
        setSheet(null);
        // 모달이 열린 동안 뒤 화면은 inert라 포커스가 옮겨지지 않음 → 시트가 화면에서 빠진 뒤(아래 효과) 옮김
        focusPending.current = true;
      }
    });
    return () => {
      live = false;
    };
  }, [session, key]);

  // 다시 불러오는 동안 앞 값을 그대로 보여 줌(D16-E1 '갱신 중엔 기존 값 유지')
  const result = loaded?.result ?? null;
  const view = result?.ok ? result.body : null;
  const nowMs = view ? Date.parse(view.generatedAt) : 0;
  const incidents = useMemo(
    () => (view ? allIncidents(view.jobs) : []),
    [view],
  );
  const sheetIndex = sheet
    ? incidents.findIndex((i) => incidentKey(i) === sheet.key)
    : -1;
  const open = (index: number) => {
    const target = incidents[index];
    if (!target) return;
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    nonce.current += 1;
    setSheet({ key: incidentKey(target), nonce: nonce.current });
  };
  const move = (index: number) => {
    const target = incidents[index];
    if (target) {
      setSheet((current) =>
        current ? { ...current, key: incidentKey(target) } : current,
      );
    }
  };

  return (
    <div className="flex w-full flex-col gap-4 px-4 py-5 md:px-10 md:pt-6 md:pb-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-title-l font-semibold text-text-default">
            {t.title}
          </h1>
          {view && (
            <p className="mt-1 text-body-s text-text-muted">
              {fill(t.asOf, { time: kstDateTime(view.generatedAt) })}
              {demo && ` · ${t.demoNote}`}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <ExternalLink
            href={cloudWatchUrl(view ? alarmRegion(view) : null)}
            className="text-body-s"
          >
            {t.cloudWatch}
          </ExternalLink>
          <Button
            variant="secondary"
            size="small"
            disabled={loaded !== null && loaded.key !== key}
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t.refresh}
          </Button>
        </div>
      </div>

      {result === null && <LoadingPlaceholder />}
      {result &&
        !result.ok &&
        (result.code === "reauth" ? (
          <Notice tone="warn" title={messages.inquiries.reauth} role="alert" />
        ) : (
          <Notice tone="fail" title={t.error} role="alert">
            <p>{t.errorHint}</p>
            {"requestId" in result && result.requestId && (
              <p>
                {fill(messages.inquiries.requestId, { id: result.requestId })}
              </p>
            )}
            <Button
              variant="secondary"
              size="small"
              className="mt-2"
              onClick={() => setAttempt((n) => n + 1)}
            >
              {messages.inquiries.retry}
            </Button>
          </Notice>
        ))}
      {view && (
        <>
          {view.legacy && (
            <Notice tone="warn" title={t.oldResponse} role="status" />
          )}
          <Summary view={view} />
          <SourceTable
            view={view}
            legacy={view.legacy}
            incidents={incidents}
            onOpen={open}
          />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Hourly view={view} />
            <Incidents incidents={incidents} nowMs={nowMs} onOpen={open} />
          </div>
          <Alerts view={view} />
          {sheet !== null && sheetIndex >= 0 && (
            <IncidentSheet
              incidents={incidents}
              index={sheetIndex}
              nonce={sheet.nonce}
              view={view}
              beaches={beaches}
              onMove={move}
              onClosed={(closed) => {
                if (sheetRef.current?.nonce !== closed) return;
                sheetRef.current = null;
                setSheet(null);
                restoreFocus();
              }}
            />
          )}
        </>
      )}
      <p className="text-label-s text-text-muted">{t.note}</p>
    </div>
  );
}

export function CollectionScreen({ beaches }: { beaches: Beaches }) {
  return (
    <AdminShell title={t.title}>
      <CollectionBody beaches={beaches} />
    </AdminShell>
  );
}
