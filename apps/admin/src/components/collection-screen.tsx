"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import type { BeachName } from "@/lib/beach-names";
import {
  alarmInfo,
  allIncidents,
  incidentKey,
  incidentErrorTitle,
  groupedAlarms,
  logsUrl,
  matchesFilter,
  barCounts,
  barState,
  cloudWatchUrl,
  cycleDelayText,
  fetchCollection,
  incidentMinutes,
  incidentTimeline,
  kstClock,
  kstHour,
  lambdaUrl,
  lowestHour,
  overallHourly,
  reasonText,
  sameKstDay,
  SOURCE_ROWS,
  sourceState,
  successRate,
  sumCounts,
  versionTime,
  type AlarmState,
  type AlarmView,
  type BarState,
  type CollectionView,
  type HourBucket,
  type HourCounts,
  type JobCollection,
  type JobIncident,
  type SourceFilter,
  type SourceRow,
  type SourceState,
  type StationRow,
  type TimelineEvent,
} from "@/lib/collection";
import { kstDateTime } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import { AdminShell } from "./admin-shell";
import { Notice, SUCCESS_BADGE } from "./ui";

// 데이터 수집 현황 (BRD-149·GH-376·GH-380, 화면 설계서 6장 ADM-COLLECT, 시안 4차 V9·V10·VM2)
// - 요약 4칸(정상 출처·7일 성공·관측 지연 해변·마지막 게시) · 출처별 표(PC)/카드(모바일) · 시간별 성공률 선 그래프
//   · 장애 기록 7일 → 장애 상세 시트 · 알림(CloudWatch 경보) · 출처 줄 → 출처 시트(V10, 해양 관측은 관측소 목록)
// - 수집기가 남긴 실행 기록·게시 요약·경보·관측소 표만 씀. 기록이 없으면 '기록 없음', 못 읽으면 '확인 못 함'
//   (정상·'영향 없음'·'경보 없음'·0으로 보지 않음)
// - 지연 기준(D15-10)은 서버가 내려준 값 그대로. 관측 지연 해변 수는 publisher가 게시할 때 계산한 그대로
// - 해양수산부 운영 기간은 수집기가 없고 저장소 파일이 원본 → 수집하지 않는다고 그대로 보여 줌
// - 읽기 전용. 판단 상태를 바꾸는 조작·사유 메모 없음(G1, 메모는 쓰기 API·감사 기록이 필요해 후속)
// - 시안의 초록(정상·해결)은 공유 토큰의 초록 금지(노션 4장, 토큰 검사)로 브랜드 파랑을 씀

const t = messages.collection;

type Beaches = Readonly<Record<string, BeachName>>;

const SEASON_FILE =
  "https://github.com/404soonotfound/baradun_v2/blob/main/data/beach-meta.json";

// ── 공통 모양(시안 V9 w-bd·w-btn·w-t·w-li) ──

type BadgeTone = "success" | "ended" | "warn" | "error" | "unknown" | "neutral";

// 수집 정상은 작업 성공색(color.success, 결정 E6·BRD-165). 해변 '특보 없음' 파랑(status.clear)과 섞지 않음
const BADGE_TONE: Record<BadgeTone, string> = {
  success: SUCCESS_BADGE,
  // 끝난 장애: 공지 화면의 '종료'와 같은 모양(정보·데이터 부족 회색과 구분)
  ended: "bg-bg-surface text-text-muted ring-1 ring-border-strong",
  warn: "bg-status-stale-bg text-status-stale-fg outline-1 outline-status-stale-border outline-dashed -outline-offset-1",
  error:
    "bg-status-blocked-bg text-status-blocked-fg ring-1 ring-danger-border ring-inset",
  unknown:
    "bg-status-unknown-bg text-status-unknown-fg outline-1 outline-status-unknown-border outline-dashed -outline-offset-1",
  neutral: "bg-info-bg text-info-fg ring-1 ring-border-strong ring-inset",
};

function Badge({
  tone,
  children,
}: {
  tone: BadgeTone;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-admin-badge px-1.5 py-px text-[12px] leading-[18px] font-semibold whitespace-nowrap ${BADGE_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

const STATE_TONE: Record<SourceState, BadgeTone> = {
  ok: "success",
  late: "warn",
  unchecked: "unknown",
  partial: "warn",
  failed: "error",
  none: "neutral",
};

function StateBadge({ state }: { state: SourceState }) {
  return <Badge tone={STATE_TONE[state]}>{t.state[state]}</Badge>;
}

// 상태 점 + 글자(시안 V9 표). 글자가 상태를 말하고 점은 장식
const DOT: Record<SourceState, string> = {
  ok: "bg-success-icon",
  late: "bg-status-stale-border",
  unchecked: "border border-dashed border-status-unknown-border",
  partial: "bg-status-stale-border",
  failed: "bg-status-blocked-fg",
  none: "bg-border-note",
};

function Dot({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block size-2 shrink-0 rounded-full ${className}`}
    />
  );
}

function StateDot({ state }: { state: SourceState }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <Dot className={DOT[state]} />
      {t.state[state]}
    </span>
  );
}

const ALARM_TONE: Record<AlarmState, BadgeTone> = {
  ALARM: "error",
  OK: "success",
  INSUFFICIENT_DATA: "neutral",
  unknown: "unknown",
};

function ChevronIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function OutIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}

// 시안 w-btn(36, 모바일 터치 44) · w-btn.w-s(32)
const BTN =
  "inline-flex min-h-touch items-center justify-center gap-1.5 rounded-admin-control border border-border-strong bg-bg-surface px-3 text-[14px] font-medium whitespace-nowrap text-text-default shadow-card hover:bg-bg-page disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45 lg:h-admin-control lg:min-h-0";
const BTN_S =
  "inline-flex min-h-touch items-center justify-center gap-1.5 rounded-admin-control border border-border-strong bg-bg-surface px-2.5 text-[13px] font-medium whitespace-nowrap text-text-default shadow-card hover:bg-bg-page aria-disabled:cursor-not-allowed aria-disabled:opacity-45 lg:h-8 lg:min-h-0";

// 새 탭으로 여는 바깥 링크(AWS 콘솔·GitHub). 화면 안 이동이 아니라 <a>를 씀
function ExternalLink({
  href,
  children,
  className = "font-medium text-brand-default underline underline-offset-2",
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
      <span className="sr-only"> {t.newTab}</span>
    </a>
  );
}

// 표(시안 w-t). 머리 칸 바탕·모서리·칸 여백
const TABLE =
  "w-full border-separate border-spacing-0 rounded-admin-box border border-border-default bg-bg-surface text-[14px] shadow-card";
const TH =
  "border-b border-border-default bg-bg-page px-3 py-[7px] text-left text-[12.5px] font-semibold whitespace-nowrap text-text-body first:rounded-tl-admin-box first:pl-4 last:rounded-tr-admin-box last:pr-4";
const TD =
  "border-b border-border-default px-3 py-1.5 align-middle leading-[1.45] whitespace-nowrap text-text-body first:pl-4 last:pr-4 group-last/row:border-b-0";

const SECTION_TITLE =
  "text-[16px] leading-normal font-semibold text-text-default";

function rateText(rate: number | null): string {
  return rate === null ? t.never : `${rate}%`;
}

function sourceName(job: string): string {
  return job in t.source ? t.source[job as keyof typeof t.source] : job;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// ── 요약 칸(시안 V9 요약 4칸·V10 시트 3칸): 테두리 하나에 칸을 세로줄로 나눔 ──

interface Kpi {
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly hint?: string;
  readonly tone?: "stale";
}

const KPI_COLS: Record<number, string> = {
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-2 xl:grid-cols-4",
};

function KpiBox({ items }: { items: readonly Kpi[] }) {
  return (
    <dl
      className={`grid grid-cols-1 overflow-hidden rounded-admin-box border border-border-default bg-bg-surface shadow-card ${KPI_COLS[items.length] ?? ""}`}
    >
      {items.map((kpi) => (
        <div
          key={kpi.label}
          className="-mt-px -ml-px border-t border-l border-border-default px-4 py-3.5"
        >
          <dt className="text-[13px] font-semibold text-text-body">
            {kpi.label}
          </dt>
          <dd className="mt-1 flex items-baseline gap-1.5">
            <span
              className={`text-[20px] leading-normal tabular-nums ${kpi.tone === "stale" ? "text-status-stale-fg" : "text-text-default"}`}
            >
              {kpi.value}
            </span>
            {kpi.unit && (
              <span className="text-[12.5px] text-text-muted">{kpi.unit}</span>
            )}
          </dd>
          {kpi.hint && (
            <dd className="mt-0.5 text-[12px] text-text-muted">{kpi.hint}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}

// ── 24시간 막대(시안 w-trk): 마우스를 올리면 그 칸의 시각·결과를 말풍선으로 ──

const BAR: Record<BarState, string> = {
  ok: "bg-success-icon",
  late: "bg-status-stale-border",
  failed: "bg-status-blocked-fg",
  none: "bg-border-default",
};

function barTip(bucket: HourBucket): { time: string; detail: string } {
  const from = kstHour(bucket.hour);
  const time = fill(t.barTipTime, {
    from: pad2(from),
    to: pad2((from + 1) % 24),
  });
  const state = t.bar[barState(bucket)];
  const runs =
    bucket.runs === 0
      ? t.barTipNoRuns
      : fill(t.barTipRuns, { runs: bucket.runs, ok: bucket.ok });
  return { time, detail: `${state} · ${runs}` };
}

function Tooltip({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute z-10 rounded-admin-control border border-border-default bg-bg-surface px-2.5 py-2 text-left text-[12px] leading-normal font-normal whitespace-nowrap text-text-default shadow-floating ${className}`}
    >
      {children}
    </span>
  );
}

function DayBars({
  job,
  wide = false,
}: {
  job: JobCollection | undefined;
  wide?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
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
  const active = hover === null ? undefined : hourly[hover];
  const tip = active ? barTip(active) : null;
  // 끝 칸 말풍선은 막대 밖으로 나가지 않게 한쪽에 붙임
  const edge =
    hover === null
      ? null
      : hover < 4
        ? "start"
        : hover > hourly.length - 5
          ? "end"
          : "middle";
  const align =
    edge === "start"
      ? "left-0"
      : edge === "end"
        ? "right-0"
        : "left-1/2 -translate-x-1/2";
  return (
    <span
      role="img"
      aria-label={label}
      onMouseLeave={() => setHover(null)}
      className={`relative flex gap-0.5 ${wide ? "w-full" : "w-60"}`}
    >
      {hourly.map((bucket, i) => (
        <span
          key={bucket.hour}
          aria-hidden="true"
          onMouseEnter={() => setHover(i)}
          className={`relative block h-4 flex-1 rounded-[2px] ${BAR[barState(bucket)]} ${hover === i ? "outline-2 outline-offset-1 outline-text-default" : ""}`}
        >
          {hover === i && tip && (
            <Tooltip className={`bottom-full mb-2 ${align}`}>
              <b className="font-semibold">{tip.time}</b> · {tip.detail}
            </Tooltip>
          )}
        </span>
      ))}
    </span>
  );
}

function BarLegend() {
  const states: readonly BarState[] = ["ok", "late", "failed", "none"];
  return (
    <ul
      aria-label={t.legendTitle}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-muted"
    >
      {states.map((state) => (
        <li key={state} className="inline-flex items-center gap-[5px]">
          <span
            aria-hidden="true"
            className={`inline-block size-[9px] rounded-[2px] ${BAR[state]}`}
          />
          {t.bar[state]}
        </li>
      ))}
    </ul>
  );
}

// 상태가 어느 실행 기준인지 함께 보여 줌(오래전 실행의 '정상'을 지금 정상으로 읽지 않게)
function LastRun({
  job,
  nowIso,
}: {
  job: JobCollection | undefined;
  nowIso: string;
}) {
  if (!job?.lastRun) return null;
  return (
    <span className="block text-[12px] whitespace-nowrap text-text-muted tabular-nums">
      {fill(t.lastRun, { time: kstClock(job.lastRun.startedAt, nowIso) })}
    </span>
  );
}

function Cycle({
  row,
  job,
}: {
  row: SourceRow;
  job: JobCollection | undefined;
}) {
  return (
    <span className="flex flex-col">
      <span>{t.cycle[row.job]}</span>
      <span className="text-[12px] text-text-muted">
        {cycleDelayText(job?.lateAfterMinutes)}
      </span>
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
  const items: Kpi[] = [
    {
      label: t.kpiSources,
      value: unchecked > 0 ? t.kpiUnknown : `${okCount}/${SOURCE_ROWS.length}`,
      hint:
        unchecked > 0
          ? fill(t.kpiSourcesUnchecked, { count: unchecked })
          : fill(t.kpiSourcesHint, { judgment }),
    },
    rate === null
      ? { label: t.kpiWeek, value: t.kpiWeekNone }
      : {
          label: t.kpiWeek,
          value: String(rate),
          unit: "%",
          hint: fill(t.kpiWeekHint, { failed: week.runs - week.ok }),
        },
    publish
      ? {
          label: t.kpiDelayed,
          value: String(publish.delayedBeaches),
          unit: t.unitPlaces,
          hint: fill(t.kpiDelayedHint, { total: publish.beachCount }),
          ...(publish.delayedBeaches > 0 ? { tone: "stale" as const } : {}),
        }
      : {
          label: t.kpiDelayed,
          value: t.kpiUnknown,
          hint: t.kpiDelayedUnknownHint,
        },
    published
      ? {
          label: t.kpiPublish,
          value: kstClock(published, view.generatedAt),
          hint: publish
            ? fill(t.kpiPublishHint, { count: publish.beachCount })
            : t.kpiPublishHintNoSummary,
        }
      : { label: t.kpiPublish, value: t.kpiPublishNone },
  ];
  return <KpiBox items={items} />;
}

function SourceName({ row }: { row: SourceRow }) {
  return (
    <span className="flex flex-col">
      <span className="font-medium text-text-default">{t.source[row.job]}</span>
      <span className="text-[12px] text-text-muted">
        {row.judgment ? t.judgment : t.reference}
      </span>
    </span>
  );
}

function SourceTable({
  view,
  selected,
  onOpen,
}: {
  view: CollectionView;
  // 출처 시트가 열린 줄(시안 V10: 고른 줄 강조)
  selected: string | null;
  onOpen: (job: SourceRow["job"], from: HTMLElement) => void;
}) {
  const [filter, setFilter] = useState<SourceFilter>("all");
  const nowIso = view.generatedAt;
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
  const openButton = (row: SourceRow) => (
    <button
      type="button"
      // Safari(WebKit)는 마우스로 누른 버튼에 포커스를 주지 않아 document.activeElement로는 연 버튼을 못 찾음 → 누른 버튼을 직접 넘김
      onClick={(event) => onOpen(row.job, event.currentTarget)}
      aria-label={fill(t.openSource, { source: t.source[row.job] })}
      className="inline-flex size-touch items-center justify-center rounded-admin-control text-text-muted hover:bg-bg-page hover:text-text-default lg:size-7"
    >
      <ChevronIcon />
    </button>
  );
  return (
    <section aria-labelledby="collection-sources" className="mt-7">
      <h2 id="collection-sources" className={SECTION_TITLE}>
        {t.tableTitle}
      </h2>
      <div
        role="group"
        aria-label={t.filterLabel}
        className="mt-3 flex gap-6 overflow-x-auto border-b border-border-default"
      >
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className="-mb-px inline-flex min-h-touch shrink-0 items-center gap-1 border-b-2 border-transparent px-0.5 py-2 text-[14px] font-medium whitespace-nowrap text-text-muted hover:text-text-default aria-pressed:border-brand-default aria-pressed:text-brand-default lg:min-h-0"
          >
            {t.filter[f]}
            <span className="font-normal text-text-muted tabular-nums">
              {count(f)}
            </span>
          </button>
        ))}
      </div>
      <div className="mt-3.5 mb-0.5 flex justify-end">
        <BarLegend />
      </div>
      {rows.length === 0 && !showSeason && (
        <p className="rounded-admin-box border border-border-default bg-bg-surface px-4 py-3 text-[13px] text-text-muted">
          {t.filterEmpty}
        </p>
      )}
      {/* 태블릿·PC: 표 */}
      {(rows.length > 0 || showSeason) && (
        <table className={`hidden md:table ${TABLE}`}>
          <thead>
            <tr>
              <th scope="col" className={TH}>
                {t.colSource}
              </th>
              <th scope="col" className={TH}>
                {t.colState}
              </th>
              <th scope="col" className={TH}>
                {t.colDay}
              </th>
              <th scope="col" className={`${TH} text-right!`}>
                {t.colLastSuccess}
              </th>
              <th scope="col" className={`${TH} text-right!`}>
                {t.colCycle}
              </th>
              <th scope="col" className={`${TH} text-right!`}>
                {t.colWeek}
              </th>
              <th scope="col" className={TH}>
                <span className="sr-only">{t.colOpen}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const job = rowJob(view, row);
              const on = selected === row.job;
              const td = `${TD} ${on ? "bg-brand-weak" : ""}`;
              return (
                <tr key={row.job} className="group/row">
                  <th
                    scope="row"
                    className={`${td} text-left font-normal ${on ? "shadow-[inset_3px_0_0_var(--color-brand-default)]" : ""}`}
                  >
                    <SourceName row={row} />
                  </th>
                  <td className={td}>
                    <StateDot state={sourceState(job)} />
                    <LastRun job={job} nowIso={nowIso} />
                    {job?.truncated && (
                      <span className="block text-[12px] text-text-muted">
                        {t.truncated}
                      </span>
                    )}
                  </td>
                  <td className={td}>
                    <DayBars job={job} />
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {job?.lastSuccessAt
                      ? kstClock(job.lastSuccessAt, nowIso, true)
                      : t.never}
                  </td>
                  <td
                    className={`${td} min-w-28 text-right whitespace-normal!`}
                  >
                    <Cycle row={row} job={job} />
                  </td>
                  <td className={`${td} text-right tabular-nums`}>
                    {rateText(job ? successRate(job.week) : null)}
                  </td>
                  <td className={`${td} w-px`}>{openButton(row)}</td>
                </tr>
              );
            })}
            {showSeason && (
              <tr className="group/row">
                <th scope="row" className={`${TD} text-left font-normal`}>
                  <span className="flex flex-col">
                    <span className="font-medium text-text-default">
                      {t.season}
                    </span>
                    <span className="text-[12px] text-text-muted">
                      {t.reference}
                    </span>
                  </span>
                </th>
                <td className={TD}>
                  <span className="inline-flex items-center gap-2">
                    <Dot className={DOT.none} />
                    {t.seasonState}
                  </span>
                </td>
                <td colSpan={5} className={`${TD} text-[13px]`}>
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
        <ul className="flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface shadow-card md:hidden">
          {rows.map((row) => {
            const job = rowJob(view, row);
            return (
              <li key={row.job} className="flex flex-col gap-2 px-4 py-3">
                <span className="flex items-start justify-between gap-3">
                  <SourceName row={row} />
                  <span className="flex items-center gap-1">
                    <StateBadge state={sourceState(job)} />
                    {openButton(row)}
                  </span>
                </span>
                <LastRun job={job} nowIso={nowIso} />
                <DayBars job={job} wide />
                <dl className="grid grid-cols-3 gap-2 text-[13px]">
                  <div>
                    <dt className="text-[12px] text-text-muted">
                      {t.colLastSuccess}
                    </dt>
                    <dd className="text-text-default tabular-nums">
                      {job?.lastSuccessAt
                        ? kstClock(job.lastSuccessAt, nowIso, true)
                        : t.never}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[12px] text-text-muted">
                      {t.colCycle}
                    </dt>
                    <dd className="text-text-default">
                      <Cycle row={row} job={job} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[12px] text-text-muted">{t.colWeek}</dt>
                    <dd className="text-text-default tabular-nums">
                      {rateText(job ? successRate(job.week) : null)}
                    </dd>
                  </div>
                </dl>
                {job?.truncated && (
                  <p className="text-[12px] text-text-muted">{t.truncated}</p>
                )}
              </li>
            );
          })}
          {showSeason && (
            <li className="flex flex-col gap-1 px-4 py-3">
              <span className="flex items-start justify-between gap-3">
                <span className="font-medium text-text-default">
                  {t.season}
                </span>
                <Badge tone="neutral">{t.seasonState}</Badge>
              </span>
              <span className="text-[13px] text-text-body">
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

// ── 시간별 성공률 선 그래프(시안 V9): 0~100%, 실행이 없는 칸은 선을 끊음(0%로 그리지 않음) ──
// 말풍선은 마우스를 올리거나 키보드(←→)로 고른 칸에서만. 가장 낮은 칸은 점으로만 두고 글로 요약
// 화면 읽기 프로그램에는 칸별 값 목록을 따로 둠
const CHART_W = 410;
const CHART_H = 130;

function Hourly({ view }: { view: CollectionView }) {
  const gradient = useId();
  const [active, setActive] = useState<number | null>(null);
  const hourly = overallHourly(view.jobs);
  const n = hourly.length;
  const lowest = lowestHour(hourly);
  const lowIndex = lowest ? hourly.indexOf(lowest) : -1;
  const any = hourly.some((b) => b.runs > 0);
  const summary = !any
    ? t.hourlyEmpty
    : lowest
      ? fill(t.hourlyLowest, {
          hour: kstHour(lowest.hour),
          rate: successRate(lowest) ?? 0,
        })
      : t.hourlyFine;
  const xOf = (i: number) => (n > 1 ? (i / (n - 1)) * CHART_W : 0);
  const yOf = (b: HourCounts) => (1 - b.ok / b.runs) * CHART_H;
  // 실행이 있는 칸끼리 이어진 조각
  const segments: number[][] = [];
  let current: number[] = [];
  hourly.forEach((bucket, i) => {
    if (bucket.runs === 0) {
      if (current.length) segments.push(current);
      current = [];
      return;
    }
    current.push(i);
  });
  if (current.length) segments.push(current);
  const pts = (idx: number[]) =>
    idx
      .map((i) => `${xOf(i).toFixed(1)},${yOf(hourly[i]!).toFixed(1)}`)
      .join(" ");
  const pct = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 0);
  const lastIndex = hourly.findLastIndex((b) => b.runs > 0);
  const dot = (i: number) => (
    <circle
      key={`dot-${i}`}
      cx={xOf(i)}
      cy={yOf(hourly[i]!)}
      r="3"
      className="fill-bg-surface stroke-chart"
      strokeWidth="2"
      vectorEffect="non-scaling-stroke"
    />
  );
  const activeBucket = active === null ? undefined : hourly[active];
  const tipText = activeBucket
    ? activeBucket.runs === 0
      ? fill(t.hourlyTipEmpty, { hour: pad2(kstHour(activeBucket.hour)) })
      : `${fill(t.hourlyTip, {
          hour: pad2(kstHour(activeBucket.hour)),
          rate: successRate(activeBucket) ?? 0,
        })} · ${fill(t.barTipRuns, { runs: activeBucket.runs, ok: activeBucket.ok })}`
    : "";
  const pick = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    setActive(Math.round(ratio * (n - 1)));
  };
  const onKey = (e: React.KeyboardEvent) => {
    // 고른 칸이 없으면 첫 ←→는 시작 칸(가장 낮은 칸, 없으면 지금)을 고름(그 칸을 건너뛰지 않게)
    const at = active ?? (lowIndex >= 0 ? lowIndex : n - 1);
    const step = active === null ? 0 : 1;
    const next =
      e.key === "ArrowLeft"
        ? at - step
        : e.key === "ArrowRight"
          ? at + step
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? n - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    setActive(Math.min(n - 1, Math.max(0, next)));
  };
  const tickLabel = (bucket: HourCounts, i: number) => {
    const hour = pad2(kstHour(bucket.hour));
    // 첫 칸이 기준 시각과 다른 날(어제)이면 '어제'를 붙임(시안 V9 '어제 15시 · 21시 · …')
    const other = i === 0 && !sameKstDay(bucket.hour, view.generatedAt);
    return other
      ? fill(t.axisYesterday, { hour })
      : fill(t.hourlyAxis, { hour });
  };
  const flip = active !== null && pct(active) > 60;

  return (
    <section aria-labelledby="collection-hourly">
      <h2 id="collection-hourly" className={SECTION_TITLE}>
        {t.hourlyTitle}
      </h2>
      <p className="text-[12px] text-text-muted">{t.hourlyAll}</p>
      {any && n > 0 && (
        <div className="relative mt-3 mr-1.5 ml-9">
          <div
            tabIndex={0}
            role="group"
            aria-label={t.hourlyChart}
            aria-describedby="hourly-keys"
            onKeyDown={onKey}
            onBlur={() => setActive(null)}
            onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
            onPointerLeave={() => setActive(null)}
            className="relative rounded-[2px] outline-offset-4"
          >
            <svg
              width="100%"
              height={CHART_H}
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              preserveAspectRatio="none"
              aria-hidden="true"
              className="block overflow-visible"
            >
              <defs>
                <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0"
                    stopColor="var(--color-chart)"
                    stopOpacity="0.22"
                  />
                  <stop
                    offset="1"
                    stopColor="var(--color-chart)"
                    stopOpacity="0"
                  />
                </linearGradient>
              </defs>
              {[0, 0.25, 0.5, 0.75].map((r) => (
                <line
                  key={r}
                  x1={0}
                  x2={CHART_W}
                  y1={r * CHART_H}
                  y2={r * CHART_H}
                  className="stroke-border-subtle"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              <line
                x1={0}
                x2={CHART_W}
                y1={CHART_H}
                y2={CHART_H}
                className="stroke-border-default"
                vectorEffect="non-scaling-stroke"
              />
              {segments.map((idx) => (
                <polygon
                  key={`area-${idx[0]}`}
                  points={`${xOf(idx[0]!).toFixed(1)},${CHART_H} ${pts(idx)} ${xOf(idx.at(-1)!).toFixed(1)},${CHART_H}`}
                  fill={`url(#${gradient})`}
                />
              ))}
              {segments.map((idx) => (
                <polyline
                  key={`line-${idx[0]}`}
                  // 점 하나뿐인 조각은 같은 점을 두 번 넣어 둥근 끝으로 점을 그림
                  points={
                    idx.length === 1 ? `${pts(idx)} ${pts(idx)}` : pts(idx)
                  }
                  fill="none"
                  className="stroke-chart"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {active !== null && (
                <line
                  x1={xOf(active)}
                  x2={xOf(active)}
                  y1={0}
                  y2={CHART_H}
                  className="stroke-border-note"
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {lastIndex >= 0 && dot(lastIndex)}
              {lowIndex >= 0 && lowIndex !== lastIndex && dot(lowIndex)}
              {activeBucket &&
                activeBucket.runs > 0 &&
                active !== lastIndex &&
                active !== lowIndex &&
                dot(active!)}
            </svg>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-full mr-2 flex flex-col justify-between text-[11px] whitespace-nowrap text-text-muted tabular-nums"
            >
              {[100, 75, 50, 25, 0].map((rate) => (
                <span key={rate}>{fill(t.axisPercent, { rate })}</span>
              ))}
            </div>
            {activeBucket && (
              <Tooltip className={`-top-1.5 ${flip ? "right-2" : "left-2"}`}>
                {tipText}
              </Tooltip>
            )}
          </div>
          <div
            aria-hidden="true"
            className="relative mt-2 flex h-4 text-[12px] text-text-muted tabular-nums"
          >
            {hourly.slice(0, -1).map((bucket, i) => (
              <span key={bucket.hour} className="relative flex-1">
                {i % 6 === 0 && (
                  <span
                    className={`absolute left-0 whitespace-nowrap ${i ? "-translate-x-1/2" : ""}`}
                  >
                    {tickLabel(bucket, i)}
                  </span>
                )}
              </span>
            ))}
            <span className="absolute right-0 whitespace-nowrap">
              {t.axisNow}
            </span>
          </div>
          {/* 키보드로 고른 칸의 값(말풍선과 같은 글)을 화면 읽기 프로그램에 알림 */}
          <p className="sr-only" aria-live="polite">
            {tipText}
          </p>
        </div>
      )}
      <p id="hourly-keys" className="sr-only">
        {t.hourlyKeys}
      </p>
      <ol className="sr-only" aria-label={t.hourlyChart}>
        {hourly.map((bucket) => (
          <li key={bucket.hour}>{hourLabel(bucket)}</li>
        ))}
      </ol>
      <p className="mt-3 text-[12px] text-text-muted">{summary}</p>
    </section>
  );
}

function incidentHeadline(incident: JobIncident): string {
  if (incident.kind === "stations") {
    return `${sourceName(incident.job)} · ${fill(t.incidentStations, {
      count: incident.stations.length,
    })}`;
  }
  const more = incident.failures.length - 1;
  return [
    sourceName(incident.job),
    ` · ${incidentErrorTitle(incident.failures[0])}`,
    more > 0 && ` ${fill(t.incidentMore, { count: more })}`,
  ]
    .filter(Boolean)
    .join("");
}

// 끝난 장애는 '종료' 모양. 성공색은 수집 정상에만(결정 E6), '특보 없음' 파랑과도 섞지 않음
function OngoingBadge({ ended }: { ended: boolean }) {
  return (
    <Badge tone={ended ? "ended" : "error"}>
      {ended ? t.incidentResolved : t.incidentOngoing}
    </Badge>
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

// 장애 한 줄(시안 w-li): 제목 · 시각·걸린 시간 · 상태 배지 · 화살표.
function IncidentRow({
  incident,
  nowMs,
  onOpen,
}: {
  incident: JobIncident;
  nowMs: number;
  onOpen: (from: HTMLElement) => void;
}) {
  const impact = impactSummary(incident);
  return (
    <button
      type="button"
      // Safari(WebKit)는 마우스로 누른 버튼에 포커스를 주지 않음 → 시트를 닫을 때 돌아올 버튼을 직접 넘김
      onClick={(event) => onOpen(event.currentTarget)}
      className="flex w-full items-center gap-3 border-b border-border-default py-2.5 pr-2 text-left hover:bg-bg-page"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[14px] font-medium text-text-default">
          {incidentHeadline(incident)}
        </span>
        <span className="text-[12px] text-text-muted tabular-nums">
          {t.incidentKind[incident.kind]} ·{" "}
          {fill(t.incidentMeta, {
            time: kstDateTime(incident.startedAt),
            minutes: incidentMinutes(incident, nowMs),
            runs: incident.runs,
          })}
          {impact && ` · ${impact}`}
        </span>
      </span>
      <OngoingBadge ended={incident.endedAt !== null} />
      <span className="text-border-note">
        <ChevronIcon size={16} />
      </span>
    </button>
  );
}

const PAGE_SIZE = 5;

function Pager({
  label,
  text,
  atStart,
  atEnd,
  onPrev,
  onNext,
}: {
  label: string;
  text: string;
  atStart: boolean;
  atEnd: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <nav
      aria-label={label}
      className="mt-3 flex items-center gap-2 text-[12.5px] text-text-muted"
    >
      <span className="tabular-nums">{text}</span>
      <span className="flex-1" />
      {/* 끝 쪽에서 disabled로 바꾸면 누른 버튼의 포커스가 사라져 aria-disabled로 둠 */}
      <span className="flex gap-2">
        <button
          type="button"
          aria-disabled={atStart}
          onClick={() => !atStart && onPrev()}
          className={BTN_S}
        >
          {t.prev}
        </button>
        <button
          type="button"
          aria-disabled={atEnd}
          onClick={() => !atEnd && onNext()}
          className={BTN_S}
        >
          {t.next}
        </button>
      </span>
    </nav>
  );
}

function Incidents({
  incidents,
  nowMs,
  onOpen,
}: {
  incidents: readonly JobIncident[];
  nowMs: number;
  onOpen: (index: number, from: HTMLElement) => void;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(incidents.length / PAGE_SIZE));
  // 다시 불러와 장애가 줄면 마지막 쪽으로
  const current = Math.min(page, pages - 1);
  const from = current * PAGE_SIZE;
  const shown = incidents.slice(from, from + PAGE_SIZE);
  return (
    <section aria-labelledby="collection-incidents">
      <h2
        id="collection-incidents"
        tabIndex={-1}
        className={`flex items-baseline gap-2 outline-none ${SECTION_TITLE}`}
      >
        {t.incidentsTitle}
        <span className="text-[13px] font-normal text-text-muted tabular-nums">
          {incidents.length}
        </span>
      </h2>
      {incidents.length === 0 ? (
        <p className="mt-3 text-[13px] text-text-muted">{t.incidentsEmpty}</p>
      ) : (
        <>
          <ul className="mt-3 flex flex-col border-t border-border-default">
            {shown.map((incident, i) => (
              <li key={incidentKey(incident)}>
                <IncidentRow
                  incident={incident}
                  nowMs={nowMs}
                  onOpen={(button) => onOpen(from + i, button)}
                />
              </li>
            ))}
          </ul>
          <Pager
            label={t.pagerLabel}
            text={fill(t.pager, {
              total: incidents.length,
              from: from + 1,
              to: from + shown.length,
              size: PAGE_SIZE,
            })}
            atStart={current === 0}
            atEnd={current >= pages - 1}
            onPrev={() => setPage(current - 1)}
            onNext={() => setPage(current + 1)}
          />
        </>
      )}
    </section>
  );
}

function alarmTitle(alarm: Pick<AlarmView, "id" | "classification">): string {
  const { kind, source } = alarmInfo(alarm);
  if (kind === "other" && source === null) {
    return Object.hasOwn(t.alarmOther, alarm.id)
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
    <section aria-labelledby="collection-alerts" className="mt-8">
      <h2 id="collection-alerts" className={SECTION_TITLE}>
        {t.alertsTitle}
      </h2>
      <p className="text-[12px] text-text-muted">{t.alertsHint}</p>
      {alarms.status !== "ok" ? (
        <div className="mt-3">
          <Notice tone="warn" title={t.alertsUnavailable}>
            <p>{t.alertsUnavailableHint}</p>
          </Notice>
        </div>
      ) : alarms.list.length === 0 ? (
        <p className="mt-3 text-[13px] text-text-muted">{t.alertsEmpty}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          {groupedAlarms(alarms.list).map((group) => {
            const ringing = group.alarms.filter(
              ({ state }) => state === "ALARM",
            ).length;
            const unknown = group.alarms.filter(
              ({ state }) => state !== "ALARM" && state !== "OK",
            ).length;
            return (
              <details
                key={group.kind}
                open={ringing > 0}
                className="group rounded-admin-box border border-border-default bg-bg-surface px-3"
              >
                <summary className="flex min-h-touch cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 py-2 text-body-s font-medium text-text-default [&::-webkit-details-marker]:hidden">
                  <span className="text-text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none">
                    <ChevronIcon />
                  </span>
                  {t.alertGroup[group.kind]}
                  <span className="font-normal text-text-muted tabular-nums">
                    {fill(t.alarmGroupCount, { count: group.alarms.length })}
                  </span>
                  {ringing > 0 && (
                    <Badge tone="error">
                      {fill(t.alarmGroupRinging, { count: ringing })}
                    </Badge>
                  )}
                  {unknown > 0 && (
                    <Badge tone="unknown">
                      {fill(t.alarmGroupUnknown, { count: unknown })}
                    </Badge>
                  )}
                </summary>
                <ul className="flex flex-col border-t border-border-default">
                  {group.alarms.map((alarm) => (
                    <li
                      key={alarm.id}
                      className="flex items-center gap-3 border-b border-border-default py-2.5"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-[14px] font-medium text-text-default">
                          {alarmTitle(alarm)}
                        </span>
                        <span className="text-[12px] text-text-muted tabular-nums">
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
                      <Badge tone={ALARM_TONE[alarm.state]}>
                        {t.alarmState[alarm.state]}
                      </Badge>
                      <ExternalLink
                        href={cloudWatchUrl(alarms.region, alarm.name)}
                        className="inline-flex min-h-touch items-center gap-0.5 text-[12px] font-medium text-brand-default underline underline-offset-2 lg:min-h-0"
                      >
                        {t.alarmLink}
                      </ExternalLink>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
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

// 오른쪽 시트 틀(모달 <dialog>, 문의 상세 패널과 같은 방식). 모바일은 화면 너비 전체
// 포커스는 시트 안에 갇히고 Esc·바깥(딤) 누르기·닫기 버튼으로 닫음
function Drawer({
  nonce,
  labelledBy,
  describedBy,
  className,
  onClosed,
  children,
}: {
  // 열 때마다 바뀌는 값. 닫히는 동작(0.2초) 중에 다시 열어도 showModal을 다시 부르게 함
  nonce: number;
  labelledBy: string;
  describedBy: string;
  className: string;
  onClosed: (nonce: number) => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, [nonce]);
  const close = () => ref.current?.close();
  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
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
      className={`fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none max-w-full overflow-y-auto border-l border-border-default bg-bg-surface text-text-default shadow-floating transition-[translate,overlay,display] transition-discrete duration-200 ease-out not-open:translate-x-full backdrop:transition-[opacity,overlay,display] backdrop:transition-discrete backdrop:duration-200 not-open:backdrop:opacity-0 starting:open:translate-x-full starting:open:backdrop:opacity-0 motion-reduce:transition-none motion-reduce:backdrop:transition-none ${className}`}
    >
      {children}
    </dialog>
  );
}

// 시트 안 닫기 버튼: 가장 가까운 <dialog>를 닫음(닫힘 처리는 Drawer의 onClose가 맡음)
function closeDialog(e: React.MouseEvent<HTMLElement>) {
  e.currentTarget.closest("dialog")?.close();
}

function CloseIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

// 장애 상세 시트. ↑↓(또는 이전·다음 버튼)로 장애를 옮김
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
  nonce: number;
  view: CollectionView;
  beaches: Beaches;
  onMove: (index: number) => void;
  onClosed: (nonce: number) => void;
}) {
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
    <Drawer
      nonce={nonce}
      labelledBy="incident-sheet-title"
      describedBy="incident-sheet-keys"
      onClosed={onClosed}
      className="w-[480px] px-6 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] backdrop:bg-[rgb(11_26_44/0.4)]"
    >
      {
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
              onClick={closeDialog}
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
      }
    </Drawer>
  );
}

// ── 출처 시트(시안 V10): 요약 3칸 · 최근 24시간 · (해양 관측) 관측소 · 장애 기록 ──

const STATION_DOT: Record<StationRow["state"], string> = {
  missing: "bg-status-stale-border",
  unknown: "border border-dashed border-status-unknown-border",
  ok: "bg-success-icon",
};

const STATIONS_PAGE = 6;

type StationFilter = "problem" | "all";

function Stations({
  view,
  beaches,
}: {
  view: CollectionView;
  beaches: Beaches;
}) {
  const [filter, setFilter] = useState<StationFilter>("all");
  const [page, setPage] = useState(0);
  const { stations } = view;
  const heading = (
    <h3 className="flex-1 text-[15px] font-semibold text-text-default">
      {t.stationsHeading}
    </h3>
  );
  if (stations.status !== "ok") {
    return (
      <section aria-label={t.stationsHeading} className="flex flex-col gap-2">
        {heading}
        <Notice tone="warn" title={t.stationsUnavailable}>
          <p>{t.stationsUnavailableHint}</p>
        </Notice>
      </section>
    );
  }
  const problems = stations.list.filter((s) => s.state !== "ok");
  const list = filter === "problem" ? problems : stations.list;
  const pages = Math.max(1, Math.ceil(list.length / STATIONS_PAGE));
  const current = Math.min(page, pages - 1);
  const from = current * STATIONS_PAGE;
  const shown = list.slice(from, from + STATIONS_PAGE);
  const nowIso = view.generatedAt;
  const beachText = (s: StationRow) => {
    const names = s.beachIds.map((id) => beaches[id]?.name ?? id);
    if (names.length === 0) return null;
    return names.length === 1
      ? names[0]!
      : fill(t.stationBeachMore, { name: names[0]!, count: names.length - 1 });
  };
  return (
    <section aria-label={t.stationsHeading}>
      <div className="flex items-center gap-3">
        {heading}
        <div
          role="group"
          aria-label={t.stationsFilterLabel}
          className="inline-flex overflow-hidden rounded-admin-control border border-border-strong shadow-card"
        >
          {(["problem", "all"] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
                setPage(0);
              }}
              className="inline-flex min-h-touch items-center border-l border-border-strong bg-bg-surface px-3 text-[13.5px] font-medium whitespace-nowrap text-text-body first:border-l-0 aria-pressed:bg-bg-page aria-pressed:font-semibold aria-pressed:text-text-default lg:h-[34px] lg:min-h-0"
            >
              {fill(t.stationsFilter[f], {
                count: f === "problem" ? problems.length : stations.list.length,
              })}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-[12px] text-text-muted">
        {stations.checkedAt
          ? fill(t.stationsChecked, {
              time: kstClock(stations.checkedAt, nowIso),
            })
          : t.stationsUnchecked}
      </p>
      {shown.length === 0 ? (
        <p className="mt-2 text-[13px] text-text-muted">
          {t.stationsEmptyProblem}
        </p>
      ) : (
        <table className={`mt-2 ${TABLE}`}>
          <thead>
            <tr>
              <th scope="col" className={TH}>
                {t.colStation}
              </th>
              <th scope="col" className={TH}>
                {t.colState}
              </th>
              <th scope="col" className={`${TH} text-right!`}>
                {t.colMissingSince}
              </th>
              <th scope="col" className={`${TH} text-right!`}>
                {t.colBeaches}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => {
              const sub = !s.inTable
                ? t.stationNotInTable
                : s.state === "missing"
                  ? beachText(s)
                  : null;
              return (
                <tr key={s.id} className="group/row">
                  <th scope="row" className={`${TD} text-left font-normal`}>
                    <span className="flex flex-col">
                      <span className="font-medium text-text-default">
                        {s.name}
                      </span>
                      {sub && (
                        <span className="text-[12px] text-text-muted">
                          {sub}
                        </span>
                      )}
                    </span>
                  </th>
                  <td className={TD}>
                    <span className="inline-flex items-center gap-2">
                      <Dot className={STATION_DOT[s.state]} />
                      {t.stationState[s.state]}
                    </span>
                  </td>
                  <td className={`${TD} text-right tabular-nums`}>
                    {s.missingSince
                      ? kstClock(s.missingSince, nowIso)
                      : t.never}
                  </td>
                  <td className={`${TD} text-right tabular-nums`}>
                    {s.inTable
                      ? fill(t.stationBeachCount, { count: s.beachIds.length })
                      : t.kpiUnknown}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {list.length > 0 && (
        <Pager
          label={t.stationsPagerLabel}
          text={fill(t.stationsPager, {
            total: list.length,
            from: from + 1,
            to: from + shown.length,
          })}
          atStart={current === 0}
          atEnd={current >= pages - 1}
          onPrev={() => setPage(current - 1)}
          onNext={() => setPage(current + 1)}
        />
      )}
    </section>
  );
}

function SourceSheet({
  row,
  nonce,
  view,
  beaches,
  incidents,
  onClosed,
  onOpenIncident,
}: {
  row: SourceRow;
  nonce: number;
  view: CollectionView;
  beaches: Beaches;
  incidents: readonly JobIncident[];
  onClosed: (nonce: number) => void;
  onOpenIncident: (index: number) => void;
}) {
  const job = rowJob(view, row);
  const state = sourceState(job);
  const nowIso = view.generatedAt;
  const nowMs = Date.parse(nowIso);
  const rate = job ? successRate(job.week) : null;
  const mine = incidents
    .map((incident, index) => ({ incident, index }))
    .filter(({ incident }) => incident.job === row.job);
  const ongoing = mine.filter(({ incident }) => incident.endedAt === null);
  const ocean = row.job === "collect-ocean";
  const stationCount =
    view.stations.status === "ok" ? view.stations.list.length : null;
  const stationProblems =
    view.stations.status === "ok"
      ? view.stations.list.filter((s) => s.state !== "ok").length
      : 0;
  const items: Kpi[] = [
    {
      label: t.colLastSuccess,
      value: job?.lastSuccessAt ? kstClock(job.lastSuccessAt, nowIso) : t.never,
      hint: job?.nextScheduledAt
        ? fill(t.nextCollection, {
            time: kstClock(job.nextScheduledAt, nowIso),
          })
        : fill(t.sheetCycle, { cycle: t.cycle[row.job] }),
    },
    rate === null
      ? { label: t.colWeek, value: t.never }
      : { label: t.colWeek, value: String(rate), unit: "%" },
    ocean
      ? stationCount === null
        ? { label: t.stationsHeading, value: t.kpiUnknown }
        : {
            label: t.stationsHeading,
            value: String(stationCount),
            unit: t.unitPlaces,
            hint: fill(t.stationsKpiHint, { count: stationProblems }),
          }
      : {
          label: t.incidentsTitle,
          value: String(mine.length),
          unit: t.unitCases,
          hint: fill(t.sheetOngoing, { count: ongoing.length }),
        },
  ];
  return (
    <Drawer
      nonce={nonce}
      labelledBy="source-sheet-title"
      describedBy="source-sheet-keys"
      onClosed={onClosed}
      className="w-[560px] backdrop:bg-[rgb(11_26_44/0.2)]"
    >
      {
        <div className="flex min-h-full flex-col">
          <div className="flex items-start gap-3 border-b border-border-default px-6 pt-5 pb-4">
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-text-muted">
                {fill(t.sheetEyebrow, {
                  kind: row.judgment ? t.judgment : t.reference,
                })}
              </p>
              <h2
                id="source-sheet-title"
                className="mt-0.5 text-[18px] leading-snug font-semibold text-text-default"
              >
                {t.source[row.job]}
              </h2>
            </div>
            <StateBadge state={state} />
            <button
              type="button"
              onClick={closeDialog}
              aria-label={t.close}
              className="-mt-2 -mr-2 inline-flex size-touch items-center justify-center rounded-admin-control text-text-body hover:bg-bg-page lg:size-10"
            >
              <CloseIcon />
            </button>
          </div>
          <div className="flex flex-1 flex-col gap-6 px-6 py-5">
            <KpiBox items={items} />
            <div>
              <p className="mb-2 text-[13px] font-semibold text-text-body">
                {t.colDay}
              </p>
              <DayBars job={job} wide />
            </div>
            {ocean && <Stations view={view} beaches={beaches} />}
            <section aria-labelledby="source-sheet-incidents">
              <h3
                id="source-sheet-incidents"
                className="flex items-baseline gap-2 text-[15px] font-semibold text-text-default"
              >
                {t.incidentsTitle}
                <span className="text-[13px] font-normal text-text-muted tabular-nums">
                  {mine.length}
                </span>
              </h3>
              {mine.length === 0 ? (
                <p className="mt-2 text-[13px] text-text-muted">
                  {t.incidentsEmptySource}
                </p>
              ) : (
                <ul className="mt-2 flex flex-col border-t border-border-default">
                  {mine.map(({ incident, index }) => (
                    <li key={incidentKey(incident)}>
                      <IncidentRow
                        incident={incident}
                        nowMs={nowMs}
                        onOpen={() => onOpenIncident(index)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <div className="sticky bottom-0 flex items-center gap-2 border-t border-border-default bg-bg-surface px-6 pt-3.5 pb-[max(0.875rem,env(safe-area-inset-bottom))]">
            <span
              id="source-sheet-keys"
              className="text-[12px] text-text-muted"
            >
              {t.sheetEsc}
            </span>
            <span className="flex-1" />
            <ExternalLink
              href={cloudWatchUrl(alarmRegion(view))}
              className={BTN_S}
            >
              <OutIcon size={13} />
              {t.cloudWatchShort}
            </ExternalLink>
          </div>
        </div>
      }
    </Drawer>
  );
}

function LoadingPlaceholder() {
  return (
    <div role="status" className="mt-6 flex flex-col gap-3">
      <span className="text-[13px] text-text-muted">{t.loading}</span>
      <span
        aria-hidden="true"
        className="h-[96px] rounded-admin-box border border-border-default bg-bg-page"
      />
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
  // 출처 시트(V10). 출처 줄의 수집기 이름으로 듦
  const [source, setSource] = useState<{
    job: SourceRow["job"];
    nonce: number;
  } | null>(null);
  const nonce = useRef(0);
  // 비동기 결과·닫힘 타이머에서 지금 시트를 보려고 ref로도 둠
  const sheetRef = useRef(sheet);
  const sourceRef = useRef(source);
  useEffect(() => {
    sheetRef.current = sheet;
    sourceRef.current = source;
  });
  // 시트를 닫으면 포커스를 연 버튼으로 돌려줌
  const opener = useRef<HTMLElement | null>(null);
  const sourceOpener = useRef<HTMLElement | null>(null);
  // 연 버튼이 사라졌으면(그 장애가 목록에서 빠짐) 장애 기록 제목으로(포커스가 문서 맨 앞으로 떨어지지 않게)
  const restoreFocus = (target: HTMLElement | null) => {
    if (target && document.contains(target)) target.focus();
    else document.getElementById("collection-incidents")?.focus();
  };
  const focusPending = useRef(false);
  useEffect(() => {
    if (sheet === null && focusPending.current) {
      focusPending.current = false;
      restoreFocus(opener.current);
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
      // 불러오지 못하면 출처 시트도 닫음(앞 값으로 시트를 계속 보여 주지 않게)
      if (!result.ok && sourceRef.current) {
        sourceRef.current = null;
        setSource(null);
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
  // from: 시트를 연 버튼. document.activeElement로 찾지 않음(Safari는 마우스로 누른 버튼에 포커스를 주지 않음)
  // 없으면(null) 닫을 때 장애 기록 제목으로 돌아감
  const open = (index: number, from: HTMLElement | null) => {
    const target = incidents[index];
    if (!target) return;
    opener.current = from;
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
  const openSource = (job: SourceRow["job"], from: HTMLElement) => {
    sourceOpener.current = from;
    nonce.current += 1;
    setSource({ job, nonce: nonce.current });
  };
  // 출처 시트의 장애 줄 → 출처 시트를 닫고 장애 시트를 엶. 장애 시트를 닫으면 출처 줄 화살표로 돌아감
  const openFromSource = (index: number) => {
    sourceRef.current = null;
    setSource(null);
    open(index, sourceOpener.current);
  };
  const sourceRow = source
    ? SOURCE_ROWS.find((row) => row.job === source.job)
    : undefined;

  return (
    <div className="flex w-full flex-col px-4 py-5 md:px-10 md:pt-6 md:pb-10">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <h1 className="text-[20px] leading-[1.4] font-semibold tracking-[-0.01em] text-text-default">
            {t.title}
          </h1>
          {view && (
            <p className="mt-0.5 text-[12.5px] text-text-muted">
              {fill(t.asOf, { time: kstDateTime(view.generatedAt) })}
              {demo && ` · ${t.demoNote}`}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BTN}
            disabled={loaded !== null && loaded.key !== key}
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t.refresh}
          </button>
          <ExternalLink
            href={cloudWatchUrl(view ? alarmRegion(view) : null)}
            className={BTN}
          >
            <OutIcon />
            {t.cloudWatchShort}
          </ExternalLink>
        </div>
      </div>

      {result === null && <LoadingPlaceholder />}
      {result && !result.ok && (
        <div className="mt-6">
          {result.code === "reauth" ? (
            <Notice
              tone="warn"
              title={messages.inquiries.reauth}
              role="alert"
            />
          ) : (
            <Notice tone="fail" title={t.error} role="alert">
              <p>{t.errorHint}</p>
              {"requestId" in result && result.requestId && (
                <p>
                  {fill(messages.inquiries.requestId, {
                    id: result.requestId,
                  })}
                </p>
              )}
              <button
                type="button"
                className={`mt-2 ${BTN_S}`}
                onClick={() => setAttempt((n) => n + 1)}
              >
                {messages.inquiries.retry}
              </button>
            </Notice>
          )}
        </div>
      )}
      {view && (
        <>
          {view.legacy && (
            <div className="mt-4">
              <Notice tone="warn" title={t.oldResponse} role="status" />
            </div>
          )}
          <section aria-label={t.kpiTitle} className="mt-6">
            <Summary view={view} />
          </section>
          <SourceTable
            view={view}
            selected={source?.job ?? null}
            onOpen={openSource}
          />
          <div className="mt-7 grid grid-cols-1 gap-8 lg:grid-cols-[1.4fr_1fr]">
            <Hourly view={view} />
            <div className="min-w-0">
              <Incidents incidents={incidents} nowMs={nowMs} onOpen={open} />
              <Alerts view={view} />
            </div>
          </div>
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
                restoreFocus(opener.current);
              }}
            />
          )}
          {source !== null && sourceRow && (
            <SourceSheet
              key={source.nonce}
              row={sourceRow}
              nonce={source.nonce}
              view={view}
              beaches={beaches}
              incidents={incidents}
              onOpenIncident={openFromSource}
              onClosed={(closed) => {
                if (sourceRef.current?.nonce !== closed) return;
                sourceRef.current = null;
                setSource(null);
                restoreFocus(sourceOpener.current);
              }}
            />
          )}
        </>
      )}
      <p className="mt-8 text-[12px] text-text-muted">{t.note}</p>
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
