"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { opsFetch, type OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import {
  fetchPublished,
  parsePublished,
  REPO_URL,
  type PublishedView,
} from "@/lib/beaches";
import {
  fetchCollection,
  kstClock,
  type CollectionView,
} from "@/lib/collection";
import {
  beachCounts,
  collectionSummary,
  expiredCount,
  inquirySummary,
  inquiryWindow,
  judgmentLine,
  mergePart,
  nextCollection,
  noticeCounts,
  partOf,
  ratioPercent,
  reasonTime,
  settle,
  staleSince,
  todos,
  undeterminedRows,
  valueOf,
  type BeachCounts,
  type Slot,
  type UndeterminedRow,
} from "@/lib/home";
import { badgeOwner, setReceivedCount } from "@/lib/inquiry-badge";
import { fetchInquiries, kstDateTime, type InquiryPage } from "@/lib/inquiries";
import { LOADING_TIMES } from "@/lib/loading-timing";
import { copula } from "@/lib/korean";
import { fill, messages } from "@/lib/messages";
import { fetchNotices, type NoticeView } from "@/lib/notices";
import {
  changePercent,
  fetchStats,
  SHAPE_ALL,
  statsShape,
  trendRangeText,
  trendUnavailable,
  type StatsResponse,
} from "@/lib/stats";
import { pageWindow } from "@/lib/paging";
import { AdminShell } from "./admin-shell";
import type { Beaches } from "./audit-screen";
import { BarChart, hasNull, shortDate, type ChartRow } from "./bar-chart";
import { Badge } from "./beach-status";
import {
  CELL_END,
  CELL_NAME,
  DataTable,
  Pager,
  TD,
  TH,
  TR,
} from "./data-table";
import {
  loadClass,
  LoadingStatus,
  SkLine,
  SkChart,
  SkPill,
  Spinner,
  useLoadTiming,
} from "./loading";
import { Button, Notice, SUCCESS_BADGE, TextLink } from "./ui";

// 운영 홈 (BRD-149, 화면 설계서 6장 ADM-HOME · 시안 4차 보드 V1 · 로딩 L1·LM1, GH-453)
// 로그인 뒤 /ops/me로 서버가 이 세션을 받아 주는지 먼저 확인함
// 데모 계정이 허용 기간 밖이면 서버가 403(sample_not_allowed) → 화면에서도 막힘을 알림(D16-A8, 캔버스 E11-4)
// - 머리: 제목 + 오른쪽 기준 시각('1분마다 다시 읽어요')·세션 안내(D17-11 문구)
// - 판단 출처 상태 한 줄(시안에 없음): 모바일·태블릿만(PC는 왼쪽 메뉴 상태 칸). 하나라도 정상이 아니면 문제 줄(내부 화면이라 출처 이름을 씀)
//   사용자 화면 배너 문구(12장 결정 1 '확인된 판단 없음')는 여기서 바꾸지 않음
// - 세 칸(앱에 보이는 해변 · 수집 · 문의), 판단불가 해변 표, 할 일, 이용(GA 28일 합계)
// - 못 읽은 값은 0·정상·'할 일 없음'으로 바꾸지 않고 '확인 못 함'. 다시 읽는 동안은 앞 값을 그대로 둠
// - 서버가 준 값만 씀: 이용 칸 일별·앞 기간(trends, GH-477), 문의 최근 7일·가장 오래된 미처리(GH-478), 다음 수집(GH-478)
//   칸이 응답에 없으면(이전 서버·데모) 지어내지 않고 지금 표시를 유지, null이면 '확인 못 함'
// - 화면이 보이는 동안 60초마다 다시 읽음(D16-E1 운영 홈 60초)
// - 로딩(GH-462, 보드 L0·LS·LP·L1): 칸마다 값과 같은 크기 자리표시(150ms 뒤 · 최소 400ms · 0.18초 페이드)
//   다시 읽는 동안은 값을 두고 기준 시각 옆에 회전 표시. 다시 읽기가 실패한 칸은 앞 값을 두고 '마지막으로 받은 값' 줄
//   세션 확인 중(첫 진입)에도 같은 요소를 그려 확인이 끝나면 자리표시를 이어서 씀(AdminShell loading)
// - 막대 길이는 SVG 속성(%)으로 줌: CSP style-src 'self'라 style 속성을 쓰지 않음

const t = messages;
const h = messages.home;
const REFRESH_MS = 60_000;
// 이용 칸은 GA 집계라 5분마다만 다시 읽음(서버 저장 5분과 같게, 60초마다 GA를 부르지 않음). 다시 시도는 바로
const USAGE_REFRESH_MS = 5 * 60_000;
// 판단불가 해변 표 한 쪽 줄 수(보드 V1은 3줄 예시). 넘치면 페이지 넘김
const UNDETERMINED_PAGE = 5;
// 운영 홈 이용 칸 기간(보드 V1 '앞 28일과 비교'의 28일)
const USAGE_RANGE = "28d" as const;
// 보드 V1 공통 CSS 값(.w-blk · .w-foot · h2). 크기는 공유 토큰 글자 크기, 간격은 Tailwind 간격
const BLOCK_TITLE =
  "flex items-center gap-2 text-body font-bold text-text-default";
const VALUE = "text-num-s font-normal text-text-default tabular-nums";
const HINT = "text-label-s text-text-muted";
const FOOT = "mt-4 text-caption text-text-muted";
// 칸 아래 줄 자리표시 높이: 값이 오면 들어가는 링크와 같은 높이(모바일·태블릿 터치 44, PC 줄 높이)
const FOOT_LINE = "inline-flex min-h-touch items-center lg:min-h-0";
const SECTION_TITLE = "text-title-card font-semibold text-text-default";
const BADGE =
  "inline-flex h-5 shrink-0 items-center gap-1 rounded-admin-badge px-1.5 text-caption font-semibold whitespace-nowrap";
const WARN_BADGE =
  "bg-status-stale-bg text-status-stale-fg outline-1 outline-dashed -outline-offset-1 outline-status-stale-border";
const NEW_BADGE =
  "bg-brand-weak text-status-clear-fg ring-1 ring-brand-border ring-inset";
// 할 일 줄의 작은 버튼(보드 .w-btn.w-s: 높이 32 · 13px). 모바일·태블릿은 터치 44
const SMALL_LINK =
  "inline-flex h-touch shrink-0 items-center rounded-admin-control border border-border-strong bg-bg-surface px-2.5 text-body-s font-medium whitespace-nowrap text-text-default shadow-card hover:bg-bg-page lg:h-8";
// 모바일 순서(보드 LM1: 앱에 보이는 해변 → 할 일 → 수집 …). PC는 격자 순서 그대로
const ORDER = {
  beaches: "order-1 lg:order-none",
  todo: "order-2 lg:order-none",
  collection: "order-3 lg:order-none",
  inquiries: "order-4 lg:order-none",
  undetermined: "order-5 lg:order-none",
  usage: "order-6 lg:order-none",
} as const;

interface Me {
  readonly kind: "operator" | "sample";
  readonly role: string;
  readonly sessionExpiresAt: string;
}

// 칸마다 따로 읽고 따로 그림. 하나가 늦거나 응답이 없어도 다른 칸(특히 판단 출처 줄)은 먼저 보임
interface Parts {
  readonly collection: Slot<CollectionView>;
  // 게시본이 없다는 응답(available: false)도 불러오지 못함으로 봄(0곳·시각 없음으로 보이지 않게)
  readonly published: Slot<Extract<PublishedView, { available: true }>>;
  readonly inquiries: Slot<InquiryPage>;
  readonly notices: Slot<readonly NoticeView[]>;
  readonly usage: Slot<StatsResponse>;
}

const LOADING = { state: "loading" } as const;
const NO_STALE: ReadonlySet<keyof Parts> = new Set();
const INITIAL: Parts = {
  collection: LOADING,
  published: LOADING,
  inquiries: LOADING,
  notices: LOADING,
  usage: LOADING,
};

type Token = () => Promise<string | null>;

type Loaders = {
  readonly [K in keyof Parts]: () => Promise<Exclude<Parts[K], typeof LOADING>>;
};

function loaders(token: Token, owner: string | null): Loaders {
  const raw = {
    collection: async () => partOf(await fetchCollection(token), (b) => b),
    published: async () =>
      partOf(await fetchPublished(token), (body) => {
        const view = parsePublished(body);
        return view?.available ? view : null;
      }),
    inquiries: async () => {
      // 상태별 수(counts)만 쓰므로 한 건만 받음. 수가 하나라도 틀리면 불러오지 못함
      const part = partOf(await fetchInquiries(token, { limit: 1 }), (body) =>
        inquirySummary(body) ? body : null,
      );
      // 왼쪽 메뉴 '문의' 배지도 같은 값으로 맞춤
      const summary = part.state === "ok" ? inquirySummary(part.value) : null;
      if (owner && summary) setReceivedCount(owner, summary.received);
      return part;
    },
    notices: async () =>
      partOf(await fetchNotices(token), (body) =>
        Array.isArray(body?.items) ? body.items : null,
      ),
    // 이용 통계(GA Data API 집계, 서버가 5분 저장). 데모 계정은 서버가 예시 응답
    usage: async () => partOf(await fetchStats(USAGE_RANGE, token), (b) => b),
  };
  // 칸마다 시간 제한(15초, D26-4)·예외 처리(멈춘 칸이 '불러오는 중'에 머물지 않게)
  return {
    collection: () => settle(raw.collection),
    published: () => settle(raw.published),
    inquiries: () => settle(raw.inquiries),
    notices: () => settle(raw.notices),
    usage: () => settle(raw.usage),
  };
}

// 칸 하나의 자리표시 여부와 바깥 클래스. 값(또는 실패)이 와도 최소 유지 시간 동안은 자리표시
// 시간 제한 상태보다 받은 결과가 기준(15초에 settle이 실패로 바꿈)
function useSlot(part: Slot<unknown>): { placeholder: boolean; cls: string } {
  const timing = useLoadTiming(part.state === "loading");
  return {
    placeholder: part.state === "loading" || timing.phase !== "content",
    cls: loadClass(timing),
  };
}

function SourcesLine({
  part,
  onRetry,
}: {
  part: Slot<CollectionView>;
  onRetry: () => void;
}) {
  const slot = useSlot(part);
  return (
    <div className={slot.cls}>
      {slot.placeholder || part.state === "loading" ? (
        // 정상 줄(알림 상자 제목 + 출처 줄)과 같은 높이. 정상·문제 색을 미리 보이지 않게 중립 상자
        <div className="rounded-admin-box border border-border-default bg-bg-page px-3.5 py-3 text-body-s">
          <p>
            <SkLine className="w-[232px]" />
          </p>
          <p className="mt-1">
            <SkLine className="w-[280px] max-w-full" />
          </p>
        </div>
      ) : (
        <SourcesResult part={part} onRetry={onRetry} />
      )}
    </div>
  );
}

function SourcesResult({
  part,
  onRetry,
}: {
  part: Exclude<Slot<CollectionView>, { state: "loading" }>;
  onRetry: () => void;
}) {
  const line = judgmentLine(valueOf(part));
  const link = (
    <TextLink
      href="/collection/"
      className="mt-1 inline-flex min-h-touch items-center font-medium underline lg:min-h-0"
    >
      {h.openCollection}
    </TextLink>
  );
  if (!line) {
    return (
      <Notice tone="warn" title={h.sourcesUnknown} role="alert">
        <p>{h.sourcesUnknownHint}</p>
        {part.state === "failed" && part.requestId && (
          <p>{fill(h.requestId, { id: part.requestId })}</p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-3">
          <Button variant="secondary" size="small" onClick={onRetry}>
            {h.retry}
          </Button>
          {link}
        </div>
      </Notice>
    );
  }
  const items = (
    <ul className="flex flex-wrap gap-x-3 gap-y-1">
      {line.sources.map((s) => (
        <li key={s.job}>
          {fill(h.sourceItem, {
            source: t.collection.source[s.job],
            state: t.collection.state[s.state],
          })}
        </li>
      ))}
    </ul>
  );
  if (line.problems.length === 0) {
    return (
      <Notice tone="neutral" title={h.sourcesOk} role="status">
        {items}
      </Notice>
    );
  }
  return (
    <Notice tone="fail" title={h.sourcesProblem} role="alert">
      {items}
      <p className="mt-1">{h.sourcesProblemHint}</p>
      {link}
    </Notice>
  );
}

// 다시 읽기가 실패해 앞 값을 둔 칸 표시(색만이 아니라 글로 알림)
function StaleMark() {
  return (
    <span className="ml-1.5 align-middle text-label-s font-normal text-text-muted">
      {t.loading.staleShort}
    </span>
  );
}

// 칸을 불러오지 못함(15초 시간 제한 포함): 무슨 일 → 영향 → 다음 행동 + 같은 칸 안에서 다시 시도
function BlockFailed({
  part,
  onRetry,
  className = FOOT,
  message,
}: {
  part: Slot<unknown>;
  onRetry: () => void;
  className?: string;
  // 응답은 왔지만 그 안의 리포트를 못 받은 경우(예: GA 기간 통계) 문구. 있으면 다시 시도도 보임
  message?: string;
}) {
  const retry = part.state === "failed" || message !== undefined;
  return (
    <div
      role="status"
      className={`${className} flex flex-wrap items-center gap-x-2`}
    >
      <span className="text-text-default">
        {message ?? (part.state === "forbidden" ? h.forbidden : h.blockFailed)}
      </span>
      {part.state === "failed" && part.requestId && (
        <span>{fill(h.requestId, { id: part.requestId })}</span>
      )}
      {retry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-touch items-center font-medium text-brand-default underline underline-offset-2 lg:min-h-0"
        >
          {h.retry}
        </button>
      )}
    </div>
  );
}

// 큰 숫자 줄(보드 .w-v: 20px 값 + 12.5px 보조). 못 읽으면 '확인 못 함'(0으로 채우지 않음)
function ValueLine({
  part,
  placeholder,
  width,
  hintWidth,
  stale,
  value,
  hint,
}: {
  part: Slot<unknown>;
  placeholder: boolean;
  width: string;
  hintWidth: string;
  stale: boolean;
  value: ReactNode;
  hint: ReactNode;
}) {
  return (
    <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
      <span className={VALUE}>
        {placeholder ? (
          <SkLine className={width} />
        ) : part.state === "ok" ? (
          value
        ) : (
          h.unknown
        )}
      </span>
      <span className={HINT}>
        {placeholder ? (
          <SkLine className={`${hintWidth} h-[8px]`} />
        ) : part.state === "ok" ? (
          <>
            {hint}
            {stale && <StaleMark />}
          </>
        ) : null}
      </span>
    </p>
  );
}

// 막대(보드 .w-pb: 높이 6 · 모서리 3). percent null이면 빈 막대(자리표시·못 읽음)
function Meter({ percent }: { percent: number | null }) {
  return (
    <svg aria-hidden="true" className="mt-2 block h-1.5 w-full">
      <rect
        width="100%"
        height="100%"
        rx="3"
        className={percent === null ? "fill-border-subtle" : "fill-brand-weak"}
      />
      {percent !== null && percent > 0 && (
        <rect
          width={`${percent}%`}
          height="100%"
          rx="3"
          className="fill-brand-default"
        />
      )}
    </svg>
  );
}

// 앱 표시 막대(보드 .w-cb: 분류별 길이 · 사이 2px). 색만으로 나누지 않게 아래 범례에 글자와 수
const SEGMENT_FILL = {
  clear: "fill-chart",
  unavailable: "fill-status-blocked-fg",
  undetermined: "fill-status-unknown-border",
} as const;

function StackBar({ counts }: { counts: BeachCounts | null }) {
  const keys = ["clear", "unavailable", "undetermined"] as const;
  const segments =
    counts && counts.total > 0
      ? keys
          .filter((k) => counts[k] > 0)
          .map((k) => ({ key: k, width: (counts[k] / counts.total) * 100 }))
      : [];
  let x = 0;
  const placed = segments.map((s) => {
    const at = x;
    x += s.width;
    return { ...s, at };
  });
  return (
    <svg aria-hidden="true" className="mt-2 block h-1.5 w-full">
      {placed.length === 0 ? (
        <rect
          width="100%"
          height="100%"
          rx="3"
          className="fill-border-subtle"
        />
      ) : (
        placed.map((s) => (
          <rect
            key={s.key}
            x={`${s.at}%`}
            width={`${s.width}%`}
            height="100%"
            rx="3"
            className={SEGMENT_FILL[s.key]}
          />
        ))
      )}
      {/* 칸 사이 2px 틈: 경계에 면 색 2px(가운데 맞춤) */}
      {placed.slice(1).map((s) => (
        <rect
          key={`gap-${s.key}`}
          x={`${s.at}%`}
          width="2"
          height="100%"
          transform="translate(-1 0)"
          className="fill-bg-surface"
        />
      ))}
    </svg>
  );
}

// 판단불가 해변 이름(이름표에 없으면 '이름 확인 못 함', ID를 이름처럼 보이지 않음)
const rowName = (row: UndeterminedRow) => row.name ?? h.nameUnknown;

function BeachesBlock({
  part,
  stale,
  nowMs,
  onRetry,
  names,
}: {
  part: Parts["published"];
  stale: boolean;
  nowMs: number;
  onRetry: () => void;
  names: Beaches;
}) {
  const slot = useSlot(part);
  const placeholder = slot.placeholder || part.state === "loading";
  const published = placeholder ? null : valueOf(part);
  const counts = beachCounts(published);
  const rows = undeterminedRows(published, names);
  const expired = expiredCount(published, nowMs);
  const legend = [
    { key: "clear", width: "w-[32px]" },
    { key: "unavailable", width: "w-[24px]" },
    { key: "undetermined", width: "w-[16px]" },
  ] as const;
  const shown = rows?.slice(0, 3).map(rowName) ?? [];
  return (
    <section
      aria-labelledby="home-beaches"
      className={`${ORDER.beaches} ${slot.cls}`}
    >
      <h2 id="home-beaches" className={BLOCK_TITLE}>
        {h.beachesTitle}
      </h2>
      <ValueLine
        part={part}
        placeholder={placeholder}
        width="w-[56px]"
        hintWidth="w-[96px]"
        stale={stale}
        value={counts ? fill(h.beachesValue, { count: counts.total }) : null}
        hint={
          published
            ? fill(h.beachesAt, { time: kstDateTime(published.generatedAt) })
            : null
        }
      />
      <p className="mt-4 text-body font-medium text-text-default">
        {h.beachesBar}
      </p>
      <StackBar counts={counts} />
      <ul className="mt-5 flex flex-col gap-2">
        {legend.map(({ key, width }) => (
          <li key={key} className="flex items-center gap-2 text-label-s">
            <svg aria-hidden="true" className="size-2.5 shrink-0">
              <rect
                width="100%"
                height="100%"
                rx="2"
                className={counts ? SEGMENT_FILL[key] : "fill-border-default"}
              />
            </svg>
            <span className="text-text-default tabular-nums">
              {placeholder ? (
                <SkLine className={`${width} h-[8px]`} />
              ) : counts ? (
                fill(h.beachesCount, { count: counts[key] })
              ) : (
                t.stats.emptyValue
              )}
            </span>
            <span className="text-text-muted">{t.beaches.category[key]}</span>
          </li>
        ))}
      </ul>
      {placeholder ? (
        <p className={FOOT}>
          <span className={FOOT_LINE}>
            <SkLine className="w-[272px] max-w-full h-[8px]" />
          </span>
        </p>
      ) : rows ? (
        <p className={FOOT}>
          {rows.length === 0
            ? h.beachesFootNone
            : rows.length <= 3
              ? fill(h.beachesFoot, {
                  count: rows.length,
                  names: shown.join("·"),
                  copula: copula(shown.join("·")),
                })
              : fill(h.beachesFootMore, {
                  count: rows.length,
                  names: shown.join("·"),
                  more: rows.length - 3,
                })}{" "}
          <TextLink
            href="/beaches/"
            className="inline-flex min-h-touch items-center text-caption lg:min-h-0"
          >
            {h.beachesOpen}
          </TextLink>
        </p>
      ) : (
        <BlockFailed part={part} onRetry={onRetry} />
      )}
      {/* 분류는 그대로 두고 유효 시각 지남을 따로 알림(해변 관리와 같은 기준, 화면에서 다시 분류하지 않음) */}
      {expired !== null && expired > 0 && (
        <p className="mt-2 text-label-s font-medium text-text-default">
          {fill(h.kpiExpired, { count: expired })}
        </p>
      )}
      {/* 점검 중이면 앱이 해변 상태를 숨김. 개수는 마지막 게시본 그대로(D23-11) */}
      {published?.maintenance.active && (
        <p className="mt-2 text-label-s font-medium text-text-default">
          {h.kpiMaintenance}
        </p>
      )}
    </section>
  );
}

// 줄 하나(보드 V1 수집·문의 칸: 이름 · 오른쪽 값 + 막대)
function BarRow({
  placeholder,
  name,
  nameWidth,
  right,
  rightWidth,
  percent,
}: {
  placeholder: boolean;
  name: ReactNode;
  nameWidth: string;
  right: ReactNode;
  rightWidth: string;
  percent: number | null;
}) {
  return (
    <li>
      <p className="flex justify-between gap-3 text-body">
        <span className="font-medium text-text-default">
          {placeholder ? <SkLine className={nameWidth} /> : name}
        </span>
        <span className="font-medium text-text-default tabular-nums">
          {placeholder ? <SkLine className={rightWidth} /> : right}
        </span>
      </p>
      <Meter percent={placeholder ? null : percent} />
    </li>
  );
}

function CollectionBlock({
  part,
  stale,
  onRetry,
}: {
  part: Parts["collection"];
  stale: boolean;
  onRetry: () => void;
}) {
  const slot = useSlot(part);
  const placeholder = slot.placeholder || part.state === "loading";
  const view = placeholder ? null : valueOf(part);
  const summary = collectionSummary(view);
  const next = nextCollection(view);
  // 응답에 빠진 출처는 '확인 못 함'(실행 없음이라고 단정하지 않음)
  const rate = (value: number | null, known = true) =>
    !known
      ? h.unknown
      : value === null
        ? h.rateNone
        : fill(h.rateValue, { rate: value });
  const widths = ["w-[96px]", "w-[96px]", "w-[136px]"] as const;
  return (
    <section
      aria-labelledby="home-collection"
      className={`${ORDER.collection} ${slot.cls}`}
    >
      <div className={BLOCK_TITLE}>
        <h2 id="home-collection">{h.collectionTitle}</h2>
        {placeholder ? (
          <SkPill />
        ) : summary ? (
          summary.problems === 0 ? (
            <span className={`${BADGE} ${SUCCESS_BADGE}`}>
              {h.collectionOk}
            </span>
          ) : (
            <span className={`${BADGE} ${WARN_BADGE}`}>
              {fill(h.collectionProblem, { count: summary.problems })}
            </span>
          )
        ) : null}
      </div>
      <ValueLine
        part={part}
        placeholder={placeholder}
        width="w-[64px]"
        hintWidth="w-[88px]"
        stale={stale}
        value={summary ? rate(summary.rate) : null}
        hint={h.collectionRate}
      />
      <ul className="mt-4 flex flex-col gap-5">
        {widths.map((width, i) => {
          const row = summary?.rows[i];
          return (
            <BarRow
              key={i}
              placeholder={placeholder}
              name={row ? t.collection.source[row.job] : null}
              nameWidth={width}
              rightWidth="w-[96px]"
              percent={row ? row.rate : null}
              right={
                row && view ? (
                  <>
                    {rate(row.rate)}
                    {row.state !== "ok" &&
                      ` · ${t.collection.state[row.state]}`}
                    {row.lastSuccessAt && (
                      <span className="font-normal text-text-muted">
                        {" "}
                        · {kstClock(row.lastSuccessAt, view.generatedAt)}
                      </span>
                    )}
                  </>
                ) : (
                  t.stats.emptyValue
                )
              }
            />
          );
        })}
      </ul>
      {placeholder ? (
        <p className={FOOT}>
          <span className={FOOT_LINE}>
            <SkLine className="w-[200px] max-w-full h-[8px]" />
          </span>
        </p>
      ) : summary && view ? (
        <p className={FOOT}>
          {/* 판단 출처의 가장 이른 다음 수집(보드 '다음 수집 14:48이에요'). 없으면 고정 안내 */}
          {next
            ? fill(h.collectionNext, { time: kstClock(next, view.generatedAt) })
            : h.collectionFoot}{" "}
          <TextLink
            href="/collection/"
            className="inline-flex min-h-touch items-center text-caption lg:min-h-0"
          >
            {h.openCollection}
          </TextLink>
        </p>
      ) : (
        <BlockFailed part={part} onRetry={onRetry} />
      )}
    </section>
  );
}

function InquiriesBlock({
  part,
  stale,
  onRetry,
}: {
  part: Parts["inquiries"];
  stale: boolean;
  onRetry: () => void;
}) {
  const slot = useSlot(part);
  const placeholder = slot.placeholder || part.state === "loading";
  const page = placeholder ? null : valueOf(part);
  const summary = inquirySummary(page);
  // 최근 7일 값(GH-478). 칸이 없으면(undefined) 지금 표시(보관 중 합계·완료)를 유지
  const recent = inquiryWindow(page);
  const received7d = recent?.receivedLast7d;
  const resolved7d = recent?.resolvedLast7d;
  const rows = [
    { name: h.inquiryReceived, width: "w-[24px]", key: "received" },
    { name: h.inquiryInProgress, width: "w-[40px]", key: "inProgress" },
  ] as const;
  const count = (value: number | null) =>
    value === null ? h.unknown : fill(h.inquiriesValue, { count: value });
  return (
    <section
      aria-labelledby="home-inquiries"
      className={`${ORDER.inquiries} ${slot.cls}`}
    >
      <div className={BLOCK_TITLE}>
        <h2 id="home-inquiries">{h.inquiriesTitle}</h2>
        {placeholder ? (
          <SkPill />
        ) : (
          summary &&
          summary.received > 0 && (
            <span className={`${BADGE} ${NEW_BADGE}`}>
              {fill(h.inquiriesNew, { count: summary.received })}
            </span>
          )
        )}
      </div>
      <ValueLine
        part={part}
        placeholder={placeholder}
        width="w-[48px]"
        hintWidth="w-[72px]"
        stale={stale}
        value={
          summary
            ? received7d === undefined
              ? fill(h.inquiriesValue, { count: summary.total })
              : count(received7d)
            : null
        }
        hint={
          // 보드 '11건 최근 7일 접수'. 아래 줄의 /N(보관 중 합계)이 무엇인지 같은 줄에 붙임
          received7d === undefined || !summary
            ? h.inquiriesHint
            : `${h.inquiriesHint7d} · ${fill(h.inquiriesRetained, { count: summary.total })}`
        }
      />
      <ul className="mt-4 flex flex-col gap-5">
        {rows.map((row) => (
          <BarRow
            key={row.key}
            placeholder={placeholder}
            name={row.name}
            nameWidth={row.width}
            rightWidth="w-[32px]"
            percent={
              summary ? ratioPercent(summary[row.key], summary.total) : null
            }
            right={
              summary ? (
                <>
                  {summary[row.key]}
                  <span className="font-normal text-text-muted">
                    /{summary.total}
                  </span>
                </>
              ) : (
                t.stats.emptyValue
              )
            }
          />
        ))}
        {resolved7d === undefined ? (
          <BarRow
            placeholder={placeholder}
            name={h.inquiryResolved}
            nameWidth="w-[32px]"
            rightWidth="w-[32px]"
            percent={
              summary ? ratioPercent(summary.resolved, summary.total) : null
            }
            right={
              summary ? (
                <>
                  {summary.resolved}
                  <span className="font-normal text-text-muted">
                    /{summary.total}
                  </span>
                </>
              ) : (
                t.stats.emptyValue
              )
            }
          />
        ) : (
          // 최근 7일 완료 수. 보드의 '6/11'(÷ 최근 7일 접수)은 완료가 7일 전에 받은 문의를 포함해 묶음이 달라
          // 비율·막대를 만들지 않음(막대는 값 없음 표시)
          <BarRow
            placeholder={placeholder}
            name={h.inquiryResolved7d}
            nameWidth="w-[72px]"
            rightWidth="w-[32px]"
            percent={null}
            right={count(resolved7d)}
          />
        )}
      </ul>
      {placeholder ? (
        <p className={FOOT}>
          <span className={FOOT_LINE}>
            <SkLine className="w-[240px] max-w-full h-[8px]" />
          </span>
        </p>
      ) : summary ? (
        <p className={FOOT}>
          {recent && recent.oldest.state !== "absent"
            ? // 보드 '가장 오래된 접수 문의는 …'. 미처리가 없으면(0건) 줄을 두지 않음
              recent.oldest.state === "at"
              ? `${fill(h.inquiryOldest, { time: kstDateTime(recent.oldest.at) })} `
              : recent.oldest.state === "unknown"
                ? `${h.inquiryOldestUnknown} `
                : null
            : summary.rejected > 0 &&
              `${fill(h.inquiriesFoot, { count: summary.rejected })} `}
          <TextLink
            href="/inquiries/"
            className="inline-flex min-h-touch items-center text-caption lg:min-h-0"
          >
            {h.inquiriesOpen}
          </TextLink>
        </p>
      ) : (
        <BlockFailed part={part} onRetry={onRetry} />
      )}
    </section>
  );
}

// 사유 칸 글자: 범위 · 기관(게시본 첫 사유). 사유가 없으면 '사유 확인 못 함'
function reasonText(row: UndeterminedRow): string {
  const r = row.reason;
  if (!r || typeof r.scope !== "string" || r.scope === "") {
    return h.reasonUnknown;
  }
  return typeof r.source === "string" && r.source !== ""
    ? fill(h.reasonScope, { scope: r.scope, source: r.source })
    : r.scope;
}

// 언제 칸: 특보 확인 못 함은 마지막 확인 시각, 관측 지연은 측정 시각(게시본 시각과 같은 날이면 시:분만)
function whenText(row: UndeterminedRow, asOf: string): string {
  const time = reasonTime(row.reason);
  if (!time) return h.whenUnknown;
  return fill(time.kind === "confirmed" ? h.whenConfirmed : h.whenObserved, {
    time: kstClock(time.at, asOf),
  });
}

// 사유 배지: 게시본 사유 전부(첫 사유만 남기고 숨기지 않음). 범위·시각 칸은 첫 사유 기준
function Badges({ labels }: { labels: UndeterminedRow["labels"] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {labels.map((label, i) => (
        <Badge key={i} label={label} />
      ))}
    </span>
  );
}

// 자리표시 줄 길이(보드 L1 판단불가 표 3줄)
const UNDETERMINED_RHYTHM = [
  ["w-[56px]", "w-[32px]", "w-[104px]", "w-[80px]", "w-[48px]"],
  ["w-[72px]", "w-[40px]", "w-[104px]", "w-[96px]", "w-[56px]"],
  ["w-[48px]", "w-[32px]", "w-[72px]", "w-[72px]", "w-[40px]"],
] as const;

function UndeterminedTable({
  part,
  stale,
  onRetry,
  names,
}: {
  part: Parts["published"];
  stale: boolean;
  onRetry: () => void;
  names: Beaches;
}) {
  const slot = useSlot(part);
  const placeholder = slot.placeholder || part.state === "loading";
  const published = placeholder ? null : valueOf(part);
  const rows = undeterminedRows(published, names);
  // 언제 칸의 같은 날 판단 기준(게시본 시각). rows가 있으면 게시본도 있음
  const asOf = published?.generatedAt ?? "";
  const [page, setPage] = useState(0);
  const w = pageWindow(rows?.length ?? 0, page, UNDETERMINED_PAGE);
  const shown = rows?.slice(w.from - 1, w.to) ?? [];
  const head = (
    <>
      <th scope="col" className={TH}>
        {h.colBeach}
      </th>
      <th scope="col" className={TH}>
        {h.colDisplay}
      </th>
      <th scope="col" className={TH}>
        {h.colReason}
      </th>
      <th scope="col" className={`${TH} ${CELL_END}`}>
        {h.colWhen}
      </th>
    </>
  );
  return (
    <section
      aria-labelledby="home-undetermined"
      className={`${ORDER.undetermined} min-w-0 ${slot.cls}`}
    >
      <h2 id="home-undetermined" className={SECTION_TITLE}>
        {h.undeterminedTitle}
        {stale && <StaleMark />}
      </h2>
      {placeholder ? (
        <DataTable
          caption={h.undeterminedTitle}
          head={head}
          className="mt-3 hidden md:table"
        >
          {UNDETERMINED_RHYTHM.map((widths, i) => (
            <tr key={i} className={TR} aria-hidden="true">
              <td className={TD}>
                <span className="block text-body">
                  <SkLine className={widths[0]} />
                </span>
                <span className="block text-caption">
                  <SkLine className={`${widths[1]} h-[8px]`} />
                </span>
              </td>
              <td className={TD}>
                <SkPill className={`${widths[2]} h-6`} />
              </td>
              <td className={TD}>
                <SkLine className={widths[3]} />
              </td>
              <td className={`${TD} ${CELL_END}`}>
                <SkLine className={widths[4]} />
              </td>
            </tr>
          ))}
        </DataTable>
      ) : null}
      {placeholder && (
        // 모바일: 카드 3장 자리표시(값이 오면 같은 모양의 카드)
        <ul
          aria-hidden="true"
          className="mt-3 flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface md:hidden"
        >
          {UNDETERMINED_RHYTHM.map((widths, i) => (
            <li key={i} className="flex flex-col items-start gap-1 px-4 py-3">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className={CELL_NAME}>
                  <SkLine className={widths[0]} />
                </span>
                <span className="text-caption">
                  <SkLine className={`${widths[1]} h-[8px]`} />
                </span>
              </p>
              <SkPill className={`${widths[2]} h-6`} />
              <p className="text-body-s">
                <SkLine className={widths[3]} />
              </p>
            </li>
          ))}
        </ul>
      )}
      {placeholder ? null : rows === null ? (
        <BlockFailed
          part={part}
          onRetry={onRetry}
          className="mt-3 text-body-s"
        />
      ) : rows.length === 0 ? (
        <p className="mt-3 text-body-s text-text-body">{h.undeterminedNone}</p>
      ) : (
        <>
          <DataTable
            caption={h.undeterminedTitle}
            head={head}
            className="mt-3 hidden md:table"
          >
            {shown.map((row) => (
              <tr key={row.id} className={TR}>
                <td className={TD}>
                  <span className={`block ${CELL_NAME}`}>{rowName(row)}</span>
                  {row.region && (
                    <span className="block text-caption text-text-muted">
                      {row.region}
                    </span>
                  )}
                </td>
                <td className={TD}>
                  <Badges labels={row.labels} />
                </td>
                <td className={TD}>{reasonText(row)}</td>
                <td className={`${TD} ${CELL_END}`}>{whenText(row, asOf)}</td>
              </tr>
            ))}
          </DataTable>
          {/* 모바일: 표 대신 카드(값은 빼지 않음, 화면 설계서 6장 모바일 규칙) */}
          <ul className="mt-3 flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface md:hidden">
            {shown.map((row) => (
              <li key={row.id} className="flex flex-col items-start gap-1 px-4 py-3">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className={CELL_NAME}>{rowName(row)}</span>
                  {row.region && (
                    <span className="text-caption text-text-muted">
                      {row.region}
                    </span>
                  )}
                </p>
                <Badges labels={row.labels} />
                <p className="text-body-s text-text-body">
                  {reasonText(row)} · {whenText(row, asOf)}
                </p>
              </li>
            ))}
          </ul>
          {rows.length > UNDETERMINED_PAGE && (
            <Pager
              label={h.undeterminedPage}
              total={rows.length}
              page={w.page}
              onPage={setPage}
              size={UNDETERMINED_PAGE}
            />
          )}
        </>
      )}
    </section>
  );
}

// 할 일 자리표시 줄(보드 L1 할 일 3줄)
const TODO_RHYTHM = [
  ["w-[152px]", "w-[152px]", "w-[46px]"],
  ["w-[168px]", "w-[120px]", "w-[73px]"],
  ["w-[176px]", "w-[168px]", "w-[46px]"],
] as const;

function Todos({ parts }: { parts: Parts }) {
  const judgment = judgmentLine(valueOf(parts.collection));
  const received = inquirySummary(valueOf(parts.inquiries))?.received ?? null;
  const list = todos({
    judgment,
    received,
    notices: noticeCounts(valueOf(parts.notices)),
  });
  // 아직 받는 중인 칸이 있으면 '못 불러옴'·'할 일 없음' 대신 자리표시
  const pending = [parts.collection, parts.inquiries, parts.notices].some(
    (p) => p.state === "loading",
  );
  // 세 칸을 묶어 하나의 로딩 시간으로 봄
  const timing = useLoadTiming(pending);
  const cls = loadClass(timing);
  const loading = pending || timing.phase !== "content";
  const oldest = inquiryWindow(valueOf(parts.inquiries))?.oldest;
  const inProgress = inquirySummary(valueOf(parts.inquiries))?.inProgress ?? 0;
  // 줄 아래 보조 글: 판단 출처 문제는 출처·상태, 문의는 가장 오래된 미처리 접수 시각(응답에 있을 때만), 공지는 반영 안내
  const sub = (key: (typeof list.items)[number]["key"]): string | null => {
    if (key === "inquiries") {
      // 서버 값은 접수·확인 중을 함께 본 가장 오래된 미처리. 확인 중이 있으면 그 범위를 글로 밝힘
      return oldest?.state === "at"
        ? fill(
            inProgress > 0
              ? h.todoSub.inquiriesWithInProgress
              : h.todoSub.inquiries,
            { time: kstDateTime(oldest.at) },
          )
        : null;
    }
    if (key === "sources" && judgment) {
      return judgment.problems
        .map((p) =>
          fill(h.sourceItem, {
            source: t.collection.source[p.job],
            state: t.collection.state[p.state],
          }),
        )
        .join(" · ");
    }
    if (key === "notices") return h.todoSub.notices;
    return null;
  };
  return (
    <section
      aria-labelledby="home-todo"
      className={`${ORDER.todo} flex min-w-0 flex-col`}
    >
      <h2 id="home-todo" className={SECTION_TITLE}>
        {h.todoTitle}
      </h2>
      {loading ? (
        <ul aria-hidden="true" className={`mt-1 flex flex-col ${cls}`}>
          {TODO_RHYTHM.map(([title, note, button], i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-4 border-b border-border-default py-2"
            >
              <span className="leading-[1.4]">
                <span className="block text-body">
                  <SkLine className={title} />
                </span>
                <span className="block text-caption">
                  <SkLine className={`${note} h-[8px]`} />
                </span>
              </span>
              <span
                className={`sk inline-block h-touch shrink-0 rounded-admin-control lg:h-8 ${button}`}
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className={cls}>
          {list.items.length > 0 && (
            <ul className="mt-1 flex flex-col">
              {list.items.map((item) => {
                const title = fill(h.todo[item.key], { count: item.count });
                const note = sub(item.key);
                return (
                  <li
                    key={item.key}
                    className="flex items-center justify-between gap-4 border-b border-border-default py-2"
                  >
                    <span className="min-w-0 leading-[1.4]">
                      <span className="block text-body font-medium text-text-default">
                        {title}
                      </span>
                      {note && (
                        <span className="block text-caption text-text-muted">
                          {note}
                        </span>
                      )}
                    </span>
                    <Link href={item.href} className={SMALL_LINK}>
                      {h.todoAction[item.key]}
                      <span className="sr-only"> · {title}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {list.incomplete ? (
            <p role="status" className="mt-2 text-body-s text-text-body">
              {h.todoIncomplete}
            </p>
          ) : (
            list.items.length === 0 && (
              <p className="mt-2 text-body-s text-text-body">{h.todoNone}</p>
            )
          )}
        </div>
      )}
      {/* 해변 정보 PR 링크(시안에 없음, 기존 줄이라 남김) */}
      <div className="mt-3 flex flex-col gap-0.5">
        <a
          href={`${REPO_URL}/pulls`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-touch w-fit items-center text-label-s font-medium text-brand-default underline underline-offset-2 lg:min-h-0"
        >
          {h.beachPrs} <span className="sr-only">{h.newTab}</span>
        </a>
        <p className={HINT}>{h.beachPrsHint}</p>
      </div>
    </section>
  );
}

// 이용 칸 지표 하나(보드 V1 '사용자'·'화면 조회'): 제목 + 앞 기간 대비 배지, 값 + 오른쪽 '앞 28일 N'
// 일별 그래프(보드: 그래프 128 + 날짜 줄 24)는 응답에 일별 칸이 있을 때만(이용 통계 화면과 같은 기준)
// 앞 기간이 null(조회 실패)이거나 앞 값이 0이면 배지를 숨김. 좋고 나쁨 색은 쓰지 않음
function UsageMetric({
  part,
  placeholder,
  stale,
  label,
  value,
  width,
  showDaily,
  daily,
  unavailable,
  change,
  previousText,
}: {
  part: Parts["usage"];
  placeholder: boolean;
  stale: boolean;
  label: string;
  value: number | null;
  width: string;
  showDaily: boolean;
  // 일별 값. null이면 리포트를 못 받음
  daily: readonly ChartRow[] | null;
  unavailable: string;
  change: number | null;
  // '앞 28일 4,147'. 앞 기간이 없으면 null
  previousText: string | null;
}) {
  const data = valueOf(part);
  const known =
    data !== null &&
    data.configured &&
    data.period.status === "ok" &&
    value !== null;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-2">
        <h3 className="text-body font-bold text-text-default">{label}</h3>
        {!placeholder && known && change !== null && (
          <span
            className={`${BADGE} bg-bg-page font-medium text-text-body ring-1 ring-border-default ring-inset`}
          >
            <span className="sr-only">{t.stats.changeLabel} </span>
            {fill(t.stats.changeValue, {
              sign: change > 0 ? "+" : "",
              percent: change,
            })}
          </span>
        )}
        {showDaily && !placeholder && hasNull(daily) && (
          <span className="text-caption text-text-muted">
            {t.stats.nullLegend}
          </span>
        )}
      </div>
      <p className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-num-s font-normal text-text-default tabular-nums">
          {placeholder ? (
            <SkLine className={width} />
          ) : known ? (
            <>
              {value.toLocaleString("ko-KR")}
              {stale && <StaleMark />}
            </>
          ) : (
            h.unknown
          )}
        </span>
        {!placeholder && previousText && (
          <span className="text-label-s text-text-muted tabular-nums">
            {previousText}
          </span>
        )}
      </p>
      {showDaily && (
        <div className="mt-6 h-[152px]">
          {placeholder ? (
            <SkChart className="h-full" />
          ) : daily === null ? (
            <p className="flex h-full items-center justify-center rounded-admin-box border border-dashed border-border-strong px-4 text-center text-body-s text-text-body">
              {unavailable}
            </p>
          ) : (
            <BarChart
              rows={daily}
              bars="h-[128px]"
              head={t.stats.chartTableDate}
              valueHead={label}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Usage({
  part,
  stale,
  onRetry,
}: {
  part: Parts["usage"];
  stale: boolean;
  onRetry: () => void;
}) {
  const slot = useSlot(part);
  const placeholder = slot.placeholder || part.state === "loading";
  const data = placeholder ? null : valueOf(part);
  // 칸 유무는 마지막으로 받은 응답 기준. 받은 응답이 없으면 받는 중에만 지금 서버가 주는 칸 모두(자리표시 크기),
  // 불러오지 못했으면 그래프 칸을 두지 않음(칸 실패 줄 하나로 알림)
  const last = valueOf(part);
  const period =
    data?.configured && data.period.status === "ok" ? data.period : null;
  // 기간 추이(GH-477). 기간 통계와 따로 옴
  const trends = data?.configured ? (data.trends ?? null) : null;
  const shape = last
    ? statsShape(last.configured ? last.trends : undefined)
    : part.state === "loading"
      ? SHAPE_ALL
      : statsShape(undefined);
  const daily = trends?.daily?.rows ?? null;
  const previous = trends?.previous ?? null;
  const unavailable = trendUnavailable(trends);
  const previousText = (v: number | null) =>
    previous
      ? fill(t.stats.previousValue, {
          label: t.stats.previousLabel[USAGE_RANGE],
          value: v === null ? t.stats.emptyValue : v.toLocaleString("ko-KR"),
        })
      : null;
  // 기간 표시(보드 '10월 6일 – 11월 2일 · 앞 28일과 비교'): 응답의 KST 날짜. 추이가 없으면 고정 문구
  const rangeText =
    trendRangeText(trends, USAGE_RANGE, t.stats.subtitleSeparator) ??
    h.usageRange;
  const live =
    data && data.realtime.status === "ok" && data.realtime.activeUsers !== null
      ? fill(h.usageLive, {
          count: data.realtime.activeUsers.toLocaleString("ko-KR"),
        })
      : h.usageLiveUnknown;
  return (
    <section
      aria-labelledby="home-usage"
      className={`${ORDER.usage} ${slot.cls}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="home-usage" className="text-title-l font-semibold">
          {h.usageTitle}
        </h2>
        <span className="text-label-s text-text-body">
          {placeholder ? <SkLine className="w-[200px] h-[8px]" /> : live}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-default pb-4 text-body-s">
        <span className="text-text-body">
          {placeholder ? <SkLine className="w-[232px] h-[8px]" /> : rangeText}
        </span>
        {/* 이용 칸 자기 기준 시각: GA 집계를 받은 시각(서버 5분 저장 포함). 머리의 1분 주기와 따로 5분마다 */}
        {placeholder ? (
          <span>
            <SkLine className="w-[176px] h-[8px]" />
          </span>
        ) : (
          data && (
            <span className="text-text-muted">
              {fill(h.usageAsOf, { time: hourMinute(data.fetchedAt) })}
            </span>
          )
        )}
        <TextLink
          href="/stats/"
          className="inline-flex min-h-touch items-center lg:min-h-0"
        >
          {h.usageOpen}
        </TextLink>
        {/* 응답에 일별 칸이 없으면 그래프 대신 한 줄(받는 중에는 같은 줄 높이 자리표시) */}
        {!shape.daily &&
          (placeholder ? (
            <span className="basis-full">
              <SkLine className="w-[220px] max-w-full h-[8px]" />
            </span>
          ) : (
            data?.configured && (
              <span className="basis-full text-text-body">
                {h.usageDailyMissing}
              </span>
            )
          ))}
      </div>
      {!placeholder && part.state !== "ok" && (
        <BlockFailed
          part={part}
          onRetry={onRetry}
          className="mt-3 text-body-s"
        />
      )}
      {data && !data.configured && (
        <p role="status" className="mt-3 text-body-s text-text-body">
          {h.usageUnconfigured}
        </p>
      )}
      {/* 응답은 왔지만 GA 기간 통계를 못 받음: 무슨 일·영향·다시 시도(값은 '확인 못 함') */}
      {data && data.configured && data.period.status === "unavailable" && (
        <BlockFailed
          part={part}
          onRetry={onRetry}
          className="mt-3 text-body-s"
          message={h.usagePeriodFailed}
        />
      )}
      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <UsageMetric
          part={part}
          placeholder={placeholder}
          stale={stale}
          label={h.usageUsers}
          value={data?.period.activeUsers ?? null}
          width="w-[56px]"
          showDaily={shape.daily}
          daily={
            daily?.map((d) => ({
              key: d.date,
              label: shortDate(d.date),
              value: d.activeUsers,
            })) ?? null
          }
          unavailable={unavailable}
          change={changePercent(
            period?.activeUsers ?? null,
            previous?.activeUsers ?? null,
          )}
          previousText={previousText(previous?.activeUsers ?? null)}
        />
        <UsageMetric
          part={part}
          placeholder={placeholder}
          stale={stale}
          label={h.usageViews}
          value={data?.period.pageViews ?? null}
          width="w-[72px]"
          showDaily={shape.daily}
          daily={
            daily?.map((d) => ({
              key: d.date,
              label: shortDate(d.date),
              value: d.pageViews,
            })) ?? null
          }
          unavailable={unavailable}
          change={changePercent(
            period?.pageViews ?? null,
            previous?.pageViews ?? null,
          )}
          previousText={previousText(previous?.pageViews ?? null)}
        />
      </div>
    </section>
  );
}

// 기준 시각 줄의 시:분(서울)
function hourMinute(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  }).format(new Date(iso));
}

// 머리 오른쪽(보드 V1: '… 기준 · 화면이 보이는 동안 1분마다 다시 읽어요' + 아래 세션 안내)
// - 첫 줄: 기준 시각(다시 읽는 동안 회전 표시). 처음 받기 전에는 같은 줄 높이 자리표시
//   5초 넘게 받는 칸이 있으면 첫 줄 자리에 느림 안내(GH-462 후속: 제목 줄에 겹쳐 띄우지 않고 같은 줄을 바꿔 높이 그대로)
// - 둘째 줄: 세션 안내(결정 기록 D17-11 문구, 보드의 옛 '새로고침하면 다시 로그인'이 아님)
// - 다시 읽기가 실패한 칸이 있으면 '마지막으로 받은 값이에요 · HH:MM 기준' + 다시 시도(보드 LP ⑤)
function HeadNote({
  at,
  refreshing,
  slow,
  pending,
  stale,
  onRetry,
}: {
  at: string | null;
  // 아직 받는 중(첫 줄 자리표시)
  pending: boolean;
  refreshing: boolean;
  slow: boolean;
  stale: { iso: string; sameDay: boolean } | null;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col text-label-s text-text-muted lg:max-w-[40rem] lg:items-end lg:text-right">
      <p className="flex flex-wrap items-center gap-x-1.5 lg:justify-end">
        {slow ? (
          <span>{t.loading.slow}</span>
        ) : at === null ? (
          // 세션 확인 실패 등으로 칸을 읽지 않으면 자리표시도 두지 않음(로딩이 끝남)
          pending && (
            // 줄 높이를 지키려고 span으로 감쌈(flex 항목이면 8px 높이만 남음)
            <span>
              <SkLine className="w-[360px] max-w-full h-[8px]" />
            </span>
          )
        ) : (
          <>
            <span>{fill(h.asOf, { time: kstDateTime(at) })}</span>
            {refreshing && (
              <span className="inline-flex items-center gap-1 text-brand-default">
                <Spinner />
                {t.loading.refreshing}
              </span>
            )}
          </>
        )}
      </p>
      <p className="text-caption">{t.session.refreshNote}</p>
      {stale && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-3 font-medium text-text-default lg:justify-end"
        >
          {fill(t.loading.stale, {
            time: stale.sameDay
              ? hourMinute(stale.iso)
              : kstDateTime(stale.iso),
          })}
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex min-h-touch items-center font-medium text-brand-default underline underline-offset-2 lg:min-h-0"
          >
            {t.loading.retry}
          </button>
        </p>
      )}
    </div>
  );
}

function HomeBody({ beaches }: { beaches: Beaches }) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const signedIn = snapshot.status !== "signed_out";
  const owner = badgeOwner(snapshot);
  const demo = signedIn && snapshot.pool === "demo";
  const [me, setMe] = useState<OpsResult<Me> | null>(null);
  const [parts, setParts] = useState<Parts>(INITIAL);
  // 다시 읽은 결과를 앞 값과 견주려고 마지막으로 그린 칸 값을 둠
  const latest = useRef(parts);
  useEffect(() => {
    latest.current = parts;
  }, [parts]);
  // 마지막으로 모든 칸을 다 받은 시각(기준 시각). 아직 한 번도 다 받지 못했으면 null
  const [at, setAt] = useState<string | null>(null);
  // 다시 읽기가 실패해 앞 값을 두고 있는 칸(그 칸에 '마지막으로 받은 값', 머리에 '마지막으로 받은 값이에요' 줄)
  const [stale, setStale] = useState<ReadonlySet<keyof Parts>>(new Set());
  // 칸마다 마지막으로 값을 받은 시각(앞 값을 둔 칸의 기준 시각)
  const [receivedAt, setReceivedAt] = useState<
    Partial<Record<keyof Parts, string>>
  >({});
  // 읽는 중(첫 읽기 뒤에는 기준 시각 옆 회전 표시)
  const [reading, setReading] = useState(false);
  // 게시본을 받은 시각. 유효 시각 지남을 이 시각 기준으로 셈(그리는 중에 시계를 읽지 않음)
  const [publishedAt, setPublishedAt] = useState(0);
  const [attempt, setAttempt] = useState(0);
  // 요약 칸만 다시 읽기(/ops/me 확인을 다시 하지 않아 화면·포커스가 사라지지 않음)
  const [round, setRound] = useState(0);

  // 세션 확인(첫 진입) 중에는 부르지 않음. 그동안은 자리표시만
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    // 15초(D26-4) 안에 답이 없으면 운영 서버 오류로 보임(자리표시가 끝없이 남지 않게, 다시 시도 가능)
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<OpsResult<Me>>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({ ok: false, status: 0, code: "timeout", requestId: null }),
        LOADING_TIMES.timeout,
      );
    });
    void Promise.race([
      opsFetch<Me>("/ops/me", () => session.accessToken()),
      timedOut,
    ]).then((result) => {
      clearTimeout(timer);
      if (live) setMe(result);
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [session, signedIn, attempt]);

  // 서버가 세션을 받아 준 뒤에만 읽음. 화면이 보이는 동안만 60초마다 다시 읽음(D16-E1)
  // 숨겨졌던 탭이 다시 보일 때 마지막 읽기가 60초를 넘었으면 바로 다시 읽음(바로 뒤 주기와 겹쳐 두 번 읽지 않게 간격을 봄)
  // 데모 계정은 자동으로 다시 읽지 않음: 데모 조회는 서버가 모두 sample.read로 기록해 60초마다 기록이 쌓임
  // 읽기가 60초보다 오래 걸려 겹치면 늦게 끝난 앞 읽기가 새 값을 덮지 않게 칸마다 순번으로 거름
  // 로그아웃·세션 만료 뒤에는 앞 세션의 확인 결과로 다시 읽지 않음
  const ready = signedIn && me?.ok === true;
  useEffect(() => {
    if (!ready) return;
    let live = true;
    let started = 0;
    let lastStart = 0;
    const shown: Partial<Record<keyof Parts, number>> = {};
    const load = loaders(() => session.accessToken(), owner);
    // 이용 칸을 마지막으로 부른 시각(이 읽기 묶음 안에서만. 다시 시도하면 묶음이 새로 시작해 바로 부름)
    let usageStart = 0;
    const refresh = () => {
      const id = ++started;
      lastStart = Date.now();
      setReading(true);
      const keys = (Object.keys(load) as (keyof Parts)[]).filter(
        (key) =>
          key !== "usage" || lastStart - usageStart >= USAGE_REFRESH_MS - 1_000,
      );
      if (keys.includes("usage")) usageStart = lastStart;
      void Promise.all(
        keys.map((key) =>
          load[key]().then((part) => {
            if (!live || id < (shown[key] ?? 0)) return;
            shown[key] = id;
            if (key === "published" && part.state === "ok") {
              setPublishedAt(Date.now());
            }
            if (part.state === "ok") {
              const now = new Date().toISOString();
              setReceivedAt((old) => ({ ...old, [key]: now }));
            }
            // 이 칸은 이번 읽기만 바꾸므로 마지막으로 그린 값과 견주면 됨
            // 판단 출처 상태(수집 현황)는 앞의 '정상'을 두지 않고 실패를 그대로 보임(조회 실패를 정상으로 두지 않음)
            const merged = mergePart(
              latest.current[key] as Slot<unknown>,
              part,
              key !== "collection",
            );
            setStale((old) => {
              if (merged.stale === old.has(key)) return old;
              const next = new Set(old);
              if (merged.stale) next.add(key);
              else next.delete(key);
              return next;
            });
            if (!merged.stale) setParts((prev) => ({ ...prev, [key]: part }));
          }),
        ),
      ).then(() => {
        if (!live || id !== started) return;
        setReading(false);
        // 기준 시각은 이번 읽기를 마친 시각. 앞 값을 둔 칸은 그 칸의 받은 시각을 따로 보임
        setAt(new Date().toISOString());
      });
    };
    refresh();
    if (demo) {
      return () => {
        live = false;
      };
    }
    // 주기 타이머는 약간 일찍 울릴 수 있어 1초 여유를 둠
    const due = () =>
      document.visibilityState === "visible" &&
      Date.now() - lastStart >= REFRESH_MS - 1_000;
    const timer = window.setInterval(() => {
      if (due()) refresh();
    }, REFRESH_MS);
    const onVisible = () => {
      if (due()) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, session, owner, demo, attempt, round]);

  // 서버 세션 확인부터 다시(운영 서버 오류 알림의 다시 시도)
  const load = () => {
    setMe(null);
    setAttempt((n) => n + 1);
  };
  // 요약 칸만 다시 읽음. 받은 값은 그대로 두고, 실패한 칸만 다시 자리표시로(같은 칸 안에서 다시 시도)
  const reload = () => {
    setParts((prev) => {
      const next = { ...prev } as Record<keyof Parts, Slot<unknown>>;
      for (const key of Object.keys(prev) as (keyof Parts)[]) {
        if (prev[key].state === "failed") next[key] = LOADING;
      }
      return next as unknown as Parts;
    });
    setRound((n) => n + 1);
  };

  // 서버 세션 확인이 실패하면 칸을 읽지 않으므로 로딩도 끝(알림만 남음)
  // 로그아웃·세션 만료 뒤(로그인 화면으로 가는 중)에는 받아 둔 운영 데이터를 그리지 않고 첫 진입과 같은 자리표시만
  // (세션 확인 중 틀과 같은 요소라 상태가 남아 있음, Codex 지적)
  const view = signedIn
    ? { me, parts, at, stale }
    : { me: null, parts: INITIAL, at: null, stale: NO_STALE };
  const anyLoading =
    !signedIn ||
    view.me === null ||
    (view.me.ok &&
      Object.values(view.parts).some(
        (p: Slot<unknown>) => p.state === "loading",
      ));
  // 5초 넘게 받는 칸이 있으면 머리 첫 줄 자리에 느림 안내(칸 높이를 바꾸지 않게 한 자리에서)
  const page = useLoadTiming(anyLoading);
  // 서버 세션 확인 전·확인됨이면 칸을 그림(확인 전에는 모두 자리표시). 확인 실패면 알림만
  const showParts = !view.me || view.me.ok;

  return (
    <>
      {/* 알림 영역은 aria-busy 영역 밖에 둠(바쁜 동안 읽기를 미루는 화면 읽기도 바로 읽게)
          세션 확인 중에는 공통 틀이 '운영 화면 여는 중'을 알림 → 여기서는 그 뒤 한 번만 */}
      <LoadingStatus
        busy={signedIn && anyLoading}
        label={fill(t.loading.screen, { name: h.title })}
      />
      <span role="status" className="sr-only">
        {page.slow ? t.loading.slow : ""}
      </span>
      <main
        aria-busy={anyLoading || undefined}
        className="flex w-full flex-col px-4 py-5 md:px-10 md:pt-6 md:pb-10"
      >
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-title-l font-semibold text-text-default">
              {h.title}
            </h1>
          </div>
          <HeadNote
            at={showParts ? view.at : null}
            refreshing={reading && view.at !== null}
            slow={page.slow}
            pending={anyLoading}
            stale={
              view.at === null
                ? null
                : staleSince(
                    [...view.stale].map((key) => receivedAt[key]),
                    view.at,
                  )
            }
            onRetry={reload}
          />
        </div>
        {view.me && !view.me.ok && view.me.code === "sample_not_allowed" && (
          <div className="mt-6">
            <Notice tone="warn" title={h.demoPeriod} role="alert">
              {h.demoPeriodHint}
            </Notice>
          </div>
        )}
        {view.me &&
          !view.me.ok &&
          view.me.code !== "sample_not_allowed" &&
          view.me.code !== "reauth" && (
            <div className="mt-6">
              <Notice tone="fail" title={h.serverError} role="alert">
                {"requestId" in view.me && view.me.requestId && (
                  <p>{fill(h.requestId, { id: view.me.requestId })}</p>
                )}
                <Button
                  variant="secondary"
                  size="small"
                  className="mt-2"
                  onClick={load}
                >
                  {h.retry}
                </Button>
              </Notice>
            </div>
          )}
        {showParts && (
          <>
            {/* 판단 출처 상태 한 줄(화면 설계서 ADM-HOME '맨 위 한 줄', 시안 V1에는 없음)
                PC(lg)는 왼쪽 메뉴 상태 칸이 같은 내용을 보여 숨김. 모바일·태블릿만 */}
            <div className="mt-6 lg:hidden">
              <SourcesLine part={view.parts.collection} onRetry={reload} />
            </div>
            {/* 모바일은 한 줄로 쌓고 보드 LM1 순서(order), PC는 보드 V1 격자 */}
            <div className="mt-6 flex flex-col gap-7 lg:gap-6">
              <div className="contents lg:grid lg:grid-cols-3 lg:gap-8">
                <BeachesBlock
                  part={view.parts.published}
                  stale={view.stale.has("published")}
                  nowMs={publishedAt}
                  onRetry={reload}
                  names={beaches}
                />
                <CollectionBlock
                  part={view.parts.collection}
                  stale={view.stale.has("collection")}
                  onRetry={reload}
                />
                <InquiriesBlock
                  part={view.parts.inquiries}
                  stale={view.stale.has("inquiries")}
                  onRetry={reload}
                />
              </div>
              <div className="contents lg:grid lg:grid-cols-[1.5fr_1fr] lg:gap-8">
                <UndeterminedTable
                  part={view.parts.published}
                  stale={view.stale.has("published")}
                  onRetry={reload}
                  names={beaches}
                />
                <Todos parts={view.parts} />
              </div>
              <Usage
                part={view.parts.usage}
                stale={view.stale.has("usage")}
                onRetry={reload}
              />
            </div>
          </>
        )}
      </main>
    </>
  );
}

export function HomeScreen({ beaches }: { beaches: Beaches }) {
  // 세션 확인 중(첫 진입)에도 같은 요소를 그려 자리표시를 이어서 씀(보드 L10)
  const body = <HomeBody beaches={beaches} />;
  return (
    <AdminShell title={messages.home.title} loading={body}>
      {body}
    </AdminShell>
  );
}
