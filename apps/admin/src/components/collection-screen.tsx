"use client";

import { useEffect, useState } from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import {
  allIncidents,
  fetchCollection,
  incidentMinutes,
  kstHour,
  lowestHour,
  overallHourly,
  reasonOf,
  SOURCE_ROWS,
  sourceState,
  successRate,
  sumCounts,
  versionTime,
  type CollectionView,
  type HourBucket,
  type JobCollection,
  type RunFailure,
  type SourceRow,
  type SourceState,
} from "@/lib/collection";
import { kstDateTime } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import { AdminShell } from "./admin-shell";
import { Button, Notice } from "./ui";

// 데이터 수집 현황 (BRD-149, 화면 설계서 6장 ADM-COLLECT, 시안 4차 V9·VM2)
// - 요약(정상 출처·7일 성공·마지막 게시) · 출처별 표(PC)/카드(모바일) · 시간별 성공률 · 장애 기록 7일
// - 수집기가 남긴 실행 기록만 씀. 기록이 없으면 '기록 없음'(정상으로 보지 않음)
// - 해양수산부 운영 기간은 수집기가 없고 저장소 파일이 원본 → 수집하지 않는다고 그대로 보여 줌
// - 시안의 '관측 지연 해변'·관측소 시트(V10)·알림 규칙은 게시본·지연 기준(D15-9 미결)이 필요해 이번에 두지 않음
// - 읽기 전용. 판단 상태를 바꾸는 조작 없음(G1)

const t = messages.collection;

const SEASON_FILE =
  "https://github.com/404soonotfound/baradun_v2/blob/main/data/beach-meta.json";

const STATE_BADGE: Record<SourceState, string> = {
  ok: "bg-info-bg text-info-fg ring-1 ring-border-default",
  partial:
    "bg-status-stale-bg text-status-stale-fg outline-1 outline-status-stale-border outline-dashed -outline-offset-1",
  failed:
    "bg-status-blocked-bg text-status-blocked-fg ring-1 ring-danger-border",
  none: "bg-bg-surface text-text-muted ring-1 ring-border-strong",
};

// 색만으로 나누지 않게 글자(정상·일부 실패·실패·기록 없음)가 상태를 말함
function StateBadge({ state }: { state: SourceState }) {
  return (
    <span
      className={`inline-flex h-6 items-center rounded-admin-badge px-2 text-label-s font-medium whitespace-nowrap ${STATE_BADGE[state]}`}
    >
      {t.state[state]}
    </span>
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

// 최근 24시간 막대(칸마다 실행 수 대비 성공). 화면 읽기 프로그램에는 요약 한 줄만
function DayBars({ job }: { job: JobCollection | undefined }) {
  const day = job?.day ?? { runs: 0, ok: 0 };
  const label =
    day.runs === 0
      ? t.dayNone
      : fill(t.dayBars, { runs: day.runs, ok: day.ok });
  return (
    <span role="img" aria-label={label} className="flex h-4 items-end gap-px">
      {(job?.hourly ?? []).map((bucket) => (
        <span
          key={bucket.hour}
          aria-hidden="true"
          className={`h-4 w-1.5 rounded-[1px] ${
            bucket.runs === 0
              ? "bg-border-default"
              : bucket.ok === bucket.runs
                ? "bg-brand-default"
                : "bg-danger-border"
          }`}
        />
      ))}
    </span>
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

function rowJob(view: CollectionView, row: SourceRow) {
  return view.jobs.find((j) => j.job === row.job);
}

function Summary({ view }: { view: CollectionView }) {
  const jobs = SOURCE_ROWS.map((row) => rowJob(view, row));
  const okCount = jobs.filter((job) => sourceState(job) === "ok").length;
  const judgment = SOURCE_ROWS.filter((row) => row.judgment).length;
  // 화면 줄(SOURCE_ROWS)과 같은 수집기만 셈(정상 출처 수와 기준을 맞춤)
  const week = sumCounts(jobs.map((job) => job?.week ?? { runs: 0, ok: 0 }));
  const rate = successRate(week);
  const published = versionTime(view.publishedVersion);
  const card =
    "flex flex-col gap-1 rounded-admin-box border border-border-default bg-bg-surface px-4 py-3";
  const value = "text-title-l font-semibold text-text-default tabular-nums";
  const hint = "text-label-s text-text-muted";
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className={card}>
        <dt className="text-label-s font-medium text-text-body">
          {t.kpiSources}
        </dt>
        <dd className={value}>
          {okCount}/{SOURCE_ROWS.length}
        </dd>
        <dd className={hint}>{fill(t.kpiSourcesHint, { judgment })}</dd>
      </div>
      <div className={card}>
        <dt className="text-label-s font-medium text-text-body">{t.kpiWeek}</dt>
        <dd className={value}>{rate === null ? t.kpiWeekNone : `${rate}%`}</dd>
        {rate !== null && (
          <dd className={hint}>
            {fill(t.kpiWeekHint, { failed: week.runs - week.ok })}
          </dd>
        )}
      </div>
      <div className={card}>
        <dt className="text-label-s font-medium text-text-body">
          {t.kpiPublish}
        </dt>
        <dd className={value}>
          {published ? kstDateTime(published) : t.kpiPublishNone}
        </dd>
        <dd className={hint}>{t.kpiPublishHint}</dd>
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

function SourceTable({ view }: { view: CollectionView }) {
  const cell = "border-b border-border-default px-3 py-2.5 align-middle";
  return (
    <section aria-labelledby="collection-sources">
      <h2
        id="collection-sources"
        className="mb-2 text-title-s font-semibold text-text-default"
      >
        {t.tableTitle}
      </h2>
      {/* 태블릿·PC: 표 */}
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
          {SOURCE_ROWS.map((row) => {
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
                  {t.cycle[row.job]}
                </td>
                <td className={`${cell} tabular-nums`}>
                  {rateText(job ? successRate(job.week) : null)}
                </td>
              </tr>
            );
          })}
          <tr>
            <th scope="row" className="px-3 py-2.5 pl-4 text-left font-normal">
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
              <span className="inline-flex h-6 items-center rounded-admin-badge bg-bg-surface px-2 text-label-s font-medium text-text-muted ring-1 ring-border-strong">
                {t.seasonState}
              </span>
            </td>
            <td colSpan={4} className="px-3 py-2.5 text-body-s text-text-body">
              {t.seasonHint}{" "}
              <a
                href={SEASON_FILE}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-brand-default underline underline-offset-2"
              >
                {t.seasonLink}
              </a>
            </td>
          </tr>
        </tbody>
      </table>

      {/* 모바일(VM2): 카드. 표의 값을 빼지 않음 */}
      <ul className="flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface md:hidden">
        {SOURCE_ROWS.map((row) => {
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
                  <dt className="text-label-s text-text-muted">{t.colCycle}</dt>
                  <dd className="text-text-default">{t.cycle[row.job]}</dd>
                </div>
                <div>
                  <dt className="text-label-s text-text-muted">{t.colWeek}</dt>
                  <dd className="text-text-default tabular-nums">
                    {rateText(job ? successRate(job.week) : null)}
                  </dd>
                </div>
              </dl>
              {job?.truncated && (
                <p className="text-label-s text-text-muted">{t.truncated}</p>
              )}
            </li>
          );
        })}
        <li className="flex flex-col gap-1 px-4 py-3">
          <span className="flex items-start justify-between gap-3">
            <span className="font-medium text-text-default">{t.season}</span>
            <span className="inline-flex h-6 items-center rounded-admin-badge px-2 text-label-s font-medium text-text-muted ring-1 ring-border-strong">
              {t.seasonState}
            </span>
          </span>
          <span className="text-body-s text-text-body">
            {t.seasonHint}{" "}
            <a
              href={SEASON_FILE}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-brand-default underline underline-offset-2"
            >
              {t.seasonLink}
            </a>
          </span>
        </li>
      </ul>
    </section>
  );
}

function hourLabel(bucket: HourBucket): string {
  const hour = kstHour(bucket.hour);
  return bucket.runs === 0
    ? fill(t.hourlyBarEmpty, { hour })
    : fill(t.hourlyBar, { hour, ok: bucket.ok, runs: bucket.runs });
}

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
      <ol
        className="mt-3 flex h-24 items-end gap-0.5"
        aria-label={t.hourlyTitle}
      >
        {hourly.map((bucket) => {
          const rate = bucket.runs === 0 ? 0 : bucket.ok / bucket.runs;
          return (
            <li
              key={bucket.hour}
              title={hourLabel(bucket)}
              className="flex h-full flex-1 items-end"
            >
              <span className="sr-only">{hourLabel(bucket)}</span>
              <span
                aria-hidden="true"
                style={{ height: `${Math.max(rate * 100, 4)}%` }}
                className={`w-full rounded-t-[2px] ${
                  bucket.runs === 0
                    ? "bg-border-default"
                    : rate === 1
                      ? "bg-brand-default"
                      : "bg-danger-border"
                }`}
              />
            </li>
          );
        })}
      </ol>
      <p className="mt-2 text-body-s text-text-body">{summary}</p>
    </section>
  );
}

function Incidents({ view, nowMs }: { view: CollectionView; nowMs: number }) {
  const incidents = allIncidents(view.jobs);
  return (
    <section
      aria-labelledby="collection-incidents"
      className="rounded-admin-box border border-border-default bg-bg-surface px-4 py-3"
    >
      <h2
        id="collection-incidents"
        className="text-title-s font-semibold text-text-default"
      >
        {t.incidentsTitle}{" "}
        <span className="text-text-muted tabular-nums">{incidents.length}</span>
      </h2>
      {incidents.length === 0 ? (
        <p className="mt-2 text-body-s text-text-muted">{t.incidentsEmpty}</p>
      ) : (
        <ul className="mt-2 flex flex-col divide-y divide-border-default">
          {incidents.map((incident) => {
            const first = incident.failures[0];
            const more = incident.failures.length - 1;
            const name =
              incident.job in t.source
                ? t.source[incident.job as keyof typeof t.source]
                : incident.job;
            return (
              <li
                key={`${incident.job}|${incident.startedAt}`}
                className="flex items-start justify-between gap-3 py-2.5"
              >
                <span className="flex flex-col gap-0.5">
                  <span className="text-body text-text-default">
                    {name}
                    {first && ` · ${reasonText(first)}`}
                    {more > 0 && ` ${fill(t.incidentMore, { count: more })}`}
                  </span>
                  {first?.message && (
                    <span className="text-label-s break-all text-text-muted">
                      {first.message}
                    </span>
                  )}
                  <span className="text-label-s text-text-muted tabular-nums">
                    {fill(t.incidentMeta, {
                      time: kstDateTime(incident.startedAt),
                      minutes: incidentMinutes(incident, nowMs),
                      runs: incident.runs,
                    })}
                  </span>
                </span>
                <span
                  className={`inline-flex h-6 shrink-0 items-center rounded-admin-badge px-2 text-label-s font-medium ${
                    incident.endedAt ? STATE_BADGE.none : STATE_BADGE.failed
                  }`}
                >
                  {incident.endedAt ? t.incidentResolved : t.incidentOngoing}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CollectionBody() {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const demo = snapshot.status !== "signed_out" && snapshot.pool === "demo";
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}|${generation}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: OpsResult<CollectionView>;
  } | null>(null);

  useEffect(() => {
    let live = true;
    void fetchCollection(() => session.accessToken()).then((result) => {
      if (live) setLoaded({ key, result });
    });
    return () => {
      live = false;
    };
  }, [session, key]);

  // 다시 불러오는 동안 앞 값을 그대로 보여 줌(D16-E1 '갱신 중엔 기존 값 유지')
  const result = loaded?.result ?? null;
  const view = result?.ok ? result.body : null;
  const nowMs = view ? Date.parse(view.generatedAt) : 0;

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
        <Button
          variant="secondary"
          size="small"
          disabled={loaded !== null && loaded.key !== key}
          onClick={() => setAttempt((n) => n + 1)}
        >
          {t.refresh}
        </Button>
      </div>

      {result === null && (
        <p role="status" className="text-body-s text-text-muted">
          {t.loading}
        </p>
      )}
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
          <Summary view={view} />
          <SourceTable view={view} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Hourly view={view} />
            <Incidents view={view} nowMs={nowMs} />
          </div>
        </>
      )}
      <p className="text-label-s text-text-muted">{t.note}</p>
    </div>
  );
}

export function CollectionScreen() {
  return (
    <AdminShell title={t.title}>
      <CollectionBody />
    </AdminShell>
  );
}
