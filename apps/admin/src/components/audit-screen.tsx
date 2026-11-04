"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  AUDIT_ACTIONS,
  AUDIT_PERIODS,
  fetchAudit,
  isAuditAction,
  kstDay,
  periodFilter,
  shortSub,
  type AuditAction,
  type AuditFilter,
  type AuditPage,
  type AuditPeriod,
  type AuditView,
} from "@/lib/audit";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import { isInquiryStatus, kstDateTime, shortId } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import { AdminShell } from "./admin-shell";
import { Button, Notice } from "./ui";

// 운영자 변경 이력 (BRD-155, 화면 설계서 6장 ADM-AUD, 시안 4차 V23·VM14)
// - 읽기 전용. 기간·종류·운영자로 거르고, 대상(문의·공지)을 누르면 그 화면으로 감
// - 기록에는 바뀐 항목 이름과 처리 상태 앞·뒤만 있음. 값(문의 본문·메모·공지 문구)은 없어 보여 주지 않음(D16-B5)
// - 운영자 이름은 기록에 없어 Cognito sub를 줄여 보여 줌. 누르면 그 운영자 기록만 거름
// - 데모 계정은 변경 이력을 받지 않음(D15-3) → 요청하지 않고 안내만

const t = messages.audit;
const i = messages.inquiries;

const REPO_DATA_COMMITS =
  "https://github.com/404soonotfound/baradun_v2/commits/main/data/beaches";

function actionLabel(action: string): string {
  return isAuditAction(action)
    ? t.action[action]
    : fill(t.unknownAction, { action });
}

function roleLabel(role: string): string {
  return role in t.role
    ? t.role[role as keyof typeof t.role]
    : fill(t.unknownRole, { role });
}

function fieldLabel(field: string): string {
  return field in t.field ? t.field[field as keyof typeof t.field] : field;
}

function statusLabel(status: string): string {
  return isInquiryStatus(status) ? i.status[status] : status;
}

// 대상: 문의·공지는 그 화면으로. 샘플 요청은 경로 모양만 글자로
function Target({ item }: { item: AuditView }) {
  const { kind, id } = item.target;
  if (kind === "inquiry") {
    return (
      <Link
        href={`/inquiries/?id=${encodeURIComponent(id)}`}
        title={id}
        className="font-medium text-brand-default underline-offset-2 hover:underline"
      >
        {fill(t.target.inquiry, { id: shortId(id) })}
      </Link>
    );
  }
  if (kind === "notice") {
    return (
      <Link
        href={`/notices/?id=${encodeURIComponent(id)}`}
        className="font-medium text-brand-default underline-offset-2 hover:underline"
      >
        {fill(t.target.notice, { id })}
      </Link>
    );
  }
  return (
    <span className="font-mono text-body-s text-text-body">
      {kind in t.target
        ? fill(t.target[kind as keyof typeof t.target], { id })
        : `${kind} ${id}`}
    </span>
  );
}

function Changes({ item }: { item: AuditView }) {
  if (item.changes.length === 0) {
    return <span className="text-text-muted">{t.noChanges}</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      <span>{item.changes.map(fieldLabel).join(" · ")}</span>
      {item.statusFrom && item.statusTo && (
        <span className="text-body-s text-text-muted">
          {fill(t.statusChange, {
            from: statusLabel(item.statusFrom),
            to: statusLabel(item.statusTo),
          })}
        </span>
      )}
    </span>
  );
}

function Actor({
  item,
  onPick,
}: {
  item: AuditView;
  onPick: (sub: string) => void;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <button
        type="button"
        title={fill(t.actorTitle, { sub: item.actorSub })}
        aria-label={`${t.onlyActor}: ${item.actorSub}`}
        onClick={() => onPick(item.actorSub)}
        className="min-h-touch font-mono text-body-s text-text-default underline-offset-2 hover:underline lg:min-h-0"
      >
        {shortSub(item.actorSub)}
      </button>
      <span className="rounded-admin-badge bg-bg-page px-1.5 text-caption font-semibold text-text-body ring-1 ring-border-default">
        {roleLabel(item.role)}
      </span>
    </span>
  );
}

type Loaded = {
  key: string;
  result: OpsResult<AuditPage>;
};

function AuditBody() {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const demo = snapshot.status !== "signed_out" && snapshot.pool === "demo";
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  const [days, setDays] = useState<AuditPeriod>(30);
  const [action, setAction] = useState<AuditAction | null>(null);
  const [actor, setActor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // 거르기를 바꾸면 기간 끝(지금)을 새로 잡음
  const [now, setNow] = useState(() => Date.now());
  const filter: AuditFilter = periodFilter(days, now, action, actor);
  const filterText = JSON.stringify(filter);
  const key = `${filterText}|${attempt}|${generation}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // 더 보기로 이어 받은 쪽들(첫 쪽 뒤). 거르기가 바뀌면 key가 달라져 버림
  const [more, setMore] = useState<{
    key: string;
    items: AuditView[];
    cursor: string | null;
  } | null>(null);
  const [moreState, setMoreState] = useState<
    "idle" | "loading" | Extract<OpsResult<AuditPage>, { ok: false }>
  >("idle");

  useEffect(() => {
    if (demo) return;
    let live = true;
    const asked = JSON.parse(filterText) as AuditFilter;
    void fetchAudit(() => session.accessToken(), asked, null).then((next) => {
      if (live) setLoaded({ key, result: next });
    });
    return () => {
      live = false;
    };
  }, [session, key, filterText, demo]);

  const result = loaded?.key === key ? loaded.result : null;
  const extra = more?.key === key ? more : null;
  const items = result?.ok
    ? [...result.body.items, ...(extra?.items ?? [])]
    : [];
  const cursor = extra
    ? extra.cursor
    : result?.ok
      ? result.body.nextCursor
      : null;

  const refilter = (change: () => void) => {
    change();
    setNow(Date.now());
    setMore(null);
    setMoreState("idle");
  };

  // 지금 보는 목록의 key. 더 보기 응답이 늦게 와도 거르기를 바꾼 뒤라면 버림
  const currentKey = useRef(key);
  useEffect(() => {
    currentKey.current = key;
  }, [key]);

  const loadMore = () => {
    if (!cursor || moreState === "loading") return;
    const asked = key;
    setMoreState("loading");
    void fetchAudit(() => session.accessToken(), filter, cursor).then(
      (next) => {
        if (currentKey.current !== asked) return;
        if (!next.ok) {
          setMoreState(next);
          return;
        }
        setMoreState("idle");
        setMore({
          key,
          items: [...(extra?.items ?? []), ...next.body.items],
          cursor: next.body.nextCursor,
        });
      },
    );
  };

  const selectClass =
    "min-h-touch rounded-admin-control border border-border-strong bg-bg-surface px-2.5 text-body text-text-default outline-none focus:border-brand-default focus:ring-[3px] focus:ring-brand-border lg:min-h-admin-control";

  // 모바일: 날짜(KST)별로 묶음
  const byDay = items.reduce<{ day: string; items: AuditView[] }[]>(
    (groups, item) => {
      const day = kstDay(item.at);
      const last = groups.at(-1);
      if (last?.day === day) last.items.push(item);
      else groups.push({ day, items: [item] });
      return groups;
    },
    [],
  );

  return (
    <div className="flex flex-col gap-4 px-4 py-5 md:px-10 md:pt-6 md:pb-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-title-l font-semibold text-text-default">
          {t.title}
        </h1>
        <p className="text-body-s text-text-muted">{t.description}</p>
      </div>

      {demo ? (
        <Notice tone="neutral" title={t.demo} />
      ) : (
        <>
          <div
            role="group"
            aria-label={t.filtersLabel}
            className="flex flex-wrap items-end gap-3"
          >
            <label className="flex flex-col gap-1 text-label-s font-medium text-text-body">
              {t.period}
              <select
                value={days}
                onChange={(e) =>
                  refilter(() => setDays(Number(e.target.value) as AuditPeriod))
                }
                className={selectClass}
              >
                {AUDIT_PERIODS.map((d) => (
                  <option key={d} value={d}>
                    {t.periodDays[String(d) as keyof typeof t.periodDays]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-label-s font-medium text-text-body">
              {t.actionLabel}
              <select
                value={action ?? ""}
                onChange={(e) =>
                  refilter(() =>
                    setAction(
                      isAuditAction(e.target.value) ? e.target.value : null,
                    ),
                  )
                }
                className={selectClass}
              >
                <option value="">{t.allActions}</option>
                {AUDIT_ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {t.action[a]}
                  </option>
                ))}
              </select>
            </label>
            {actor && (
              <span className="flex min-h-touch items-center gap-2 rounded-admin-control bg-brand-weak px-2.5 text-body-s text-text-default ring-1 ring-brand-border lg:min-h-admin-control">
                {fill(t.actorFilter, { actor: shortSub(actor) })}
                <Button
                  variant="quiet"
                  size="small"
                  className="h-auto! px-1!"
                  onClick={() => refilter(() => setActor(null))}
                >
                  {t.clearActor}
                </Button>
              </span>
            )}
          </div>

          {result === null && (
            <p role="status" className="text-body-s text-text-muted">
              {t.loading}
            </p>
          )}
          {result && !result.ok && (
            <Failure
              title={t.error}
              result={result}
              onRetry={() => setAttempt((n) => n + 1)}
            />
          )}
          {result?.ok && items.length === 0 && (
            <div className="rounded-admin-box border border-border-default bg-bg-surface px-4 py-6 text-center">
              <p className="text-title-s font-semibold text-text-default">
                {t.emptyTitle}
              </p>
              <p className="mt-1 text-body-s text-text-muted">{t.emptyBody}</p>
            </div>
          )}
          {items.length > 0 && (
            <>
              {/* 태블릿·PC: 표 */}
              <table className="hidden w-full border-separate border-spacing-0 overflow-hidden rounded-admin-box border border-border-default bg-bg-surface text-body md:table">
                <thead>
                  <tr className="bg-bg-page text-left text-label-s font-semibold text-text-body">
                    {[
                      t.colAt,
                      t.colActor,
                      t.colAction,
                      t.colTarget,
                      t.colChanges,
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
                  {items.map((item) => (
                    <tr
                      key={`${item.at}|${item.requestId}`}
                      className="align-top"
                    >
                      <td className="border-b border-border-default py-2 pr-3 pl-4 whitespace-nowrap text-text-body tabular-nums">
                        {kstDateTime(item.at)}
                      </td>
                      <td className="border-b border-border-default px-3 py-2">
                        <Actor
                          item={item}
                          onPick={(sub) => refilter(() => setActor(sub))}
                        />
                      </td>
                      <td className="border-b border-border-default px-3 py-2 text-text-default">
                        {actionLabel(item.action)}
                      </td>
                      <td className="border-b border-border-default px-3 py-2">
                        <Target item={item} />
                      </td>
                      <td className="border-b border-border-default px-3 py-2 text-text-body">
                        <Changes item={item} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* 모바일: 날짜별 카드 */}
              <div className="flex flex-col gap-3 md:hidden">
                {byDay.map((group) => (
                  <section key={group.day} aria-label={group.day}>
                    <h2 className="mb-1 text-label-s font-semibold text-text-muted">
                      {group.day}
                    </h2>
                    <ul className="flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface">
                      {group.items.map((item) => (
                        <li
                          key={`${item.at}|${item.requestId}`}
                          className="flex flex-col gap-1 px-4 py-3"
                        >
                          <span className="flex flex-wrap items-center gap-2 text-body font-medium text-text-default">
                            {actionLabel(item.action)}
                            <Target item={item} />
                          </span>
                          <span className="text-body-s text-text-body">
                            <Changes item={item} />
                          </span>
                          <span className="flex flex-wrap items-center gap-2 text-label-s text-text-muted">
                            <Actor
                              item={item}
                              onPick={(sub) => refilter(() => setActor(sub))}
                            />
                            <span className="tabular-nums">
                              {kstDateTime(item.at)}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 text-body-s text-text-muted">
                <span aria-live="polite">
                  {fill(t.count, { count: items.length })}
                  {!cursor && ` · ${t.end}`}
                </span>
                {cursor && (
                  <Button
                    variant="secondary"
                    size="small"
                    disabled={moreState === "loading"}
                    onClick={loadMore}
                  >
                    {moreState === "loading" ? t.moreLoading : t.more}
                  </Button>
                )}
              </div>
              {typeof moreState === "object" && (
                <Failure
                  title={t.moreError}
                  result={moreState}
                  onRetry={loadMore}
                />
              )}
            </>
          )}
        </>
      )}

      <p className="text-label-s text-text-muted">
        {t.note}{" "}
        <a
          href={REPO_DATA_COMMITS}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-brand-default underline underline-offset-2"
        >
          {t.repoLink}
        </a>
      </p>
    </div>
  );
}

function Failure({
  title,
  result,
  onRetry,
}: {
  title: string;
  result: Extract<OpsResult<unknown>, { ok: false }>;
  onRetry: () => void;
}) {
  if (result.code === "reauth") {
    return <Notice tone="warn" title={i.reauth} role="alert" />;
  }
  return (
    <Notice tone="fail" title={title} role="alert">
      <p>{i.serverHint}</p>
      {"requestId" in result && result.requestId && (
        <p>{fill(i.requestId, { id: result.requestId })}</p>
      )}
      <Button
        variant="secondary"
        size="small"
        className="mt-2"
        onClick={onRetry}
      >
        {i.retry}
      </Button>
    </Notice>
  );
}

export function AuditScreen() {
  return (
    <AdminShell title={t.title}>
      <AuditBody />
    </AdminShell>
  );
}
