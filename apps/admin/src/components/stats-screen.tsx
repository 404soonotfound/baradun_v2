"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import type { BeachSlugName } from "@/lib/beach-names";
import { kstDateTime } from "@/lib/inquiries";
import { withTimeout } from "@/lib/loading-timing";
import { topicParticle } from "@/lib/korean";
import { fill, messages } from "@/lib/messages";
import {
  beachLabel,
  changePercent,
  channelName,
  fetchStats,
  metadataReasons,
  missingItems,
  perUser,
  roundAverage,
  screenLabel,
  SHAPE_ALL,
  sharePercent,
  STATS_RANGES,
  statsShape,
  sumMetric,
  trendMetadata,
  trendRangeText,
  trendUnavailable,
  type StatsRange,
  type StatsResponse,
} from "@/lib/stats";
import { AdminShell } from "./admin-shell";
import { BarChart, hasNull, shortDate, type ChartRow } from "./bar-chart";
import {
  loadClass,
  LoadingStatus,
  SkChart,
  SkDonut,
  SkLine,
  Spinner,
  useLoadTiming,
} from "./loading";
import { Button, Notice } from "./ui";

// 이용 통계 (BRD-154·GH-333, 화면 설계서 6장 ADM-STATS · 시안 4차 보드 V8 · 로딩 L7, GH-453)
// - GA Data API 집계만(운영 API /ops/stats). 해변 상태(특보 없음·이용불가·판단불가)와 묶은 지표는 만들지 않음
// - 머리: 제목 옆 '지금 사용 중 N명 · 최근 30분'(GA 실시간 30분), 기간 단추(오늘·7일·28일·60일)
// - 숫자 숨김 안내는 GA 응답 metadata(thresholding·sampling·otherRowLoss)가 있을 때만, 응답을 받은 뒤에만(E8 · L7)
//   숨긴 숫자는 추정하지 않고 '–'(0으로 바꾸지 않음)
// - 기간 추이(trends, GH-477): 일별·시간대별·앞 기간·새 사용자·많이 본 화면·들어온 경로
//   trends가 없거나 그 목록이 응답에 없으면 지어내지 않고 칸을 숨김 + 기간 표시 아래 한 줄 '… 아직 보여 드릴 수 없어요'
//   목록이 null이면 칸은 두고 '불러오지 못했어요'(GA4 속성 시간대가 다르면 그 사유). 행 안의 수치 null은 그 값만 '확인 못 함'
//   자리표시도 보이는 칸에만(첫 응답 전에는 지금 서버가 주는 칸 모두). 차트 자리는 로딩 중에도 같은 크기(L7)
// - 기간 표시는 trends의 KST 날짜(양 끝 포함). timeZoneMismatch면 옆에 '통계 기준 시간대가 달라요'(GA4 속성 시간대)
// - 앞 기간 비교 배지: 화면에서 비율 계산. previous가 null(오늘 범위 포함)이거나 앞 값이 0이면 배지 숨김
// - 많이 본 해변·화면의 /spots/[slug]는 공개 해변 데이터 이름으로. 못 찾으면 '이름 확인 못 함'(slug·경로를 이름으로 쓰지 않음)
//   다른 경로는 화면 이름표(/en/도 같은 이름), 모르는 경로는 경로 그대로 작은 글씨. 들어온 경로는 GA 기본 채널 이름을 우리말로
// - 로딩(GH-462 부품): 150ms 뒤 자리표시 · 최소 400ms · 5초 느림 · 15초 같은 자리 실패 + 다시 시도
//   새로 고침은 받은 값을 두고 회전 표시. 기간을 바꾸면 다른 기간 값이라 자리표시로 바꿈
// - 막대·도넛 길이는 SVG 속성으로(CSP style-src 'self', style 속성 0개)

const t = messages.stats;

// 보드 V8 공통 값(.w-lbl · .w-sh h2 · .w-c · .w-sb)
const LABEL = "text-label font-semibold text-text-body";
const SECTION_TITLE = "text-title-card font-semibold text-text-default";
const SECTION_NOTE = "text-body-s text-text-muted";
// 보드 22px → 가장 가까운 토큰 num-m(21px)
const KPI_VALUE = "text-num-m font-normal text-text-default tabular-nums";
const BADGE =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-admin-badge px-1.5 text-caption font-semibold whitespace-nowrap";

type Loaded = {
  readonly key: string;
  readonly result: OpsResult<StatsResponse>;
};

const TIMEOUT: OpsResult<never> = {
  ok: false,
  status: 0,
  code: "timeout",
  requestId: null,
};

const formatNumber = (n: number | null): string =>
  n === null ? t.emptyValue : n.toLocaleString("ko-KR");

// 시간대별 평균(소수 첫째 자리)
const formatAverage = (n: number): string =>
  n.toLocaleString("ko-KR", { maximumFractionDigits: 1 });

const deviceLabel = (category: string): string =>
  (t.deviceLabels as Record<string, string>)[category] ?? category;

const languageLabel = (code: string): string =>
  (t.languageLabels as Record<string, string>)[code] ?? code;

// 차트 칸 안 안내(리포트 실패·빈 결과). 차트와 같은 높이 상자
function ChartMessage({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <p
      className={`flex h-full items-center justify-center rounded-admin-box border border-dashed border-border-strong px-4 text-center text-body-s ${
        muted ? "text-text-muted" : "text-text-body"
      }`}
    >
      {text}
    </p>
  );
}

// 차트 칸 하나: 제목 + 같은 높이 틀(자리표시 · 실패 · 빈 결과 · 그래프)
function ChartBlock({
  id,
  title,
  top,
  frame,
  bars,
  placeholder,
  rows,
  head,
  valueHead,
  note,
  unavailable = t.subReportUnavailable,
  format,
}: {
  id: string;
  title: string;
  top: string;
  // 틀 전체 높이(막대 + 날짜 줄 24)
  frame: string;
  bars: string;
  placeholder: boolean;
  rows: readonly ChartRow[] | null;
  head: string;
  valueHead: string;
  // 제목 옆 옅은 설명(보드 '평균 · 28일')
  note?: string;
  // 목록을 못 받았을 때 문구(GA4 속성 시간대가 다르면 그 사유)
  unavailable?: string;
  format?: (n: number) => string;
}) {
  // 값이 없는 칸이 있으면 제목 줄 끝에 범례(같은 줄이라 높이 그대로)
  const legend = !placeholder && hasNull(rows);
  return (
    <section aria-labelledby={id} className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 id={id} className={SECTION_TITLE}>
          {title}
        </h2>
        {note && <span className={SECTION_NOTE}>{note}</span>}
        {legend && <span className={SECTION_NOTE}>· {t.nullLegend}</span>}
      </div>
      <div className={`${top} ${frame}`}>
        {placeholder ? (
          <SkChart className="h-full" />
        ) : rows === null ? (
          <ChartMessage text={unavailable} />
        ) : rows.length === 0 ? (
          <ChartMessage text={t.listEmpty} muted />
        ) : (
          <BarChart
            rows={rows}
            bars={bars}
            head={head}
            valueHead={valueHead}
            format={format}
          />
        )}
      </div>
    </section>
  );
}

// KPI 하나(보드 V8 머리 아래 4칸). 앞 기간 비교 배지는 응답에 앞 기간 값이 있을 때만. 작은 추이선은 그리지 않음
function Kpi({
  label,
  placeholder,
  width,
  value,
  unit,
  note,
  change = null,
}: {
  label: string;
  placeholder: boolean;
  width: string;
  value: string | null;
  unit?: string;
  note: string;
  // 앞 기간 대비 변화(%). 응답에 앞 기간 값이 없으면 null → 배지 없음. 좋고 나쁨 색은 쓰지 않음
  change?: number | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className={LABEL}>{label}</dt>
      <dd className="flex items-baseline gap-1">
        <span className={KPI_VALUE}>
          {placeholder ? (
            <SkLine className={width} />
          ) : value === null ? (
            <span className="text-title-s font-semibold">{t.notProvided}</span>
          ) : (
            value
          )}
        </span>
        {unit && !placeholder && value !== null && (
          <span className="text-label-s text-text-muted">{unit}</span>
        )}
        {!placeholder && change !== null && (
          <span
            className={`${BADGE} self-center bg-bg-page font-medium text-text-body ring-1 ring-border-default ring-inset`}
          >
            <span className="sr-only">{t.changeLabel} </span>
            {fill(t.changeValue, {
              sign: change > 0 ? "+" : "",
              percent: change,
            })}
          </span>
        )}
      </dd>
      <dd className="text-caption text-text-muted">{note}</dd>
    </div>
  );
}

// 가로 막대 목록(보드 V8 많이 본 해변·화면·들어온 경로: 행 높이 32 · 사이 6 · 첫 행 진한 면)
function BarList({
  rows,
}: {
  rows: readonly { key: string; name: ReactNode; value: number | null }[];
}) {
  const max = Math.max(0, ...rows.map((r) => r.value ?? 0));
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((row, i) => {
        const pct = row.value !== null && max > 0 ? (row.value / max) * 100 : 0;
        return (
          <li key={row.key} className="flex items-center gap-3">
            <div className="relative h-8 min-w-0 flex-1 overflow-hidden rounded-admin-badge">
              <svg aria-hidden="true" className="absolute inset-0 h-full w-full">
                <rect
                  width={`${pct}%`}
                  height="100%"
                  rx="4"
                  className={i === 0 ? "fill-brand-border" : "fill-brand-weak"}
                />
              </svg>
              <span className="relative block truncate pl-2.5 text-label leading-8 font-normal text-text-default">
                {row.name}
              </span>
            </div>
            <span className="min-w-13 shrink-0 text-right text-label font-medium tabular-nums">
              {row.value === null ? (
                <span className="text-caption font-normal text-text-muted">
                  {t.notProvided}
                </span>
              ) : (
                formatNumber(row.value)
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// 목록 칸 머리(제목 · 옅은 설명) + 열 이름 줄
function ListHead({
  id,
  title,
  note,
  valueName,
}: {
  id: string;
  title: string;
  note: string;
  valueName: string;
}) {
  return (
    <>
      <div className="flex items-baseline gap-2">
        <h2 id={id} className={SECTION_TITLE}>
          {title}
        </h2>
        <span className={SECTION_NOTE}>{note}</span>
      </div>
      <div className="mt-3 mb-1.5 flex justify-between text-caption text-text-muted">
        <span>{t.colName}</span>
        <span>{valueName}</span>
      </div>
    </>
  );
}

// 자리표시 막대 목록(행 5개, 같은 높이)
const BAR_RHYTHM = ["w-[96px]", "w-[72px]", "w-[64px]", "w-[88px]", "w-[80px]"];

function BarListSkeleton() {
  return (
    <ul aria-hidden="true" className="flex flex-col gap-1.5">
      {BAR_RHYTHM.map((w, i) => (
        <li key={i} className="flex items-center gap-3">
          <span className="flex h-8 flex-1 items-center rounded-admin-badge bg-border-subtle pl-2.5 text-label">
            <SkLine className={w} />
          </span>
          <span className="w-13 shrink-0 text-right text-label">
            <SkLine className="w-[32px]" />
          </span>
        </li>
      ))}
    </ul>
  );
}

// 응답에 칸이 생긴 목록(많이 본 화면·들어온 경로)의 본문: 자리표시 · 실패 · 빈 결과 · 막대 목록
function ListBody({
  placeholder,
  rows,
  unavailable,
}: {
  placeholder: boolean;
  rows: readonly { key: string; name: ReactNode; value: number | null }[] | null;
  unavailable: string;
}) {
  if (placeholder) return <BarListSkeleton />;
  if (rows === null)
    return <p className="text-body-s text-text-body">{unavailable}</p>;
  if (rows.length === 0)
    return <p className="text-body-s text-text-muted">{t.listEmpty}</p>;
  return <BarList rows={rows} />;
}

// 도넛(보드 V8 기기·화면 언어: 지름 140 · 가운데 합계). 비율은 받은 값의 합 기준, 값이 없으면 고리만
const DONUT_FILLS = [
  "stroke-brand-default",
  "stroke-brand-border",
  "stroke-border-note",
  "stroke-border-strong",
];
const DONUT_SWATCH = [
  "fill-brand-default",
  "fill-brand-border",
  "fill-border-note",
  "fill-border-strong",
];
const RADIUS = 15.9155; // 둘레 100

function Donut({
  id,
  title,
  rows,
  total,
}: {
  id: string;
  title: string;
  rows: readonly { key: string; label: string; value: number | null }[] | null;
  total: number | null;
}) {
  // 색이 4개라 5개 이상이면 앞 3개 + '기타'(나머지 합, 하나라도 비면 합도 비움). 고리와 범례가 같은 줄을 씀
  const shown =
    rows && rows.length > DONUT_FILLS.length
      ? [
          ...rows.slice(0, DONUT_FILLS.length - 1),
          {
            key: "other",
            label: t.donutOther,
            value: sumMetric(
              rows.slice(DONUT_FILLS.length - 1).map((r) => r.value),
            ),
          },
        ]
      : rows;
  let offset = 0;
  const arcs =
    shown && total !== null && total > 0
      ? shown.map((row, i) => {
          const pct = row.value === null ? 0 : (row.value / total) * 100;
          const arc = { key: row.key, pct, at: offset, i };
          offset += pct;
          return arc;
        })
      : [];
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className={SECTION_TITLE}>
        {title}
      </h2>
      <div className="mt-4 flex items-center gap-5">
        <div className="relative size-[140px] shrink-0">
          <svg
            aria-hidden="true"
            viewBox="0 0 36 36"
            className="size-full -rotate-90"
          >
            <circle
              cx="18"
              cy="18"
              r={RADIUS}
              fill="none"
              strokeWidth="4"
              className="stroke-border-subtle"
            />
            {arcs.map((a) => (
              <circle
                key={a.key}
                cx="18"
                cy="18"
                r={RADIUS}
                fill="none"
                strokeWidth="4"
                strokeDasharray={`${a.pct} ${100 - a.pct}`}
                strokeDashoffset={-a.at}
                className={DONUT_FILLS[a.i]}
              />
            ))}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-num-count font-normal tabular-nums">
              {formatNumber(total)}
            </span>
            <span className="text-caption text-text-muted">{t.donutTotal}</span>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          {shown === null ? (
            <p className="text-body-s text-text-body">
              {t.subReportUnavailable}
            </p>
          ) : shown.length === 0 ? (
            <p className="text-body-s text-text-muted">{t.listEmpty}</p>
          ) : (
            <ul>
              {shown.map((row, i) => {
                const pct = sharePercent(row.value, total);
                return (
                  <li
                    key={row.key}
                    className="flex items-center gap-2 border-b border-border-default py-1.5 text-body-s"
                  >
                    <svg aria-hidden="true" className="size-2.5 shrink-0">
                      <rect
                        width="100%"
                        height="100%"
                        rx="2"
                        className={DONUT_SWATCH[i]}
                      />
                    </svg>
                    <span className="flex-1 text-text-body">{row.label}</span>
                    <b className="font-medium tabular-nums">
                      {pct === null
                        ? t.emptyValue
                        : fill(t.percentUnit, { percent: pct })}
                    </b>
                  </li>
                );
              })}
            </ul>
          )}
          {shown !== null && shown.length > 0 && (
            <p className="mt-1.5 text-caption text-text-muted">{t.shareNote}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function DonutSkeleton({ id, title }: { id: string; title: string }) {
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className={SECTION_TITLE}>
        {title}
      </h2>
      <div aria-hidden="true" className="mt-4 flex items-center gap-5">
        <SkDonut className="size-[140px] [--sk-ring:16px]" />
        <ul className="min-w-0 flex-1">
          {["w-[56px]", "w-[40px]"].map((w, i) => (
            <li
              key={i}
              className="flex items-center gap-2 border-b border-border-default py-1.5 text-body-s"
            >
              <span className="size-2.5 shrink-0 rounded-[2px] bg-border-default" />
              <span className="flex-1">
                <SkLine className={w} />
              </span>
              <SkLine className="w-[28px]" />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function StatsBody({
  beachesBySlug,
}: {
  beachesBySlug: Readonly<Record<string, BeachSlugName>>;
}) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const signedIn = snapshot.status !== "signed_out";
  const generation = signedIn ? snapshot.generation : 0;
  // 보드 V8 기본 선택은 28일
  const [range, setRange] = useState<StatsRange>("28d");
  const [reloadTick, setReloadTick] = useState(0);
  const key = `${range}|${reloadTick}|${generation}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    // 15초(D26-4) 안에 답이 없으면 같은 자리에서 실패
    void withTimeout(
      () => fetchStats(range, () => session.accessToken()),
      TIMEOUT,
    ).then(
      (result) => {
        if (live) setLoaded({ key, result });
      },
    );
    return () => {
      live = false;
    };
  }, [session, signedIn, key, range]);

  // 같은 기간을 다시 읽는 중이면 받은 값을 둠(보드 L0 '다시 읽기 값 유지')
  // 기간이 바뀌면 앞 값은 다른 기간, 다시 로그인했으면 앞 세션 값이라 버림
  const [loadedRange, , loadedGeneration] = loaded?.key.split("|") ?? [];
  const sameRange =
    loadedRange === range && loadedGeneration === String(generation);
  const current = signedIn && loaded && sameRange ? loaded : null;
  const fetching = signedIn && loaded?.key !== key;
  const pending = !signedIn || current === null;
  const timing = useLoadTiming(pending);
  const placeholder = pending || timing.phase !== "content";
  const cls = loadClass(timing);
  const result = placeholder ? null : current!.result;
  const data = result && result.ok ? result.body : null;
  const refreshing = fetching && !pending;

  const isSample =
    (snapshot.status === "signed_in" && snapshot.pool === "demo") ||
    data?.sample === true;
  const periodOk = data?.configured === true && data.period.status === "ok";
  const period = periodOk ? data.period : null;
  // 기간 추이는 기간 통계와 따로 옴(기간 통계가 실패해도 추이는 있을 수 있음)
  const trends = data?.configured ? (data.trends ?? null) : null;
  const reasons = data
    ? metadataReasons(trendMetadata(data.period, trends))
    : [];
  const deviceTotal =
    period?.devices
      ? sumMetric(period.devices.map((d) => d.activeUsers))
      : null;
  const languageTotal =
    period?.languages
      ? sumMetric(period.languages.map((l) => l.activeUsers))
      : null;
  const live =
    data && data.realtime.status === "ok" ? data.realtime.activeUsers : null;
  const ratio = perUser(period?.pageViews ?? null, period?.activeUsers ?? null);
  // 칸 유무: 마지막으로 받은 응답(받는 중이면 다른 기간이어도) 기준
  // 받은 응답이 없으면 받는 중에만 지금 서버가 주는 칸 모두(자리표시 크기), 불러오지 못했으면 추이 칸을 두지 않음
  // (응답 전체 실패를 칸마다 '다른 칸은 그대로예요'로 보이지 않게)
  const lastBody = loaded?.result.ok ? loaded.result.body : null;
  const shape = lastBody
    ? statsShape(lastBody.configured ? lastBody.trends : undefined)
    : pending
      ? SHAPE_ALL
      : statsShape(undefined);
  const missing = missingItems(shape);
  const missingText = missing.map((m) => t.missingItems[m]).join(", ");
  const newRatio =
    trends?.newUsers !== undefined
      ? sharePercent(trends.newUsers, period?.activeUsers ?? null)
      : null;
  // 앞 기간: null(오늘 범위·조회 실패)이면 비교 배지·앞 값 줄 모두 숨김
  const previous = trends?.previous ?? null;
  const usersChange = changePercent(
    period?.activeUsers ?? null,
    previous?.activeUsers ?? null,
  );
  const viewsChange = changePercent(
    period?.pageViews ?? null,
    previous?.pageViews ?? null,
  );
  const previousNote = (value: number | null) =>
    previous
      ? fill(t.previousValue, {
          label: t.previousLabel[range],
          value: formatNumber(value),
        })
      : t.rangeLabel[range];
  const unavailable = trendUnavailable(trends);
  const daily = trends?.daily?.rows ?? null;
  const dailyRows = (pick: "activeUsers" | "pageViews") =>
    daily?.map((d) => ({
      key: d.date,
      label: shortDate(d.date),
      value: d[pick],
    })) ?? null;
  const hourlyRows =
    trends?.hourly?.rows.map((r) => ({
      key: String(r.hour),
      label: fill(t.hourLabel, { hour: r.hour }),
      value: roundAverage(r.averageActiveUsers),
      // 오늘 범위의 아직 지나지 않은 시간(셀 날이 0): 결측(옅은 빈칸)이 아니라 비워 둠
      notYet: r.reportedDays === 0,
    })) ?? null;
  // 기간 표시: 응답의 KST 날짜(양 끝 포함), 앞 기간이 있으면 '앞 N일과 비교'. 추이가 없으면 기간 이름
  const rangeText = trendRangeText(trends, range, ", ") ?? t.rangeLabel[range];
  const englishTag = (english: boolean) =>
    english && (
      <span className="ml-1.5 text-caption text-text-muted">{t.englishTag}</span>
    );
  const listCount = 1 + Number(shape.topScreens) + Number(shape.referrers);

  return (
    <>
      <LoadingStatus
        busy={signedIn && pending}
        label={fill(messages.loading.screen, { name: t.title })}
      />
      <span role="status" className="sr-only">
        {timing.slow ? messages.loading.slow : ""}
      </span>
      <div
        aria-busy={pending || undefined}
        className="flex w-full flex-col px-4 py-5 md:px-10 md:pt-6 md:pb-10"
      >
        {/* 머리(보드 .w-hd): 왼쪽 제목·지금 사용 중·설명·숫자 숨김 안내, 오른쪽 기간 단추 */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <h1 className="text-title-l font-semibold text-text-default">
                {t.title}
              </h1>
              <span className="inline-flex items-center gap-1.5 text-label-s text-text-body lg:ml-1.5">
                <svg aria-hidden="true" className="size-2 shrink-0">
                  <circle
                    cx="50%"
                    cy="50%"
                    r="50%"
                    className={
                      !placeholder && live !== null
                        ? "fill-success-icon"
                        : "fill-border-strong"
                    }
                  />
                </svg>
                {t.liveLabel}{" "}
                <b className="font-semibold text-text-default">
                  {placeholder ? (
                    <SkLine className="w-[24px] h-[8px]" />
                  ) : live !== null ? (
                    fill(t.liveCount, { count: formatNumber(live) })
                  ) : (
                    t.liveUnknown
                  )}
                </b>
                <span className="text-text-muted">{t.liveWindow}</span>
              </span>
              {isSample && (
                <span
                  className={`${BADGE} bg-status-stale-bg text-status-stale-fg`}
                >
                  {t.sample}
                </span>
              )}
            </div>
            {/* 기간 표시: PC는 설명 뒤 같은 줄, 좁은 화면은 다음 줄(날짜 글이 길어 값 뒤 줄바꿈이 달라지지 않게)
                받는 중에는 같은 줄 높이 자리표시 */}
            <p className="mt-0.5 text-label-s text-text-muted">
              {t.subtitle}
              <span className="block lg:inline">
                <span className="hidden lg:inline">{t.subtitleSeparator}</span>
                {placeholder ? (
                  <SkLine className="w-[200px] h-[8px]" />
                ) : (
                  rangeText
                )}
              </span>
              {!placeholder && trends?.timeZoneMismatch === true && (
                <>
                  {" "}
                  <span
                    className={`${BADGE} ml-1 bg-status-stale-bg text-status-stale-fg`}
                  >
                    {t.timeZoneMismatch}
                  </span>{" "}
                  {trends.ga4TimeZone &&
                    fill(t.timeZoneProperty, { zone: trends.ga4TimeZone })}
                </>
              )}
            </p>
            {/* 응답에 칸이 없는 항목 한 줄. 받는 중에는 줄이 생길 때만(앞 응답 기준, 첫 응답 전에는 없음) 같은 줄 높이 자리표시 */}
            {placeholder ? (
              missing.length > 0 && (
                <p className="mt-0.5 text-label-s">
                  <SkLine className="w-[360px] max-w-full h-[8px]" />
                </p>
              )
            ) : (
              data?.configured === true &&
              missing.length > 0 && (
                <p className="mt-0.5 text-label-s text-text-body">
                  {fill(t.missingLine, {
                    items: `${missingText}${topicParticle(missingText)}`,
                  })}
                </p>
              )
            )}
            {/* 기준 시각·잠시 저장된 응답·새로 고침(시안에 없음, 기존 줄이라 남김) */}
            <div className="mt-1 flex min-h-touch flex-wrap items-center gap-x-2 gap-y-1 text-caption text-text-muted lg:min-h-0">
              {data ? (
                <span>
                  {fill(t.fetchedAt, { time: kstDateTime(data.fetchedAt) })}
                </span>
              ) : (
                <SkLine className="w-[120px] h-[8px]" />
              )}
              {data?.cached && (
                <span
                  className={`${BADGE} bg-bg-surface font-medium text-text-body ring-1 ring-border-default ring-inset`}
                >
                  {t.cachedBadge}
                </span>
              )}
              {refreshing && (
                <span className="inline-flex items-center gap-1 text-brand-default">
                  <Spinner />
                  {messages.loading.refreshing}
                </span>
              )}
              <button
                type="button"
                aria-disabled={fetching || undefined}
                onClick={() => !fetching && setReloadTick((n) => n + 1)}
                className="inline-flex min-h-touch items-center font-medium text-brand-default underline underline-offset-2 aria-disabled:cursor-progress aria-disabled:opacity-60 lg:min-h-0"
              >
                {t.refresh}
              </button>
            </div>
            {/* 숫자 숨김 안내: 응답을 받은 뒤 metadata가 있을 때만(L7: 로딩 중에는 자리도 두지 않음) */}
            {!placeholder && reasons.length > 0 && (
              <div className="mt-3 max-w-[760px]">
                <div
                  role="status"
                  className="rounded-admin-control border border-border-default bg-bg-page py-2 pr-2.5 pl-3 text-label-s"
                >
                  <p className="font-semibold text-text-default">
                    {reasons.includes("thresholding")
                      ? t.hiddenTitle
                      : t.limitedTitle}
                  </p>
                  {reasons.map((r) => (
                    <p key={r} className="text-text-body">
                      {t.hiddenReasons[r]}
                    </p>
                  ))}
                </div>
                <p className="mt-1.5 text-caption text-text-muted">
                  {t.hiddenNote}
                </p>
              </div>
            )}
          </div>
          <div
            role="group"
            aria-label={t.rangeGroupLabel}
            className="inline-flex w-fit shrink-0 overflow-hidden rounded-admin-control border border-border-strong shadow-card"
          >
            {STATS_RANGES.map((r) => {
              const active = range === r;
              return (
                <button
                  key={r}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setRange(r)}
                  className={`inline-flex h-touch items-center border-l border-border-strong px-3 text-label whitespace-nowrap first:border-l-0 lg:h-segment ${
                    active
                      ? "bg-bg-page font-semibold text-text-default"
                      : "bg-bg-surface font-medium text-text-body hover:bg-bg-page"
                  }`}
                >
                  {t.range[r]}
                </button>
              );
            })}
          </div>
        </div>

        {!placeholder && result && !result.ok && (
          <div className="mt-6">
            <Notice tone="fail" title={t.loadError} role="alert">
              <p>{t.loadErrorHint}</p>
              {"requestId" in result && result.requestId && (
                <p>{fill(t.requestId, { id: result.requestId })}</p>
              )}
              <Button
                variant="secondary"
                size="small"
                className="mt-2"
                onClick={() => setReloadTick((n) => n + 1)}
              >
                {t.retry}
              </Button>
            </Notice>
          </div>
        )}

        {data && !data.configured && (
          <div className="mt-6">
            <Notice tone="warn" title={t.unconfiguredTitle} role="status">
              {t.unconfiguredBody}
            </Notice>
          </div>
        )}

        {data && data.configured && data.period.status === "unavailable" && (
          <div className="mt-6">
            <Notice tone="warn" title={t.periodUnavailable} role="status">
              {t.subReportUnavailable}
            </Notice>
          </div>
        )}

        <div className={cls}>
          {/* KPI(보드 V8: 사용자 · 화면 조회 · 새 사용자 비율 · 사용자당 화면). 새 사용자 비율은 응답에 칸이 있을 때만 */}
          <dl
            className={`mt-7 grid grid-cols-2 gap-x-8 gap-y-5 ${
              shape.newUsers ? "lg:grid-cols-4" : "lg:grid-cols-3"
            }`}
          >
            <Kpi
              label={t.kpiUsers}
              placeholder={placeholder}
              width="w-[64px]"
              value={period ? formatNumber(period.activeUsers) : null}
              note={previousNote(previous?.activeUsers ?? null)}
              change={usersChange}
            />
            <Kpi
              label={t.kpiViews}
              placeholder={placeholder}
              width="w-[80px]"
              value={period ? formatNumber(period.pageViews) : null}
              note={previousNote(previous?.pageViews ?? null)}
              change={viewsChange}
            />
            {shape.newUsers && (
              <Kpi
                label={t.kpiNewRatio}
                placeholder={placeholder}
                width="w-[32px]"
                value={
                  newRatio === null
                    ? period
                      ? t.emptyValue
                      : null
                    : fill(t.percentUnit, { percent: newRatio })
                }
                note={t.rangeLabel[range]}
              />
            )}
            <Kpi
              label={t.kpiPerUser}
              placeholder={placeholder}
              width="w-[32px]"
              value={ratio === null ? (period ? t.emptyValue : null) : ratio.toFixed(1)}
              note={t.perUserHint}
            />
          </dl>

          {/* 일별 사용자(보드: 그래프 200 + 날짜 줄 24). 응답에 일별 칸이 있을 때만 */}
          {shape.daily && (
            <div className="mt-7">
              <ChartBlock
                id="stats-daily-users"
                title={t.dailyUsers}
                top="mt-5"
                frame="h-[224px]"
                bars="h-[200px]"
                placeholder={placeholder}
                rows={dailyRows("activeUsers")}
                head={t.chartTableDate}
                valueHead={t.kpiUsers}
                unavailable={unavailable}
              />
            </div>
          )}

          {(shape.hourly || shape.daily) && (
            <div className="mt-7 grid gap-8 lg:grid-cols-2">
              {shape.hourly && (
                // 보드: 위 여백 36 + 막대 120 + 시각 줄 24
                <ChartBlock
                  id="stats-hourly"
                  title={t.hourlyUsers}
                  top="mt-9"
                  frame="h-[144px]"
                  bars="h-[120px]"
                  placeholder={placeholder}
                  rows={hourlyRows}
                  head={t.chartTableHour}
                  valueHead={t.averageUsers}
                  note={fill(t.hourlyNote, { range: t.range[range] })}
                  unavailable={unavailable}
                  format={formatAverage}
                />
              )}
              {shape.daily && (
                <ChartBlock
                  id="stats-daily-views"
                  title={t.dailyViews}
                  top="mt-5"
                  frame="h-[152px]"
                  bars="h-[128px]"
                  placeholder={placeholder}
                  rows={dailyRows("pageViews")}
                  head={t.chartTableDate}
                  valueHead={t.kpiViews}
                  unavailable={unavailable}
                />
              )}
            </div>
          )}

          <div className="mt-7 grid gap-8 lg:grid-cols-2">
            {placeholder ? (
              <>
                <DonutSkeleton id="stats-devices" title={t.devicesTitle} />
                <DonutSkeleton id="stats-languages" title={t.languagesTitle} />
              </>
            ) : (
              <>
                <Donut
                  id="stats-devices"
                  title={t.devicesTitle}
                  rows={
                    period
                      ? (period.devices?.map((d) => ({
                          key: d.category,
                          label: deviceLabel(d.category),
                          value: d.activeUsers,
                        })) ?? null)
                      : null
                  }
                  total={deviceTotal}
                />
                <Donut
                  id="stats-languages"
                  title={t.languagesTitle}
                  rows={
                    period
                      ? (period.languages?.map((l) => ({
                          key: l.language,
                          label: languageLabel(l.language),
                          value: l.activeUsers,
                        })) ?? null)
                      : null
                  }
                  total={languageTotal}
                />
              </>
            )}
          </div>

          {/* 목록: 많이 본 해변 + 응답에 칸이 있는 목록(화면·들어온 경로). 하나뿐이면 도넛과 같은 반 폭 */}
          <div
            className={`mt-7 grid gap-7 ${
              listCount === 3 ? "lg:grid-cols-3" : "lg:grid-cols-2"
            }`}
          >
            <section aria-labelledby="stats-beaches" className="min-w-0">
              <ListHead
                id="stats-beaches"
                title={t.topBeachesTitle}
                note={t.topBeachesNote}
                valueName={t.colViews}
              />
              {placeholder ? (
                <BarListSkeleton />
              ) : !period || period.topBeaches === null ? (
                <p className="text-body-s text-text-body">
                  {t.subReportUnavailable}
                </p>
              ) : period.topBeaches.length === 0 ? (
                <p className="text-body-s text-text-muted">
                  {t.topBeachesEmpty}
                </p>
              ) : (
                <BarList
                  rows={period.topBeaches.map((row) => {
                    const label = beachLabel(row, beachesBySlug);
                    return {
                      key: row.path,
                      value: row.pageViews,
                      name:
                        label.name ?? (
                          <span className="text-text-muted">
                            {t.nameUnknown}
                          </span>
                        ),
                    };
                  })}
                />
              )}
            </section>
            {shape.topScreens && (
              <section aria-labelledby="stats-screens" className="min-w-0">
                <ListHead
                  id="stats-screens"
                  title={t.topScreensTitle}
                  note={t.topScreensNote}
                  valueName={t.colViews}
                />
                <ListBody
                  placeholder={placeholder}
                  unavailable={unavailable}
                  rows={
                    trends?.topScreens?.rows.map((row, i) => {
                      const label = screenLabel(row, beachesBySlug);
                      return {
                        key: `${i}:${row.path}`,
                        value: row.pageViews,
                        name:
                          label.kind === "other" ? (
                            t.otherRow
                          ) : label.kind === "unknown" ? (
                            // 모르는 경로: 이름처럼 크게 보이지 않게 경로 그대로 작은 글씨
                            <span className="text-caption text-text-muted">
                              {label.path}
                            </span>
                          ) : label.kind === "screen" ? (
                            <>
                              {t.screenNames[label.key]}
                              {englishTag(label.english)}
                            </>
                          ) : (
                            <>
                              {label.name ?? (
                                <span className="text-text-muted">
                                  {t.nameUnknown}
                                </span>
                              )}
                              {englishTag(label.english)}
                            </>
                          ),
                      };
                    }) ?? null
                  }
                />
              </section>
            )}
            {shape.referrers && (
              <section aria-labelledby="stats-referrers" className="min-w-0">
                <ListHead
                  id="stats-referrers"
                  title={t.referrersTitle}
                  note={t.referrersNote}
                  valueName={t.colSessions}
                />
                <ListBody
                  placeholder={placeholder}
                  unavailable={unavailable}
                  rows={
                    trends?.referrers?.rows.map((row, i) => ({
                      key: `${i}:${row.channel}`,
                      value: row.sessions,
                      name: row.other
                        ? t.otherRow
                        : channelName(row.channel, t.channelLabels),
                    })) ?? null
                  }
                />
              </section>
            )}
          </div>

          <p className="mt-6 text-caption text-text-muted">{t.foot}</p>

        </div>
      </div>
    </>
  );
}

export function StatsScreen({
  beachesBySlug,
}: {
  beachesBySlug: Record<string, BeachSlugName>;
}) {
  // 세션 확인 중(첫 진입)에도 같은 요소를 그려 자리표시를 이어서 씀(보드 L10)
  const body = <StatsBody beachesBySlug={beachesBySlug} />;
  return (
    <AdminShell title={t.title} loading={body}>
      {body}
    </AdminShell>
  );
}
