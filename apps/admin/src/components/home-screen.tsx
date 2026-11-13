"use client";

import { useEffect, useRef, useState } from "react";
import { opsFetch, type OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import { fetchAudit, periodFilter } from "@/lib/audit";
import {
  fetchPublished,
  parsePublished,
  REPO_URL,
  type PublishedView,
} from "@/lib/beaches";
import { fetchCollection, type CollectionView } from "@/lib/collection";
import {
  expiredCount,
  judgmentLine,
  mergePart,
  noticeCounts,
  partOf,
  receivedCount,
  recentChanges,
  settle,
  todos,
  undeterminedCount,
  valueOf,
  type RecentView,
  type Slot,
} from "@/lib/home";
import { badgeOwner, setReceivedCount } from "@/lib/inquiry-badge";
import { fetchInquiries, kstDateTime } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import { fetchNotices, type NoticeView } from "@/lib/notices";
import { roleLabel } from "@/lib/roles";
import { AdminShell } from "./admin-shell";
import { kindBadge, summaryOf, Target, type Beaches } from "./audit-screen";
import {
  loadClass,
  LoadingStatus,
  SkLine,
  SlowNote,
  Spinner,
  useLoadTiming,
} from "./loading";
import { Button, Notice, TextLink } from "./ui";

// 운영 홈 (BRD-149, 화면 설계서 6장 ADM-HOME). 로그인 뒤 /ops/me로 서버가 이 세션을 받아 주는지 먼저 확인함
// 데모 계정이 허용 기간 밖이면 서버가 403(sample_not_allowed) → 화면에서도 막힘을 알림(D16-A8, 캔버스 E11-4)
// - 맨 위 한 줄: 판단에 쓰는 출처 상태. 하나라도 정상이 아니면 문제 줄(내부 화면이라 출처 이름을 씀)
//   사용자 화면 배너 문구(12장 결정 1 '확인된 판단 없음')는 여기서 바꾸지 않음
// - 요약 카드·할 일·최근 변경은 이미 있는 운영 API(수집 현황·게시본·문의·공지·변경 이력)를 모아 보여 줌
// - 못 읽은 값은 0·정상·'할 일 없음'으로 바꾸지 않고 '확인 못 함'. 다시 읽는 동안은 앞 값을 그대로 둠
// - 화면이 보이는 동안 60초마다 다시 읽음(D16-E1 운영 홈 60초)
// - 로딩(GH-462, 보드 L0·LS·LP 시범 적용): 칸마다 값과 같은 크기 자리표시(150ms 뒤 · 최소 400ms · 0.18초 페이드)
//   다시 읽는 동안은 값을 두고 기준 시각 옆에 회전 표시. 다시 읽기가 실패한 칸은 앞 값을 두고 '마지막으로 받은 값' 줄
//   세션 확인 중(첫 진입)에도 같은 요소를 그려 확인이 끝나면 자리표시를 이어서 씀(AdminShell loading)

const t = messages;
const h = messages.home;
const REFRESH_MS = 60_000;
const RECENT_COUNT = 5;
// 최근 변경 자리표시 행 길이(행마다 다르게, RECENT_COUNT개)
const RECENT_RHYTHM = [
  "w-[72%]",
  "w-[60%]",
  "w-[84%]",
  "w-[52%]",
  "w-[66%]",
] as const;

const CARD =
  "flex flex-col gap-1 rounded-admin-box border border-border-default bg-bg-surface px-4 py-3";
const LABEL = "text-label-s font-medium text-text-body";
const VALUE = "text-title-l font-semibold text-text-default tabular-nums";
const HINT = "text-label-s text-text-muted";
// 할 일 안내 한 줄(0건·확인 못 함): 자리표시 한 행 상자(행 44 + 위아래 테두리 2)와 같은 최소 높이 → 응답 뒤 밀리지 않음
const TODO_LINE =
  "flex min-h-[calc(var(--spacing-touch)+2px)] items-center text-body-s text-text-body";

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
  readonly inquiries: Slot<number>;
  readonly notices: Slot<readonly NoticeView[]>;
  readonly recent: Slot<RecentView>;
}

const LOADING = { state: "loading" } as const;
const INITIAL: Parts = {
  collection: LOADING,
  published: LOADING,
  inquiries: LOADING,
  notices: LOADING,
  recent: LOADING,
};

type Token = () => Promise<string | null>;

const FORBIDDEN: OpsResult<never> = {
  ok: false,
  status: 403,
  code: "forbidden",
  requestId: null,
};

type Loaders = {
  readonly [K in keyof Parts]: () => Promise<Exclude<Parts[K], typeof LOADING>>;
};

function loaders(token: Token, owner: string | null, demo: boolean): Loaders {
  const raw = {
    collection: async () => partOf(await fetchCollection(token), (b) => b),
    published: async () =>
      partOf(await fetchPublished(token), (body) => {
        const view = parsePublished(body);
        return view?.available ? view : null;
      }),
    inquiries: async () => {
      const part = partOf(await fetchInquiries(token, { limit: 1 }), (body) =>
        receivedCount(body),
      );
      // 왼쪽 메뉴 '문의' 배지도 같은 값으로 맞춤
      if (owner && part.state === "ok") setReceivedCount(owner, part.value);
      return part;
    },
    notices: async () =>
      partOf(await fetchNotices(token), (body) =>
        Array.isArray(body?.items) ? body.items : null,
      ),
    recent: async () =>
      partOf(
        // 데모 계정은 변경 이력을 볼 수 없음(ADM-AUD 보기(샘플 제외)) → 요청하지 않음
        demo
          ? FORBIDDEN
          : await fetchAudit(token, periodFilter(7, Date.now()), null, false),
        // 조회 기록을 빼고도 몇 건이 남게 한 쪽(20건)을 받아 거름
        (body) =>
          Array.isArray(body?.items)
            ? recentChanges(body.items, RECENT_COUNT)
            : null,
      ),
  };
  // 칸마다 시간 제한(15초, D26-4)·예외 처리(멈춘 칸이 '불러오는 중'에 머물지 않게)
  return {
    collection: () => settle(raw.collection),
    published: () => settle(raw.published),
    inquiries: () => settle(raw.inquiries),
    notices: () => settle(raw.notices),
    recent: () => settle(raw.recent),
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
        {/* 안내 문구의 '다시 시도'. 아래 '일부 정보' 알림은 수집 현황 실패를 세지 않아 여기 둠 */}
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

function Value({
  part,
  width = "w-[56px]",
  children,
}: {
  part: Slot<unknown>;
  // 자리표시 너비 클래스(예상 값 길이)
  width?: string;
  children: React.ReactNode;
}) {
  const slot = useSlot(part);
  if (slot.placeholder || part.state === "loading") {
    return (
      <dd className={`${VALUE} ${slot.cls}`}>
        <SkLine className={width} />
      </dd>
    );
  }
  if (part.state === "ok") {
    return <dd className={`${VALUE} ${slot.cls}`}>{children}</dd>;
  }
  return (
    <dd className={`${VALUE} text-title-s ${slot.cls}`}>
      {part.state === "forbidden" ? h.forbidden : h.unknown}
    </dd>
  );
}

// 카드 아래 보조 줄(값에 따라 바뀌는 것만 자리표시. 고정 설명은 바로 그림)
function Hint({
  part,
  width,
  children,
}: {
  part: Slot<unknown>;
  // 자리표시 너비 클래스
  width: string;
  children: React.ReactNode;
}) {
  const slot = useSlot(part);
  return (
    <dd className={`${HINT} ${slot.cls}`}>
      {slot.placeholder || part.state === "loading" ? (
        <SkLine className={width} />
      ) : (
        children
      )}
    </dd>
  );
}

function Summary({ parts, nowMs }: { parts: Parts; nowMs: number }) {
  const published = valueOf(parts.published);
  const notices = noticeCounts(valueOf(parts.notices));
  const expired = expiredCount(published, nowMs);
  return (
    <dl
      aria-label={h.summaryLabel}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4"
    >
      <div className={CARD}>
        <dt className={LABEL}>{h.kpiInquiries}</dt>
        <Value part={parts.inquiries}>
          {fill(h.kpiInquiriesValue, { count: valueOf(parts.inquiries) ?? 0 })}
        </Value>
        <dd className={HINT}>{h.kpiInquiriesHint}</dd>
      </div>
      <div className={CARD}>
        <dt className={LABEL}>{h.kpiUndetermined}</dt>
        {/* 게시본을 읽지 못하면(available: false 포함) 0곳이 아니라 확인 못 함 */}
        <Value part={parts.published}>
          {fill(h.kpiUndeterminedValue, {
            count: undeterminedCount(published) ?? 0,
          })}
        </Value>
        <dd className={HINT}>{h.kpiUndeterminedHint}</dd>
        {/* 분류는 그대로 두고 유효 시각 지남을 따로 알림(해변 관리와 같은 기준, 화면에서 다시 분류하지 않음) */}
        {expired !== null && expired > 0 && (
          <dd className="text-label-s font-medium text-text-default">
            {fill(h.kpiExpired, { count: expired })}
          </dd>
        )}
        {/* 점검 중이면 앱이 해변 상태를 숨김. 개수는 마지막 게시본 그대로(D23-11) */}
        {published?.maintenance.active && (
          <dd className="text-label-s font-medium text-text-default">
            {h.kpiMaintenance}
          </dd>
        )}
      </div>
      <div className={CARD}>
        <dt className={LABEL}>{h.kpiPublish}</dt>
        <Value part={parts.published} width="w-[120px]">
          {published ? kstDateTime(published.generatedAt) : null}
        </Value>
        <Hint part={parts.notices} width="w-[180px]">
          {notices
            ? fill(h.kpiNotices, {
                scheduled: notices.scheduled,
                pending: notices.pendingEdit,
              })
            : h.kpiNoticesUnknown}
        </Hint>
      </div>
      <div className={CARD}>
        <dt className={LABEL}>{h.kpiUsers}</dt>
        {/* 이용 통계(GA Data API, #333) 연결 전. 숫자를 지어내지 않음 */}
        <dd className={`${VALUE} text-title-s`}>{h.kpiUsersValue}</dd>
        <dd className={HINT}>{h.kpiUsersHint}</dd>
      </div>
    </dl>
  );
}

function Todos({ parts }: { parts: Parts }) {
  const list = todos({
    judgment: judgmentLine(valueOf(parts.collection)),
    received: valueOf(parts.inquiries),
    notices: noticeCounts(valueOf(parts.notices)),
  });
  // 아직 받는 중인 칸이 있으면 '못 불러옴'·'할 일 없음' 대신 자리표시(할 일 한 행 상자)
  const pending = [parts.collection, parts.inquiries, parts.notices].some(
    (p) => p.state === "loading",
  );
  const slot = useSlot(pending ? { state: "loading" } : { state: "forbidden" });
  const loading = pending || slot.placeholder;
  return (
    <section aria-labelledby="home-todo" className="flex flex-col gap-2">
      <h2
        id="home-todo"
        className="text-title-s font-semibold text-text-default"
      >
        {h.todoTitle}
      </h2>
      {!loading && list.items.length > 0 && (
        <ul
          className={`flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface ${slot.cls}`}
        >
          {list.items.map((item) => (
            <li key={item.key} className="px-4">
              <TextLink
                href={item.href}
                className="flex min-h-touch items-center font-medium underline"
              >
                {fill(h.todo[item.key], { count: item.count })}
              </TextLink>
            </li>
          ))}
        </ul>
      )}
      {loading ? (
        // 할 일 한 행 상자와 같은 높이(0건·확인 못 함 안내 줄도 같은 최소 높이, TODO_LINE)
        <ul
          aria-hidden="true"
          className={`flex flex-col rounded-admin-box border border-border-default bg-bg-surface ${slot.cls}`}
        >
          <li className="flex min-h-touch items-center px-4 text-label-s">
            <SkLine className="w-[180px]" />
          </li>
        </ul>
      ) : list.incomplete ? (
        <p role="status" className={`${TODO_LINE} ${slot.cls}`}>
          {h.todoIncomplete}
        </p>
      ) : (
        list.items.length === 0 && (
          <p className={`${TODO_LINE} ${slot.cls}`}>{h.todoNone}</p>
        )
      )}
      <div className="flex flex-col gap-0.5">
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

function Recent({
  part,
  beaches,
}: {
  part: Slot<RecentView>;
  beaches: Beaches;
}) {
  const slot = useSlot(part);
  const placeholder = slot.placeholder || part.state === "loading";
  return (
    <section aria-labelledby="home-recent" className="flex flex-col gap-2">
      <h2
        id="home-recent"
        className="text-title-s font-semibold text-text-default"
      >
        {h.recentTitle}
      </h2>
      {placeholder && (
        // 한 쪽 행 수(5)만큼, 행 높이 그대로. 길이는 정해진 리듬으로 바꿈
        <ul
          aria-hidden="true"
          className={`flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface ${slot.cls}`}
        >
          {RECENT_RHYTHM.map((width, i) => (
            <li key={i} className="px-4 py-2.5 text-body-s">
              <SkLine className={width} />
            </li>
          ))}
        </ul>
      )}
      {!placeholder && part.state === "forbidden" && (
        <p className={`text-body-s text-text-body ${slot.cls}`}>
          {h.recentForbidden}
        </p>
      )}
      {!placeholder && part.state === "failed" && (
        <p role="status" className={`text-body-s text-text-body ${slot.cls}`}>
          {h.recentFailed}
        </p>
      )}
      {!placeholder && part.state === "ok" && part.value.items.length === 0 && (
        <p className={`text-body-s text-text-body ${slot.cls}`}>
          {part.value.onlyReads ? h.recentOnlyReads : h.recentNone}
        </p>
      )}
      {!placeholder && part.state === "ok" && part.value.items.length > 0 && (
        <ul
          className={`flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface ${slot.cls}`}
        >
          {/* 종류·대상·요약은 변경 이력 화면과 같은 표시(audit-screen) */}
          {part.value.items.map((item) => (
            <li
              key={`${item.at}|${item.requestId}`}
              className="flex flex-wrap items-baseline gap-x-2 px-4 py-2.5 text-body-s"
            >
              <span className="tabular-nums text-text-muted">
                {kstDateTime(item.at)}
              </span>
              <span className="font-medium text-text-default">
                {kindBadge(item)}
              </span>
              <Target item={item} beaches={beaches} />
              <span className="text-text-body">{summaryOf(item)}</span>
            </li>
          ))}
        </ul>
      )}
      {part.state !== "forbidden" && (
        <TextLink
          href="/audit/"
          className="inline-flex min-h-touch w-fit items-center font-medium underline lg:min-h-0"
        >
          {h.recentAll}
        </TextLink>
      )}
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
  // 다시 읽기가 실패해 앞 값을 두고 있는 칸('마지막으로 받은 값이에요' 줄)
  const [stale, setStale] = useState<ReadonlySet<keyof Parts>>(new Set());
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
    void opsFetch<Me>("/ops/me", () => session.accessToken()).then((result) => {
      if (live) setMe(result);
    });
    return () => {
      live = false;
    };
  }, [session, signedIn, attempt]);

  // 서버가 세션을 받아 준 뒤에만 읽음. 화면이 보이는 동안만 60초마다 다시 읽음(D16-E1)
  // 숨겨졌던 탭이 다시 보일 때 마지막 읽기가 60초를 넘었으면 바로 다시 읽음(바로 뒤 주기와 겹쳐 두 번 읽지 않게 간격을 봄)
  // 데모 계정은 자동으로 다시 읽지 않음: 데모 조회는 서버가 모두 sample.read로 기록해 60초마다 기록이 쌓임
  // 읽기가 60초보다 오래 걸려 겹치면 늦게 끝난 앞 읽기가 새 값을 덮지 않게 칸마다 순번으로 거름
  const ready = me?.ok === true;
  useEffect(() => {
    if (!ready) return;
    let live = true;
    let started = 0;
    let lastStart = 0;
    const shown: Partial<Record<keyof Parts, number>> = {};
    const load = loaders(() => session.accessToken(), owner, demo);
    const refresh = () => {
      const id = ++started;
      lastStart = Date.now();
      setReading(true);
      // 이번 읽기에서 앞 값을 둔 칸이 있으면 기준 시각을 새로 잡지 않음(앞 값의 시각이 기준)
      let keptStale = false;
      const keys = Object.keys(load) as (keyof Parts)[];
      void Promise.all(
        keys.map((key) =>
          load[key]().then((part) => {
            if (!live || id < (shown[key] ?? 0)) return;
            shown[key] = id;
            if (key === "published" && part.state === "ok") {
              setPublishedAt(Date.now());
            }
            // 이 칸은 이번 읽기만 바꾸므로 마지막으로 그린 값과 견주면 됨
            const merged = mergePart(
              latest.current[key] as Slot<unknown>,
              part,
            );
            if (merged.stale) keptStale = true;
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
        if (!keptStale) setAt(new Date().toISOString());
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

  const anyLoading =
    !signedIn ||
    me === null ||
    Object.values(parts).some((p: Slot<unknown>) => p.state === "loading");
  // 5초 넘게 받는 칸이 있으면 제목 줄 오른쪽에 느림 안내(칸 높이를 바꾸지 않게 한 자리에서)
  const page = useLoadTiming(anyLoading);
  const role = signedIn ? roleLabel(snapshot.pool, snapshot.groups) : null;
  const anyFailed = [parts.published, parts.inquiries, parts.notices].some(
    (p) => p.state === "failed",
  );
  // 서버 세션 확인 전·확인됨이면 칸을 그림(확인 전에는 모두 자리표시). 확인 실패면 알림만
  const showParts = !me || me.ok;

  return (
    <main
      aria-busy={anyLoading || undefined}
      className="flex w-full flex-col gap-5 px-4 py-5 md:px-10 md:pt-6 md:pb-10"
    >
      {/* 세션 확인 중에는 공통 틀이 '운영 화면 여는 중'을 알림 → 여기서는 그 뒤 한 번만 */}
      <LoadingStatus
        busy={signedIn && anyLoading}
        label={fill(t.loading.screen, { name: h.title })}
      />
      {/* 느림 안내(5초)는 제목 줄 오른쪽에 겹쳐 띄움: 모바일 첫 화면에도 보이고 줄 높이·아래 칸이 밀리지 않음 */}
      <div className="relative">
        <h1 className="text-title-l font-semibold text-text-default">
          {h.title}
        </h1>
        <div
          role="status"
          className="absolute top-0 right-0 flex h-[calc(var(--text-title-l)*1.4)] max-w-[calc(100%-6rem)] items-center"
        >
          {page.slow && <SlowNote className="text-right" />}
        </div>
        {signedIn ? (
          snapshot.email && (
            <p className="mt-1 text-body-s text-text-muted">
              {fill(h.signedInAs, { email: snapshot.email })}
              {role && ` · ${role}`}
            </p>
          )
        ) : (
          <p className="mt-1 text-body-s">
            <SkLine className="w-[260px] max-w-full" />
          </p>
        )}
      </div>
      {me && !me.ok && me.code === "sample_not_allowed" && (
        <Notice tone="warn" title={h.demoPeriod} role="alert">
          {h.demoPeriodHint}
        </Notice>
      )}
      {me &&
        !me.ok &&
        me.code !== "sample_not_allowed" &&
        me.code !== "reauth" && (
          <Notice tone="fail" title={h.serverError} role="alert">
            {"requestId" in me && me.requestId && (
              <p>{fill(h.requestId, { id: me.requestId })}</p>
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
        )}
      {showParts && (
        <>
          <SourcesLine part={parts.collection} onRetry={reload} />
          {anyFailed && (
            <Notice tone="warn" title={h.partFailed} role="alert">
              <Button
                variant="secondary"
                size="small"
                className="mt-1"
                onClick={reload}
              >
                {h.retry}
              </Button>
            </Notice>
          )}
          <Summary parts={parts} nowMs={publishedAt} />
          <Todos parts={parts} />
          <Recent part={parts.recent} beaches={beaches} />
          <AsOf
            at={at}
            refreshing={reading && at !== null}
            stale={stale.size > 0}
            onRetry={reload}
          />
        </>
      )}
      <p className="text-label-s text-text-muted">{t.session.refreshNote}</p>
    </main>
  );
}

// 기준 시각 줄(보드 LP ⑤): 다시 읽는 동안 옆에 작은 회전 표시 '다시 읽는 중'
// 다시 읽기가 실패한 칸이 있으면 '마지막으로 받은 값이에요 · HH:MM 기준'(값은 그대로)
// 처음 받기 전에는 같은 줄 높이 자리표시
function AsOf({
  at,
  refreshing,
  stale,
  onRetry,
}: {
  at: string | null;
  refreshing: boolean;
  stale: boolean;
  onRetry: () => void;
}) {
  if (at === null) {
    return (
      <p className={HINT}>
        <SkLine className="w-[280px] max-w-full" />
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className={`${HINT} flex flex-wrap items-center gap-x-1.5`}>
        <span>{fill(h.asOf, { time: kstDateTime(at) })}</span>
        {refreshing && (
          <span className="inline-flex items-center gap-1 text-brand-default">
            <Spinner />
            {t.loading.refreshing}
          </span>
        )}
      </p>
      {stale && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-3 text-label-s font-medium text-text-default"
        >
          {fill(t.loading.stale, { time: hourMinute(at) })}
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

export function HomeScreen({ beaches }: { beaches: Beaches }) {
  // 세션 확인 중(첫 진입)에도 같은 요소를 그려 자리표시를 이어서 씀(보드 L10)
  const body = <HomeBody beaches={beaches} />;
  return (
    <AdminShell title={messages.home.title} loading={body}>
      {body}
    </AdminShell>
  );
}
