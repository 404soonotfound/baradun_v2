"use client";

import { useEffect, useState } from "react";
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
import { Button, Notice, TextLink } from "./ui";

// 운영 홈 (BRD-149, 화면 설계서 6장 ADM-HOME). 로그인 뒤 /ops/me로 서버가 이 세션을 받아 주는지 먼저 확인함
// 데모 계정이 허용 기간 밖이면 서버가 403(sample_not_allowed) → 화면에서도 막힘을 알림(D16-A8, 캔버스 E11-4)
// - 맨 위 한 줄: 판단에 쓰는 출처 상태. 하나라도 정상이 아니면 문제 줄(내부 화면이라 출처 이름을 씀)
//   사용자 화면 배너 문구(12장 결정 1 '확인된 판단 없음')는 여기서 바꾸지 않음
// - 요약 카드·할 일·최근 변경은 이미 있는 운영 API(수집 현황·게시본·문의·공지·변경 이력)를 모아 보여 줌
// - 못 읽은 값은 0·정상·'할 일 없음'으로 바꾸지 않고 '확인 못 함'. 다시 읽는 동안은 앞 값을 그대로 둠
// - 화면이 보이는 동안 60초마다 다시 읽음(D16-E1 운영 홈 60초)

const t = messages;
const h = messages.home;
const REFRESH_MS = 60_000;
const RECENT_COUNT = 5;

const CARD =
  "flex flex-col gap-1 rounded-admin-box border border-border-default bg-bg-surface px-4 py-3";
const LABEL = "text-label-s font-medium text-text-body";
const VALUE = "text-title-l font-semibold text-text-default tabular-nums";
const HINT = "text-label-s text-text-muted";

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
  // 칸마다 시간 제한·예외 처리(멈춘 칸이 '불러오는 중'에 머물지 않게)
  return {
    collection: () => settle(raw.collection),
    published: () => settle(raw.published),
    inquiries: () => settle(raw.inquiries),
    notices: () => settle(raw.notices),
    recent: () => settle(raw.recent),
  };
}

function SourcesLine({
  part,
  onRetry,
}: {
  part: Slot<CollectionView>;
  onRetry: () => void;
}) {
  if (part.state === "loading") {
    return (
      <p role="status" className="text-body-s text-text-muted">
        {h.sourcesLoading}
      </p>
    );
  }
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
  children,
}: {
  part: Slot<unknown>;
  children: React.ReactNode;
}) {
  if (part.state === "ok") return <dd className={VALUE}>{children}</dd>;
  if (part.state === "loading") {
    return (
      <dd className={`${VALUE} text-title-s text-text-muted`}>
        {h.partLoading}
      </dd>
    );
  }
  return (
    <dd className={`${VALUE} text-title-s`}>
      {part.state === "forbidden" ? h.forbidden : h.unknown}
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
        <Value part={parts.published}>
          {published ? kstDateTime(published.generatedAt) : null}
        </Value>
        <dd className={HINT}>
          {notices
            ? fill(h.kpiNotices, {
                scheduled: notices.scheduled,
                pending: notices.pendingEdit,
              })
            : parts.notices.state === "loading"
              ? h.partLoading
              : h.kpiNoticesUnknown}
        </dd>
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
  // 아직 받는 중인 칸이 있으면 '못 불러옴'·'할 일 없음' 대신 확인 중
  const loading = [parts.collection, parts.inquiries, parts.notices].some(
    (p) => p.state === "loading",
  );
  return (
    <section aria-labelledby="home-todo" className="flex flex-col gap-2">
      <h2
        id="home-todo"
        className="text-title-s font-semibold text-text-default"
      >
        {h.todoTitle}
      </h2>
      {list.items.length > 0 && (
        <ul className="flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface">
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
        <p role="status" className="text-body-s text-text-muted">
          {h.todoLoading}
        </p>
      ) : list.incomplete ? (
        <p role="status" className="text-body-s text-text-body">
          {h.todoIncomplete}
        </p>
      ) : (
        list.items.length === 0 && (
          <p className="text-body-s text-text-body">{h.todoNone}</p>
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
  return (
    <section aria-labelledby="home-recent" className="flex flex-col gap-2">
      <h2
        id="home-recent"
        className="text-title-s font-semibold text-text-default"
      >
        {h.recentTitle}
      </h2>
      {part.state === "loading" && (
        <p role="status" className="text-body-s text-text-muted">
          {h.recentLoading}
        </p>
      )}
      {part.state === "forbidden" && (
        <p className="text-body-s text-text-body">{h.recentForbidden}</p>
      )}
      {part.state === "failed" && (
        <p role="status" className="text-body-s text-text-body">
          {h.recentFailed}
        </p>
      )}
      {part.state === "ok" && part.value.items.length === 0 && (
        <p className="text-body-s text-text-body">
          {part.value.onlyReads ? h.recentOnlyReads : h.recentNone}
        </p>
      )}
      {part.state === "ok" && part.value.items.length > 0 && (
        <ul className="flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface">
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

function HomeBody({ beaches }: { beaches: Beaches }) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const owner = badgeOwner(snapshot);
  const demo = snapshot.status !== "signed_out" && snapshot.pool === "demo";
  const [me, setMe] = useState<OpsResult<Me> | null>(null);
  const [parts, setParts] = useState<Parts>(INITIAL);
  // 마지막으로 모든 칸을 다 받은 시각(기준 시각). 아직 한 번도 다 받지 못했으면 null
  const [at, setAt] = useState<string | null>(null);
  // 게시본을 받은 시각. 유효 시각 지남을 이 시각 기준으로 셈(그리는 중에 시계를 읽지 않음)
  const [publishedAt, setPublishedAt] = useState(0);
  const [attempt, setAttempt] = useState(0);
  // 요약 칸만 다시 읽기(/ops/me 확인을 다시 하지 않아 화면·포커스가 사라지지 않음)
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    void opsFetch<Me>("/ops/me", () => session.accessToken()).then((result) => {
      if (live) setMe(result);
    });
    return () => {
      live = false;
    };
  }, [session, attempt]);

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
      const keys = Object.keys(load) as (keyof Parts)[];
      void Promise.all(
        keys.map((key) =>
          load[key]().then((part) => {
            if (!live || id < (shown[key] ?? 0)) return;
            shown[key] = id;
            if (key === "published") setPublishedAt(Date.now());
            setParts((prev) => ({ ...prev, [key]: part }));
          }),
        ),
      ).then(() => {
        if (live && id === started) setAt(new Date().toISOString());
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
  // 요약 칸만 다시 읽음(앞 값은 그대로 두고 받은 칸부터 바꿈)
  const reload = () => setRound((n) => n + 1);

  if (snapshot.status === "signed_out") return null;
  const role = roleLabel(snapshot.pool, snapshot.groups);
  const anyFailed = [parts.published, parts.inquiries, parts.notices].some(
    (p) => p.state === "failed",
  );

  return (
    <main className="flex w-full flex-col gap-5 px-4 py-5 md:px-10 md:pt-6 md:pb-10">
      <div>
        <h1 className="text-title-l font-semibold text-text-default">
          {h.title}
        </h1>
        {snapshot.email && (
          <p className="mt-1 text-body-s text-text-muted">
            {fill(h.signedInAs, { email: snapshot.email })}
            {role && ` · ${role}`}
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
      {ready && (
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
          {at && (
            <p className={HINT}>{fill(h.asOf, { time: kstDateTime(at) })}</p>
          )}
        </>
      )}
      <p className="text-label-s text-text-muted">{t.session.refreshNote}</p>
    </main>
  );
}

export function HomeScreen({ beaches }: { beaches: Beaches }) {
  return (
    <AdminShell title={messages.home.title}>
      <HomeBody beaches={beaches} />
    </AdminShell>
  );
}
