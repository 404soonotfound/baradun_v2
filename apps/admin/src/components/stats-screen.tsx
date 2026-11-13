"use client";

import { useEffect, useState } from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import type { BeachSlugName } from "@/lib/beach-names";
import { kstDateTime } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import {
  beachLabel,
  fetchStats,
  metadataReasons,
  sharePercent,
  STATS_RANGES,
  sumMetric,
  type StatsRange,
  type StatsResponse,
} from "@/lib/stats";
import { AdminShell } from "./admin-shell";
import { Button, Notice, SUCCESS_BADGE } from "./ui";

// 이용 통계 (BRD-154·GH-333, 화면 설계서 6장 ADM-STATS)
// - 출시 수집은 page_view만. 다른 이벤트는 '수집 안 함(후속)'으로 표시
// - GA4 metadata(thresholding·sampling·otherRowLoss)가 있을 때만 제한 안내 표시(E8)
// - 숨긴 숫자는 추정하지 않고 '–'로 표시(0으로 바꾸지 않음)
// - 해변 상태(특보 없음·이용불가·판단불가)와 묶은 지표는 만들지 않음

const t = messages.stats;

const CARD =
  "rounded-admin-card border border-border-default bg-bg-elevated p-5 shadow-admin-card";
const BADGE =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-admin-badge px-2 text-label-s font-medium whitespace-nowrap";

function formatNumber(n: number | null): string {
  return n === null ? t.emptyValue : n.toLocaleString("ko-KR");
}

function formatPeople(n: number | null): string {
  return n === null ? t.emptyValue : fill(t.countUnit, { count: formatNumber(n) });
}

function formatViews(n: number | null): string {
  return n === null ? t.emptyValue : fill(t.viewUnit, { count: formatNumber(n) });
}

function deviceLabel(category: string): string {
  return (t.deviceLabels as Record<string, string>)[category] ?? category;
}

function languageLabel(code: string): string {
  return (t.languageLabels as Record<string, string>)[code] ?? code;
}

export function StatsScreen({
  beachesBySlug,
}: {
  beachesBySlug: Record<string, BeachSlugName>;
}) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  const [range, setRange] = useState<StatsRange>("7d");
  const [reloadTick, setReloadTick] = useState(0);
  const key = `${range}|${reloadTick}|${generation}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: OpsResult<StatsResponse>;
  } | null>(null);

  useEffect(() => {
    if (snapshot.status === "signed_out") return;
    let live = true;
    void fetchStats(range, () => session.accessToken()).then((result) => {
      if (live) setLoaded({ key, result });
    });
    return () => {
      live = false;
    };
  }, [session, snapshot.status, key, range]);

  const loading = snapshot.status !== "signed_out" && loaded?.key !== key;
  const result = loaded?.key === key ? loaded.result : null;

  const data = result && result.ok ? result.body : null;
  const reasons = data ? metadataReasons(data.period.metadata) : [];
  const deviceTotal = data
    ? sumMetric(data.period.devices.map((d) => d.activeUsers))
    : null;
  const languageTotal = data
    ? sumMetric(data.period.languages.map((l) => l.activeUsers))
    : null;

  return (
    <AdminShell title={t.title}>
      <div className="space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-heading-l font-bold text-text-primary">
              {t.title}
            </h1>
            <p className="text-body-s text-text-muted">{t.intro}</p>
            {data && (
              <div className="flex flex-wrap items-center gap-2 pt-1 text-caption text-text-muted">
                <span>
                  {fill(t.fetchedAt, { time: kstDateTime(data.fetchedAt) })}
                </span>
                {data.cached && (
                  <span
                    className={`${BADGE} bg-bg-surface text-text-body ring-1 ring-border-default`}
                  >
                    {t.cachedBadge}
                  </span>
                )}
              </div>
            )}
          </div>
          <Button
            type="button"
            variant="secondary"
            disabled={loading}
            onClick={() => setReloadTick((n) => n + 1)}
          >
            {t.refresh}
          </Button>
        </header>

        <div
          role="group"
          aria-label={t.rangeGroupLabel}
          className="inline-flex flex-wrap gap-2"
        >
          {STATS_RANGES.map((r) => {
            const active = range === r;
            return (
              <Button
                key={r}
                type="button"
                variant={active ? "primary" : "secondary"}
                aria-pressed={active}
                onClick={() => setRange(r)}
              >
                {t.range[r]}
              </Button>
            );
          })}
        </div>

        {loading && !data && (
          <Notice tone="neutral" title={t.loading} />
        )}

        {!loading && result && !result.ok && (
          <Notice tone="fail" title={t.loadError}>
            {t.loadErrorHint}
          </Notice>
        )}

        {data && !data.configured && (
          <Notice tone="warn" title={t.unconfiguredTitle}>
            {t.unconfiguredBody}
          </Notice>
        )}

        {data && data.configured && (
          <>
            {reasons.length > 0 && (
              <Notice tone="warn" title={t.metadataTitle}>
                <p>{t.metadataBody}</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {reasons.map((key) => (
                    <li key={key}>{t.metadataReasons[key]}</li>
                  ))}
                </ul>
              </Notice>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <section aria-labelledby="stats-realtime-heading" className={CARD}>
                <h2
                  id="stats-realtime-heading"
                  className="text-heading-s font-semibold text-text-primary"
                >
                  {t.realtimeTitle}
                </h2>
                {data.realtime.status === "unavailable" ? (
                  <p className="mt-3 text-body-s text-status-stale-fg">
                    {t.realtimeUnavailable}
                  </p>
                ) : (
                  <dl className="mt-4 grid grid-cols-2 gap-4">
                    <div>
                      <dt className="text-caption text-text-muted">
                        {t.activeUsers}
                      </dt>
                      <dd className="mt-1 text-heading-m font-bold text-text-primary">
                        {formatPeople(data.realtime.activeUsers)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-caption text-text-muted">
                        {t.pageViews}
                      </dt>
                      <dd className="mt-1 text-heading-m font-bold text-text-primary">
                        {formatViews(data.realtime.pageViews)}
                      </dd>
                    </div>
                  </dl>
                )}
              </section>

              <section aria-labelledby="stats-period-heading" className={CARD}>
                <h2
                  id="stats-period-heading"
                  className="text-heading-s font-semibold text-text-primary"
                >
                  {t.periodTitle} ({t.range[data.range]})
                </h2>
                {data.period.status === "unavailable" ? (
                  <p className="mt-3 text-body-s text-status-stale-fg">
                    {t.periodUnavailable}
                  </p>
                ) : (
                  <dl className="mt-4 grid grid-cols-2 gap-4">
                    <div>
                      <dt className="text-caption text-text-muted">
                        {t.activeUsers}
                      </dt>
                      <dd className="mt-1 text-heading-m font-bold text-text-primary">
                        {formatPeople(data.period.activeUsers)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-caption text-text-muted">
                        {t.pageViews}
                      </dt>
                      <dd className="mt-1 text-heading-m font-bold text-text-primary">
                        {formatViews(data.period.pageViews)}
                      </dd>
                    </div>
                  </dl>
                )}
              </section>
            </div>

            {data.period.status === "ok" && (
              <div className="grid gap-4 lg:grid-cols-3">
                <section
                  aria-labelledby="stats-beaches-heading"
                  className={`${CARD} lg:col-span-1`}
                >
                  <h2
                    id="stats-beaches-heading"
                    className="text-heading-s font-semibold text-text-primary"
                  >
                    {t.topBeachesTitle}
                  </h2>
                  {data.period.topBeaches.length === 0 ? (
                    <p className="mt-3 text-body-s text-text-muted">
                      {t.topBeachesEmpty}
                    </p>
                  ) : (
                    <ul className="mt-3 divide-y divide-border-subtle">
                      {data.period.topBeaches.map((row) => {
                        const label = beachLabel(row, beachesBySlug);
                        return (
                          <li
                            key={row.path}
                            className="flex items-center justify-between gap-3 py-2.5 text-body-s"
                          >
                            <div className="min-w-0">
                              <p className="truncate font-medium text-text-primary">
                                {label.title}
                              </p>
                              <p className="truncate text-caption text-text-muted">
                                {label.region ?? row.path}
                              </p>
                            </div>
                            <span className="shrink-0 font-semibold text-text-primary">
                              {formatViews(row.pageViews)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>

                <section aria-labelledby="stats-devices-heading" className={CARD}>
                  <h2
                    id="stats-devices-heading"
                    className="text-heading-s font-semibold text-text-primary"
                  >
                    {t.devicesTitle}
                  </h2>
                  {data.period.devices.length === 0 ? (
                    <p className="mt-3 text-body-s text-text-muted">
                      {t.listEmpty}
                    </p>
                  ) : (
                    <ul className="mt-3 divide-y divide-border-subtle">
                      {data.period.devices.map((row) => {
                        const pct = sharePercent(row.activeUsers, deviceTotal);
                        return (
                          <li
                            key={row.category}
                            className="flex items-center justify-between gap-3 py-2.5 text-body-s"
                          >
                            <span className="font-medium text-text-primary">
                              {deviceLabel(row.category)}
                            </span>
                            <span className="text-text-body">
                              {formatPeople(row.activeUsers)}
                              {pct !== null && (
                                <span className="ml-1.5 text-caption text-text-muted">
                                  ({fill(t.percentUnit, { percent: pct })})
                                </span>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>

                <section
                  aria-labelledby="stats-languages-heading"
                  className={CARD}
                >
                  <h2
                    id="stats-languages-heading"
                    className="text-heading-s font-semibold text-text-primary"
                  >
                    {t.languagesTitle}
                  </h2>
                  {data.period.languages.length === 0 ? (
                    <p className="mt-3 text-body-s text-text-muted">
                      {t.listEmpty}
                    </p>
                  ) : (
                    <ul className="mt-3 divide-y divide-border-subtle">
                      {data.period.languages.map((row) => {
                        const pct = sharePercent(
                          row.activeUsers,
                          languageTotal,
                        );
                        return (
                          <li
                            key={row.language}
                            className="flex items-center justify-between gap-3 py-2.5 text-body-s"
                          >
                            <span className="font-medium text-text-primary">
                              {languageLabel(row.language)}
                            </span>
                            <span className="text-text-body">
                              {formatPeople(row.activeUsers)}
                              {pct !== null && (
                                <span className="ml-1.5 text-caption text-text-muted">
                                  ({fill(t.percentUnit, { percent: pct })})
                                </span>
                              )}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </div>
            )}

            <section aria-labelledby="stats-events-heading" className={CARD}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2
                  id="stats-events-heading"
                  className="text-heading-s font-semibold text-text-primary"
                >
                  {t.eventsTitle}
                </h2>
                <p className="text-caption text-text-muted">{t.eventsNote}</p>
              </div>
              <ul className="mt-3 divide-y divide-border-subtle">
                {data.events.map((ev) => (
                  <li
                    key={ev.name}
                    className="flex items-center justify-between gap-3 py-2.5 text-body-s"
                  >
                    <code className="font-mono text-caption text-text-primary">
                      {ev.name}
                    </code>
                    {ev.status === "collecting" ? (
                      <span className={`${BADGE} ${SUCCESS_BADGE}`}>
                        <span
                          aria-hidden="true"
                          className="size-2 rounded-full bg-success-icon"
                        />
                        {t.eventStatus.collecting}
                      </span>
                    ) : (
                      <span
                        className={`${BADGE} bg-bg-surface text-text-muted ring-1 ring-border-strong`}
                      >
                        <span
                          aria-hidden="true"
                          className="size-2 rounded-full border border-border-strong"
                        />
                        {t.eventStatus.not_collecting}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </AdminShell>
  );
}
