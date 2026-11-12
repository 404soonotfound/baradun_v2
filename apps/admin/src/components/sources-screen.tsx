"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import { reasonText, type RunView } from "@/lib/collection";
import { kstDateTime } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import {
  fetchSources,
  keyNames,
  keyOf,
  keyState,
  kstClock,
  latestState,
  monthRanges,
  scheduleSlots,
  type KeyState,
  type RunState,
  type SourceCall,
  type SourceSchedule,
  type SourcesView,
  type SourceView,
} from "@/lib/sources";
import { AdminShell } from "./admin-shell";
import { Button, Notice, SUCCESS_BADGE } from "./ui";

// 데이터 출처 목록·상세 (BRD-149·GH-328, 화면 설계서 6장 ADM-SRC, 시안 4차 V12·V13·VM13)
// - 읽기 전용(6장 '조작 없음'). 시안의 '지금 한 번 받아오기'는 6장·S1에 API가 없어 두지 않음
// - 인증키는 등록 여부·만료일만. 원본 응답은 저장하지 않으므로 응답 예시도 보여 주지 않음(6장·아키텍처 10장)
// - 시안의 '만료 30일 안'·'호출 한도'는 노션에 기준·자료가 없어 두지 않음. 남은 날과 만료 지남만 보여 줌
// - 상세는 정적 내보내기라 /sources/?id= 로 엶(공지·문의와 같음)

const t = messages.sources;

const BADGE =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-admin-badge px-2 text-label-s font-medium whitespace-nowrap";

// 색만으로 나누지 않게 점 모양도 다르게 두고, 글자가 상태를 말함
const RUN_BADGE: Record<RunState, { box: string; dot: string }> = {
  // 성공한 수집은 작업 성공색(color.success, 결정 E6·BRD-165)
  complete: {
    box: SUCCESS_BADGE,
    dot: "size-2 rounded-full bg-success-icon",
  },
  partial: {
    box: "bg-status-stale-bg text-status-stale-fg outline-1 outline-status-stale-border outline-dashed -outline-offset-1",
    dot: "size-2 rotate-45 bg-status-stale-fg",
  },
  failed: {
    box: "bg-status-blocked-bg text-status-blocked-fg ring-1 ring-danger-border",
    dot: "size-2 bg-danger-border",
  },
  none: {
    box: "bg-bg-surface text-text-muted ring-1 ring-border-strong",
    dot: "size-2 rounded-full border border-border-strong",
  },
  unknown: {
    box: "bg-bg-surface text-text-body outline-1 outline-border-strong outline-dashed -outline-offset-1",
    dot: "size-2 rounded-full border border-dashed border-text-body",
  },
};

function RunBadge({ state }: { state: RunState }) {
  const style = RUN_BADGE[state];
  return (
    <span className={`${BADGE} ${style.box}`}>
      <span aria-hidden="true" className={style.dot} />
      {t.runState[state]}
    </span>
  );
}

const KEY_TONE: Record<KeyState, RunState> = {
  registered: "complete",
  noExpiry: "partial",
  invalid: "partial",
  expired: "failed",
  missing: "failed",
  unknown: "unknown",
  hidden: "none",
};

function KeyBadge({ state }: { state: KeyState }) {
  const style = RUN_BADGE[KEY_TONE[state]];
  return (
    <span className={`${BADGE} ${style.box}`}>
      <span aria-hidden="true" className={style.dot} />
      {t.keyState[state]}
    </span>
  );
}

const SEASON_FILE =
  "https://github.com/404soonotfound/baradun_v2/blob/main/data/beach-meta.json";

function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-brand-default underline underline-offset-2"
    >
      {children}
      <span className="sr-only"> {t.newTab}</span>
    </a>
  );
}

// 하루를 나누는 주기만 '하루 n회'. 그 밖은 분 그대로(반올림한 횟수로 보이지 않게)
function periodText(minutes: number): string {
  const DAY = 24 * 60;
  if (minutes === 60) return t.everyHour;
  if (minutes === DAY) return t.daily;
  if (minutes > 60 && minutes < DAY && DAY % minutes === 0) {
    return fill(t.everyDays, { times: DAY / minutes });
  }
  return fill(t.every, { minutes });
}

function cycleText(schedule: SourceSchedule): string {
  const base = fill(t.cycleText, {
    period: periodText(schedule.periodMinutes),
    slots: scheduleSlots(schedule).join(" "),
  });
  const off = schedule.offSeason;
  if (!off || off.seasonMonths.length === 0) return base;
  return fill(t.offSeasonText, {
    months: monthRanges(off.seasonMonths)
      .map(([from, to]) =>
        from === to ? String(from) : fill(t.monthRange, { from, to }),
      )
      .join(t.monthJoin),
    period: base,
    slot: kstClock(off.slotUtcMinutes),
  });
}

function failureText(source: SourceView): string {
  return source.judgment &&
    (source.id === "collect-warnings" || source.id === "collect-ocean")
    ? t.failure[source.id]
    : t.failure.reference;
}

function termsText(source: SourceView): string {
  return source.id === "collect-catalog"
    ? t.terms["collect-catalog"]
    : t.terms.other;
}

// 기록을 읽지 못했거나 읽지 못한 기록이 있으면 '확인 못 함'(배지와 같은 기준, 읽힌 기록 중 최신으로 가리지 않음)
function lastRunText(source: SourceView): string {
  if (latestState(source) === "unknown") return t.runState.unknown;
  const run = source.recentRuns?.[0];
  return run ? kstDateTime(run.startedAt) : t.none;
}

function daysText(days: number | null): string {
  if (days === null) return t.none;
  if (days === 0) return t.daysToday;
  return days < 0
    ? fill(t.daysPast, { days: -days })
    : fill(t.daysLeft, { days });
}

const detailHref = (id: string) => `/sources/?id=${encodeURIComponent(id)}`;

const CARD =
  "rounded-admin-box border border-border-default bg-bg-surface px-4 py-3";
const LABEL = "text-label-s font-medium text-text-body";
const HINT = "text-label-s text-text-muted";

// ── 목록 ──

function Summary({ view }: { view: SourcesView }) {
  const judgment = view.sources.filter((s) => s.judgment);
  const judgmentOk = judgment.filter(
    (s) => latestState(s) === "complete",
  ).length;
  const names = keyNames(view);
  const states = names.map((name) => keyState(view, name));
  const count = (state: KeyState) => states.filter((s) => s === state).length;
  // 만료일이 지나지 않은 등록 키만 셈. 하나라도 확인 못 하면 수 대신 '확인 못 함'(미등록처럼 보이지 않게)
  const usable = count("registered") + count("noExpiry") + count("invalid");
  const value = "text-title-l font-semibold text-text-default tabular-nums";
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className={`flex flex-col gap-1 ${CARD}`}>
        <dt className={LABEL}>{t.kpiSources}</dt>
        <dd className={value}>
          {fill(t.kpiSourcesValue, { count: view.sources.length })}
        </dd>
        <dd className={HINT}>
          {fill(t.kpiSourcesHint, {
            judgment: judgment.length,
            reference: view.sources.length - judgment.length,
          })}
        </dd>
      </div>
      <div className={`flex flex-col gap-1 ${CARD}`}>
        <dt className={LABEL}>{t.kpiJudgment}</dt>
        <dd className={value}>
          {fill(t.kpiJudgmentValue, {
            ok: judgmentOk,
            total: judgment.length,
          })}
        </dd>
        <dd className={HINT}>{t.kpiJudgmentHint}</dd>
      </div>
      <div className={`flex flex-col gap-1 ${CARD}`}>
        <dt className={LABEL}>{t.kpiKeys}</dt>
        {view.keysHidden ? (
          <dd className={`${value} text-title-s`}>{t.kpiKeysHidden}</dd>
        ) : (
          <>
            <dd className={value}>
              {count("unknown") > 0
                ? t.keyState.unknown
                : fill(t.kpiKeysValue, { ok: usable, total: names.length })}
            </dd>
            <dd className={HINT}>
              {fill(t.kpiKeysHint, {
                expired: count("expired"),
                missing: count("missing"),
                unknown: count("unknown"),
              })}
            </dd>
          </>
        )}
      </div>
    </dl>
  );
}

function JudgmentCard({ source }: { source: SourceView }) {
  const name = t.name[source.id];
  const row = "grid grid-cols-[6rem_1fr] gap-2 py-1.5 text-body-s";
  return (
    <article className={`flex flex-col gap-2 ${CARD}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={HINT}>{t.provider[source.id]}</p>
          <h3 className="text-title-s font-semibold text-text-default">
            <Link
              href={detailHref(source.id)}
              aria-label={fill(t.openDetail, { name })}
              className="underline-offset-2 hover:underline"
            >
              {name}
            </Link>
          </h3>
          <p className="text-label-s text-text-muted">
            {source.calls.map((c) => c.operation).join(t.listJoin)}
          </p>
        </div>
        <RunBadge state={latestState(source)} />
      </div>
      <dl className="divide-y divide-border-default">
        <div className={row}>
          <dt className="text-text-muted">{t.fieldValues}</dt>
          <dd className="text-text-default">{t.values[source.id]}</dd>
        </div>
        <div className={row}>
          <dt className="text-text-muted">{t.fieldCycle}</dt>
          <dd className="text-text-default">{cycleText(source.schedule)}</dd>
        </div>
        <div className={row}>
          <dt className="text-text-muted">{t.fieldApp}</dt>
          <dd className="text-text-default">{t.app[source.id]}</dd>
        </div>
        <div className={row}>
          <dt className="text-text-muted">{t.fieldFailure}</dt>
          <dd className="text-text-default">{failureText(source)}</dd>
        </div>
        <div className={row}>
          <dt className="text-text-muted">{t.fieldLastRun}</dt>
          <dd className="text-text-default tabular-nums">
            {lastRunText(source)}
          </dd>
        </div>
      </dl>
    </article>
  );
}

function ReferenceList({ sources }: { sources: readonly SourceView[] }) {
  const cell = "border-b border-border-default px-3 py-2.5 align-top";
  const head = `${cell} text-left text-label-s font-medium text-text-muted`;
  return (
    <>
      {/* PC: 표 */}
      <div className="hidden overflow-x-auto rounded-admin-box border border-border-default bg-bg-surface lg:block">
        <table className="w-full text-body-s">
          <thead>
            <tr>
              <th scope="col" className={head}>
                {t.colSource}
              </th>
              <th scope="col" className={head}>
                {t.colCalls}
              </th>
              <th scope="col" className={head}>
                {t.colValues}
              </th>
              <th scope="col" className={head}>
                {t.colCycle}
              </th>
              <th scope="col" className={head}>
                {t.colApp}
              </th>
              <th scope="col" className={head}>
                {t.colState}
              </th>
              <th scope="col" className={head}>
                {t.colLastRun}
              </th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <th scope="row" className={`${cell} text-left font-normal`}>
                  <Link
                    href={detailHref(s.id)}
                    aria-label={fill(t.openDetail, { name: t.name[s.id] })}
                    className="font-medium text-brand-default underline underline-offset-2"
                  >
                    {t.name[s.id]}
                  </Link>
                  <span className={`block ${HINT}`}>{t.provider[s.id]}</span>
                </th>
                <td className={cell}>
                  {s.calls.map((c) => c.operation).join(t.listJoin)}
                </td>
                <td className={cell}>{t.values[s.id]}</td>
                <td className={cell}>{cycleText(s.schedule)}</td>
                <td className={cell}>{t.app[s.id]}</td>
                <td className={cell}>
                  <RunBadge state={latestState(s)} />
                </td>
                <td className={`${cell} tabular-nums`}>{lastRunText(s)}</td>
              </tr>
            ))}
            <tr>
              <th scope="row" className={`${cell} text-left font-medium`}>
                {t.season}
              </th>
              <td className={cell} colSpan={4}>
                {t.seasonHint}
                {t.listJoin}
                <ExternalLink href={SEASON_FILE}>{t.seasonLink}</ExternalLink>
              </td>
              <td className={cell}>
                <span className={`${BADGE} ${RUN_BADGE.none.box}`}>
                  {t.seasonState}
                </span>
              </td>
              <td className={cell}>{t.none}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {/* 모바일: 값을 빼지 않고 카드로 */}
      <ul className="flex flex-col gap-2 lg:hidden">
        {sources.map((s) => (
          <li key={s.id} className={CARD}>
            <div className="flex items-start justify-between gap-2">
              <Link
                href={detailHref(s.id)}
                aria-label={fill(t.openDetail, { name: t.name[s.id] })}
                className="flex min-h-touch flex-col justify-center"
              >
                <span className="font-medium text-brand-default underline underline-offset-2">
                  {t.name[s.id]}
                </span>
                <span className={HINT}>{t.provider[s.id]}</span>
              </Link>
              <RunBadge state={latestState(s)} />
            </div>
            <dl className="mt-2 grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-body-s">
              <dt className="text-text-muted">{t.colCalls}</dt>
              <dd>{s.calls.map((c) => c.operation).join(t.listJoin)}</dd>
              <dt className="text-text-muted">{t.colValues}</dt>
              <dd>{t.values[s.id]}</dd>
              <dt className="text-text-muted">{t.colCycle}</dt>
              <dd>{cycleText(s.schedule)}</dd>
              <dt className="text-text-muted">{t.colApp}</dt>
              <dd>{t.app[s.id]}</dd>
              <dt className="text-text-muted">{t.colLastRun}</dt>
              <dd className="tabular-nums">{lastRunText(s)}</dd>
            </dl>
          </li>
        ))}
        <li className={CARD}>
          <div className="flex items-start justify-between gap-2">
            <span className="font-medium text-text-default">{t.season}</span>
            <span className={`${BADGE} ${RUN_BADGE.none.box}`}>
              {t.seasonState}
            </span>
          </div>
          <p className="mt-1 text-body-s text-text-body">
            {t.seasonHint}
            {t.listJoin}
            <ExternalLink href={SEASON_FILE}>{t.seasonLink}</ExternalLink>
          </p>
        </li>
      </ul>
    </>
  );
}

function KeyHint({ state }: { state: KeyState }) {
  if (state === "registered" || state === "hidden") return null;
  return <p className={`mt-0.5 ${HINT}`}>{t.keyStateHint[state]}</p>;
}

function Keys({ view }: { view: SourcesView }) {
  const names = keyNames(view);
  return (
    <section aria-labelledby="sources-keys" className="flex flex-col gap-2">
      <div>
        <h2
          id="sources-keys"
          className="text-title-s font-semibold text-text-default"
        >
          {t.keysTitle}
        </h2>
        <p className={HINT}>{t.keysHint}</p>
      </div>
      {view.keysHidden ? (
        <Notice tone="neutral" title={t.keysHidden} />
      ) : (
        <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {names.map((name) => {
            const state = keyState(view, name);
            const key = keyOf(view, name);
            const usedBy = view.sources
              .filter((s) => s.key === name)
              .map((s) => t.name[s.id])
              .join(t.listJoin);
            return (
              <li key={name} className={CARD}>
                <div className="flex items-start justify-between gap-2">
                  <span className="font-mono text-body-s font-medium text-text-default">
                    {name}
                  </span>
                  <KeyBadge state={state} />
                </div>
                <KeyHint state={state} />
                <dl className="mt-2 grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-body-s">
                  <dt className="text-text-muted">{t.colExpires}</dt>
                  <dd className="tabular-nums">{key?.expiresOn ?? t.none}</dd>
                  <dt className="text-text-muted">{t.colDaysLeft}</dt>
                  <dd className="tabular-nums">
                    {daysText(key?.daysLeft ?? null)}
                  </dd>
                  <dt className="text-text-muted">{t.colUsedBy}</dt>
                  <dd>{usedBy}</dd>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function SourcesList({ view }: { view: SourcesView }) {
  const judgment = view.sources.filter((s) => s.judgment);
  const reference = view.sources.filter((s) => !s.judgment);
  return (
    <>
      <Summary view={view} />
      <section
        aria-labelledby="sources-judgment"
        className="flex flex-col gap-2"
      >
        <div>
          <h2
            id="sources-judgment"
            className="text-title-s font-semibold text-text-default"
          >
            {fill(t.judgmentTitle, { count: judgment.length })}
          </h2>
          <p className={HINT}>{t.judgmentHint}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {judgment.map((s) => (
            <JudgmentCard key={s.id} source={s} />
          ))}
        </div>
      </section>
      <section
        aria-labelledby="sources-reference"
        className="flex flex-col gap-2"
      >
        <div>
          <h2
            id="sources-reference"
            className="text-title-s font-semibold text-text-default"
          >
            {fill(t.referenceTitle, { count: reference.length })}
          </h2>
          <p className={HINT}>{t.referenceHint}</p>
        </div>
        <ReferenceList sources={reference} />
      </section>
      <Keys view={view} />
    </>
  );
}

// ── 상세 ──

function issuedText(call: SourceCall): string {
  if (!call.issued) return t.callEveryRun;
  const { hoursKst, delayMinutes } = call.issued;
  return hoursKst.length === 24
    ? fill(t.callIssuedHourly, { delay: delayMinutes })
    : fill(t.callIssued, { hours: hoursKst.join("·"), delay: delayMinutes });
}

function Calls({ source }: { source: SourceView }) {
  return (
    <section aria-labelledby="source-calls" className="flex flex-col gap-2">
      <h2
        id="source-calls"
        className="text-title-s font-semibold text-text-default"
      >
        {fill(t.callsTitle, { count: source.calls.length })}
      </h2>
      <ol className="flex flex-col gap-2">
        {source.calls.map((call) => (
          <li key={`${call.url}|${call.operation}`} className={CARD}>
            <p className="font-medium text-text-default">{call.operation}</p>
            <p className="mt-1 font-mono text-label-s break-all text-text-body">
              {fill(t.callLine, { url: call.url })}
            </p>
            <ul className="mt-2 flex flex-col gap-0.5 text-body-s text-text-body">
              <li>
                {call.rowLimit === null
                  ? t.callRowsNone
                  : fill(t.callRows, {
                      count: call.rowLimit.toLocaleString("ko-KR"),
                    })}
              </li>
              <li>{issuedText(call)}</li>
              <li>{fill(t.callKey, { key: source.key })}</li>
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Runs({ source }: { source: SourceView }) {
  const runs = source.recentRuns;
  return (
    <section aria-labelledby="source-runs" className="flex flex-col gap-2">
      <div>
        <h2
          id="source-runs"
          className="text-title-s font-semibold text-text-default"
        >
          {t.runsTitle}
        </h2>
        {runs && runs.length > 0 && (
          <p className={HINT}>{fill(t.runsHint, { count: runs.length })}</p>
        )}
      </div>
      {source.unreadableRuns > 0 && (
        <Notice
          tone="warn"
          role="status"
          title={fill(t.runsUnreadable, { count: source.unreadableRuns })}
        />
      )}
      {runs === null ? (
        <Notice tone="warn" title={t.runsUnknown} />
      ) : runs.length === 0 ? (
        <Notice tone="neutral" title={t.runsNone} />
      ) : (
        <ol className={`divide-y divide-border-default ${CARD} py-0`}>
          {runs.map((run) => (
            <RunRow key={`${run.startedAt}|${run.finishedAt}`} run={run} />
          ))}
        </ol>
      )}
    </section>
  );
}

function RunRow({ run }: { run: RunView }) {
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  const missing = run.missingStationsTotal ?? run.missingStations?.length ?? 0;
  return (
    <li className="flex flex-col gap-1 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-body-s">
        <span className="font-medium text-text-default tabular-nums">
          {kstDateTime(run.startedAt)}
        </span>
        <RunBadge state={run.status} />
        {Number.isFinite(ms) && ms >= 0 && (
          <span className="text-text-muted tabular-nums">
            {fill(t.runDuration, { seconds: (ms / 1000).toFixed(1) })}
          </span>
        )}
      </div>
      {run.failures.length > 0 && (
        <ul className="text-label-s text-text-body">
          {run.failures.map((f, i) => (
            <li key={`${f.source}|${f.reason}|${i}`}>
              {fill(t.runFailure, { source: f.source, reason: reasonText(f) })}
            </li>
          ))}
        </ul>
      )}
      {/* 성공한 실행이어도 빠진 관측소는 숨기지 않음(collect-ocean, BRD-187) */}
      {missing > 0 && (
        <p className="text-label-s text-text-body">
          {fill(t.runMissing, {
            count: missing,
            ids: (run.missingStations ?? []).join(t.listJoin),
          })}
        </p>
      )}
    </li>
  );
}

function SourceDetail({
  view,
  source,
}: {
  view: SourcesView;
  source: SourceView;
}) {
  const state = keyState(view, source.key);
  const key = keyOf(view, source.key);
  const metric = `flex flex-col gap-1 ${CARD}`;
  const value = "text-body font-semibold text-text-default";
  const seconds = (ms: number) => Math.round(ms / 100) / 10;
  const expires =
    state === "hidden" || state === "unknown" || state === "missing"
      ? t.keyState[state]
      : key?.expiresOn
        ? fill(t.expiresWithDays, {
            date: key.expiresOn,
            days: daysText(key.daysLeft),
          })
        : t.keyState[state];
  const info: readonly [string, React.ReactNode][] = [
    [t.infoProvider, t.provider[source.id]],
    [t.infoKey, <KeyBadge key="k" state={state} />],
    [t.infoExpires, expires],
    [
      t.infoCollector,
      <span key="c" className="font-mono">
        {source.id}
      </span>,
    ],
    [t.fieldValues, t.values[source.id]],
    [t.fieldApp, t.app[source.id]],
    [t.fieldFailure, failureText(source)],
    [t.infoTerms, termsText(source)],
  ];
  return (
    <>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-title-l font-semibold text-text-default">
            {t.name[source.id]}
          </h2>
          <RunBadge state={latestState(source)} />
        </div>
        <p className="text-body-s text-text-muted">
          {fill(t.detailMeta, {
            provider: t.provider[source.id],
            use: source.judgment ? t.judgment : t.reference,
            id: source.id,
          })}
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className={metric}>
          <dt className={LABEL}>{t.metricCycle}</dt>
          <dd className={value}>{cycleText(source.schedule)}</dd>
        </div>
        <div className={metric}>
          <dt className={LABEL}>{t.metricTimeout}</dt>
          <dd className={value}>
            {fill(t.metricTimeoutValue, {
              seconds: seconds(view.http.timeoutMs),
              retries: view.http.retries,
            })}
          </dd>
        </div>
        <div className={metric}>
          <dt className={LABEL}>{t.metricBudget}</dt>
          <dd className={value}>
            {source.budgetMs === null
              ? t.metricBudgetNone
              : fill(t.metricBudgetValue, {
                  seconds: seconds(source.budgetMs),
                })}
          </dd>
          {source.extraRetryMax !== null && (
            <dd className={HINT}>
              {fill(t.metricBudgetRetry, { count: source.extraRetryMax })}
            </dd>
          )}
        </div>
        <div className={metric}>
          <dt className={LABEL}>{t.metricLate}</dt>
          <dd className={value}>
            {source.lateAfterMinutes === null
              ? t.metricLateNone
              : fill(t.metricLateValue, { minutes: source.lateAfterMinutes })}
          </dd>
        </div>
      </dl>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <Calls source={source} />
          <Runs source={source} />
        </div>
        <section aria-labelledby="source-info" className="flex flex-col gap-2">
          <h2
            id="source-info"
            className="text-title-s font-semibold text-text-default"
          >
            {t.infoTitle}
          </h2>
          <dl className={`divide-y divide-border-default ${CARD} py-0`}>
            {info.map(([label, content]) => (
              <div
                key={label}
                className="grid grid-cols-[6rem_1fr] gap-2 py-2 text-body-s"
              >
                <dt className="text-text-muted">{label}</dt>
                <dd className="text-text-default">{content}</dd>
              </div>
            ))}
          </dl>
          <KeyHint state={state} />
        </section>
      </div>
    </>
  );
}

// ── 불러오기 ──

function LoadingPlaceholder() {
  return (
    <div role="status" className="flex flex-col gap-3">
      <span className="text-body-s text-text-muted">{t.loading}</span>
      <div aria-hidden="true" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
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

function SourcesBody() {
  const params = useSearchParams();
  const id = params.get("id");
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const demo = snapshot.status !== "signed_out" && snapshot.pool === "demo";
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}|${generation}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: OpsResult<SourcesView>;
  } | null>(null);

  useEffect(() => {
    let live = true;
    void fetchSources(() => session.accessToken()).then((result) => {
      if (live) setLoaded({ key, result });
    });
    return () => {
      live = false;
    };
  }, [session, key]);

  // 다시 불러오는 동안 앞 값을 그대로 보여 줌(D16-E1)
  const result = loaded?.result ?? null;
  const view = result?.ok ? result.body : null;
  const source = id && view ? view.sources.find((s) => s.id === id) : null;
  const reload = () => setAttempt((n) => n + 1);

  return (
    <div className="flex w-full flex-col gap-4 px-4 py-5 md:px-10 md:pt-6 md:pb-10">
      {id !== null && (
        <Link
          href="/sources/"
          className="inline-flex min-h-touch items-center self-start text-body-s font-medium text-brand-default underline-offset-2 hover:underline lg:min-h-admin-control"
        >
          {t.backLink}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-title-l font-semibold text-text-default">
            {t.title}
          </h1>
          <p className="mt-1 text-body-s text-text-muted">
            {[
              t.intro,
              view && fill(t.asOf, { time: kstDateTime(view.generatedAt) }),
              demo && t.demoNote,
            ]
              .filter(Boolean)
              .join(t.listJoin)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/collection/"
            className="text-body-s font-medium text-brand-default underline underline-offset-2"
          >
            {t.collectionLink}
          </Link>
          <Button
            variant="secondary"
            size="small"
            // 첫 불러오기 중에도 막음(누를 때마다 요청이 새로 나가지 않게)
            disabled={loaded === null || loaded.key !== key}
            onClick={reload}
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
              onClick={reload}
            >
              {messages.inquiries.retry}
            </Button>
          </Notice>
        ))}
      {view && id === null && <SourcesList view={view} />}
      {view && id !== null && source && (
        <SourceDetail view={view} source={source} />
      )}
      {view && id !== null && !source && (
        <Notice tone="warn" title={t.notFound} role="status">
          <p>{t.notFoundHint}</p>
        </Notice>
      )}
      <p className="text-label-s text-text-muted">{t.note}</p>
    </div>
  );
}

export function SourcesScreen() {
  return (
    <AdminShell title={t.title}>
      {/* 정적 내보내기라 주소 ?id= 는 브라우저에서 읽음(useSearchParams는 Suspense 안) */}
      <Suspense fallback={null}>
        <SourcesBody />
      </Suspense>
    </AdminShell>
  );
}
