"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import type { BeachName } from "@/lib/beach-names";
import {
  fetchInquiries,
  fetchInquiry,
  INQUIRY_STATUSES,
  isInquiryStatus,
  kstDateTime,
  PAGE_SIZE,
  retentionDate,
  shortId,
  type InquiryCounts,
  type InquiryDetail,
  type InquiryPage,
  type InquiryStatus,
  type InquirySummary,
} from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import { AdminShell } from "./admin-shell";
import { Button, Notice } from "./ui";

// 운영자 문의 목록·상세 (BRD-153, 화면 설계서 6장 ADM-INQ, 시안 4차 V20·VM6·VM7·E6·E11·VE6)
// - 목록: 상태 탭(첫 쪽에 온 상태별 수) + 표. 접수 먼저, 같은 상태 안에서는 최근 접수 순(서버가 정함)
// - 상세: 주소 ?id= 로 엶. PC(1024 이상)는 목록 옆 시트, 그보다 좁으면 목록 대신 상세 화면
// - 이 PR은 읽기만. 상태·메모 바꾸기는 다음 PR
// - 판단 상태는 바꾸지 않음(G1). 이메일·사진은 받지 않으므로 '받지 않아요' 고정(D13-1)

const t = messages.inquiries;

type Beaches = Readonly<Record<string, BeachName>>;

// 상태 배지: 글자로 상태를 말하고, 색·테두리 모양은 보조(색만으로 구분하지 않음)
// 확인 중은 점선 테두리라 색 없이도 구분됨(시안 S3 배지). 성공색 토큰은 아직 정하지 않아 완료는 정보색
const BADGE: Record<InquiryStatus, string> = {
  received: "bg-brand-weak text-brand-default ring-1 ring-brand-border",
  in_progress:
    "bg-status-stale-bg text-status-stale-fg outline-1 outline-status-stale-border outline-dashed -outline-offset-1",
  resolved: "bg-info-bg text-info-fg ring-1 ring-border-default",
  rejected: "bg-bg-surface text-text-muted ring-1 ring-border-strong",
};

// 모르는 상태 값은 숨기지 않고 그 값을 그대로 보여 줌(점선·흐린 글자)
function StatusBadge({ status }: { status: string }) {
  const known = isInquiryStatus(status);
  return (
    <span
      className={`inline-flex items-center rounded-admin-badge px-1.5 text-caption font-semibold whitespace-nowrap ${
        known
          ? BADGE[status]
          : "bg-bg-surface text-text-muted outline-1 outline-border-strong outline-dashed -outline-offset-1"
      }`}
    >
      {known ? t.status[status] : fill(t.unknownStatus, { status })}
    </span>
  );
}

function typeLabel(type: string): string {
  return type in t.type
    ? t.type[type as keyof typeof t.type]
    : fill(t.unknownType, { type });
}

function activityLabel(activity: string): string {
  return activity in t.activity
    ? t.activity[activity as keyof typeof t.activity]
    : fill(t.unknownActivity, { activity });
}

// 해변 이름표에 없는 ID도 숨기지 않고 ID를 그대로 보여 줌
function beachText(beachId: string | undefined, beaches: Beaches): string {
  if (!beachId) return t.noBeach;
  return beaches[beachId]?.name ?? fill(t.unknownBeach, { id: beachId });
}

function BeachActivity({
  item,
  beaches,
}: {
  item: InquirySummary;
  beaches: Beaches;
}) {
  const beach = item.beachId ? beaches[item.beachId] : undefined;
  return (
    <span>
      {beachText(item.beachId, beaches)}
      {item.activity && ` · ${activityLabel(item.activity)}`}
      {beach?.hidden && (
        <span className="ml-1.5 text-caption text-text-muted">
          ({t.hiddenBeach})
        </span>
      )}
    </span>
  );
}

// 실패: 무슨 일 → 영향 → 다음 행동. 오류 번호가 있으면 함께
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
    // 다시 로그인 창에서 로그인하면 화면이 저절로 다시 읽음(generation)
    return <Notice tone="warn" title={t.reauth} role="alert" />;
  }
  return (
    <Notice tone="fail" title={title} role="alert">
      <p>{t.serverHint}</p>
      {"requestId" in result && result.requestId && (
        <p>{fill(t.requestId, { id: result.requestId })}</p>
      )}
      <Button
        variant="secondary"
        size="small"
        className="mt-2"
        onClick={onRetry}
      >
        {t.retry}
      </Button>
    </Notice>
  );
}

function detailHref(id: string): string {
  return `/inquiries/?id=${encodeURIComponent(id)}`;
}

// 상태 탭: 탭을 누르면 그 상태 첫 쪽부터 다시 읽음
function StatusTabs({
  status,
  counts,
  onChange,
}: {
  status: InquiryStatus | null;
  counts: InquiryCounts | null;
  onChange: (next: InquiryStatus | null) => void;
}) {
  const total = counts
    ? INQUIRY_STATUSES.reduce((sum, s) => sum + counts[s], 0)
    : null;
  const tabs: {
    key: InquiryStatus | null;
    label: string;
    count: number | null;
  }[] = [
    ...INQUIRY_STATUSES.map((s) => ({
      key: s,
      label: t.status[s],
      count: counts ? counts[s] : null,
    })),
    { key: null, label: t.all, count: total },
  ];
  return (
    <div
      role="group"
      aria-label={t.tabsLabel}
      className="flex gap-1 overflow-x-auto border-b border-border-default"
    >
      {tabs.map((tab) => {
        const on = tab.key === status;
        return (
          <button
            key={tab.key ?? "all"}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(tab.key)}
            className={`-mb-px flex min-h-touch shrink-0 items-center gap-1.5 border-b-2 px-2 text-body whitespace-nowrap lg:min-h-admin-control ${
              on
                ? "border-brand-default font-semibold text-brand-default"
                : "border-transparent font-medium text-text-muted hover:text-text-default"
            }`}
          >
            {tab.label}
            {tab.count !== null && (
              <span className="text-label-s tabular-nums">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function InquiryList({
  beaches,
  selectedId,
}: {
  beaches: Beaches;
  selectedId: string | null;
}) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const [status, setStatus] = useState<InquiryStatus | null>(null);
  // 지나온 쪽의 cursor. 첫 쪽은 null. 이전으로 가면 하나 뺌
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const [counts, setCounts] = useState<InquiryCounts | null>(null);
  const [attempt, setAttempt] = useState(0);
  const cursor = cursors.at(-1) ?? null;
  // 받은 응답을 요청 조건과 함께 둠. 조건이 바뀌면 응답이 올 때까지 '불러오는 중'
  // 다시 로그인하면(generation이 늚) 'reauth'로 끝난 읽기를 저절로 다시 함
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  const key = `${status ?? "all"}|${cursor ?? ""}|${attempt}|${generation}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: OpsResult<InquiryPage>;
  } | null>(null);
  const result = loaded?.key === key ? loaded.result : null;

  useEffect(() => {
    let live = true;
    void fetchInquiries(() => session.accessToken(), {
      ...(status ? { status } : {}),
      ...(cursor ? { cursor } : {}),
    }).then((next) => {
      if (!live) return;
      setLoaded({ key, result: next });
      if (next.ok && next.body.counts) setCounts(next.body.counts);
    });
    return () => {
      live = false;
    };
  }, [session, status, cursor, key]);

  const changeStatus = (next: InquiryStatus | null) => {
    setStatus(next);
    setCursors([null]);
  };

  const pageIndex = cursors.length - 1;
  const items = result?.ok ? result.body.items : [];
  const total = counts
    ? status
      ? counts[status]
      : INQUIRY_STATUSES.reduce((sum, s) => sum + counts[s], 0)
    : null;
  const from = pageIndex * PAGE_SIZE + 1;
  const to = pageIndex * PAGE_SIZE + items.length;

  return (
    <section aria-labelledby="inquiries-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h1
          id="inquiries-title"
          className="text-title-l font-semibold text-text-default"
        >
          {t.title}
        </h1>
        {snapshot.status !== "signed_out" && snapshot.pool === "demo" && (
          <span className="rounded-admin-badge bg-info-bg px-1.5 text-caption font-semibold text-info-fg ring-1 ring-border-default">
            {t.sample}
          </span>
        )}
        <p className="w-full text-body-s text-text-muted">{t.description}</p>
      </div>

      <StatusTabs status={status} counts={counts} onChange={changeStatus} />

      {result === null && (
        <p role="status" className="text-body-s text-text-muted">
          {t.loading}
        </p>
      )}
      {result && !result.ok && (
        <Failure
          title={t.listError}
          result={result}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      )}
      {result?.ok && items.length === 0 && (
        <div className="rounded-admin-box border border-border-default bg-bg-surface px-4 py-6 text-center">
          <p className="text-title-s font-semibold text-text-default">
            {t.emptyTitle}
          </p>
          <p className="mt-1 text-body-s text-text-muted">
            {status
              ? fill(t.emptyStatus, { status: t.status[status] })
              : t.emptyAll}
          </p>
        </div>
      )}
      {result?.ok && items.length > 0 && (
        <>
          {/* 태블릿·PC: 표 */}
          <table className="hidden w-full border-separate border-spacing-0 overflow-hidden rounded-admin-box border border-border-default bg-bg-surface text-body md:table">
            <thead>
              <tr className="bg-bg-page text-left text-label-s font-semibold text-text-body">
                <th
                  scope="col"
                  className="border-b border-border-default px-4 py-2"
                >
                  {t.colStatus}
                </th>
                <th
                  scope="col"
                  className="border-b border-border-default px-3 py-2"
                >
                  {t.colType}
                </th>
                <th
                  scope="col"
                  className="border-b border-border-default px-3 py-2"
                >
                  {t.colBeach}
                </th>
                <th
                  scope="col"
                  className="border-b border-border-default px-4 py-2 text-right"
                >
                  {t.colReceived}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const on = item.inquiryId === selectedId;
                return (
                  <tr
                    key={item.inquiryId}
                    className={on ? "bg-brand-weak" : "hover:bg-bg-page"}
                  >
                    <td className="border-b border-border-default px-4 py-2">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="border-b border-border-default px-3 py-2">
                      <Link
                        href={detailHref(item.inquiryId)}
                        aria-current={on ? "true" : undefined}
                        className="font-medium text-text-default underline-offset-2 hover:underline"
                      >
                        {typeLabel(item.type)}
                      </Link>
                    </td>
                    <td className="border-b border-border-default px-3 py-2 text-text-body">
                      <BeachActivity item={item} beaches={beaches} />
                    </td>
                    <td className="border-b border-border-default px-4 py-2 text-right whitespace-nowrap text-text-body tabular-nums">
                      {kstDateTime(item.receivedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* 모바일: 카드 목록(값은 빼지 않음) */}
          <ul className="flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface md:hidden">
            {items.map((item) => (
              <li key={item.inquiryId}>
                <Link
                  href={detailHref(item.inquiryId)}
                  className="flex min-h-touch flex-col gap-1 px-4 py-3 hover:bg-bg-page"
                >
                  <span className="flex items-center gap-2 text-label-s text-text-muted">
                    <StatusBadge status={item.status} />
                    <span className="tabular-nums">
                      {kstDateTime(item.receivedAt)}
                    </span>
                  </span>
                  <span className="text-body font-medium text-text-default">
                    {typeLabel(item.type)}
                  </span>
                  <span className="text-body-s text-text-body">
                    <BeachActivity item={item} beaches={beaches} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          <nav
            aria-label={t.pagination}
            className="flex items-center justify-between gap-3 text-body-s text-text-muted"
          >
            <span className="tabular-nums">
              {total !== null
                ? fill(t.range, { total, from, to })
                : fill(t.rangeNoTotal, { from, to })}
            </span>
            <span className="flex gap-2">
              <Button
                variant="secondary"
                size="small"
                disabled={pageIndex === 0}
                onClick={() => setCursors((c) => c.slice(0, -1))}
              >
                {t.prev}
              </Button>
              <Button
                variant="secondary"
                size="small"
                disabled={!result.body.nextCursor}
                onClick={() => {
                  const next = result.body.nextCursor;
                  if (next) setCursors((c) => [...c, next]);
                }}
              >
                {t.next}
              </Button>
            </span>
          </nav>
        </>
      )}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-3 py-2">
      <dt className="text-body-s text-text-muted">{label}</dt>
      <dd className="text-body text-text-default">{children}</dd>
    </div>
  );
}

function InquiryDetailView({
  id,
  beaches,
  onClose,
}: {
  id: string;
  beaches: Beaches;
  onClose: () => void;
}) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const [attempt, setAttempt] = useState(0);
  // 다시 로그인하면(generation이 늚) 'reauth'로 끝난 읽기를 저절로 다시 함
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  const key = `${id}|${attempt}|${generation}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: OpsResult<InquiryDetail>;
  } | null>(null);
  const result = loaded?.key === key ? loaded.result : null;

  useEffect(() => {
    let live = true;
    void fetchInquiry(() => session.accessToken(), id).then((next) => {
      if (live) setLoaded({ key, result: next });
    });
    return () => {
      live = false;
    };
  }, [session, id, key]);

  // 주소로 열었는데 없음(지워졌거나 90일 지남): 404
  if (result && !result.ok && result.status === 404) {
    return (
      <div className="flex flex-col items-start gap-2 py-6">
        <p className="text-title-s font-semibold text-text-default">
          {t.notFoundTitle}
        </p>
        <p className="text-body-s text-text-body">{t.notFoundBody}</p>
        <Button variant="secondary" size="small" onClick={onClose}>
          {t.backToList}
        </Button>
      </div>
    );
  }
  if (result && !result.ok) {
    return (
      <Failure
        title={t.detailError}
        result={result}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!result) {
    return (
      <p role="status" className="py-6 text-body-s text-text-muted">
        {t.loading}
      </p>
    );
  }

  const item = result.body;
  const beach = item.beachId ? beaches[item.beachId] : undefined;

  return (
    <article aria-labelledby="inquiry-type" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-2 text-label-s text-text-muted">
          <StatusBadge status={item.status} />
          <span>
            {t.id}{" "}
            <span title={item.inquiryId} className="font-mono">
              {shortId(item.inquiryId)}
            </span>
          </span>
        </p>
        <h2
          id="inquiry-type"
          className="text-title-m font-semibold text-text-default"
        >
          {typeLabel(item.type)}
        </h2>
      </div>

      {item.legacy && (
        <Notice tone="neutral" title={t.legacyTitle}>
          {t.legacyBody}
        </Notice>
      )}

      {item.restricted ? (
        <Notice tone="neutral" title={t.restricted} />
      ) : (
        <section aria-label={t.message}>
          <p className="text-body leading-relaxed whitespace-pre-wrap text-text-default">
            {item.message}
          </p>
        </section>
      )}

      <dl className="divide-y divide-border-default border-y border-border-default">
        <Row label={t.beachActivity}>
          <BeachActivity item={item} beaches={beaches} />
          {beach && (
            <span className="ml-1 text-body-s text-text-muted">
              ({beach.region})
            </span>
          )}
        </Row>
        <Row label={t.received}>
          <span className="tabular-nums">{kstDateTime(item.receivedAt)}</span>
        </Row>
        <Row label={t.retention}>
          {fill(t.retentionValue, { date: retentionDate(item.receivedAt) })}
        </Row>
        <Row label={t.contact}>{t.contactValue}</Row>
        <Row label={t.currentStatus}>
          <StatusBadge status={item.status} />
          {item.updatedAt && (
            <span className="ml-2 text-body-s text-text-muted">
              {fill(t.updatedAt, { time: kstDateTime(item.updatedAt) })}
            </span>
          )}
        </Row>
        {!item.restricted && item.status === "rejected" && (
          <Row label={t.rejectReason}>
            <span className="whitespace-pre-wrap">
              {item.rejectReason ?? t.memoEmpty}
            </span>
          </Row>
        )}
        {!item.restricted && (
          <Row label={t.memo}>
            <span className="whitespace-pre-wrap">
              {item.memo ?? t.memoEmpty}
            </span>
          </Row>
        )}
      </dl>
      <p className="text-body-s text-text-muted">{t.readOnlyNote}</p>
    </article>
  );
}

// PC(1024 이상)인지. 정적 내보내기라 서버 렌더는 좁은 화면으로 보고 브라우저에서 다시 맞춤
const WIDE = "(min-width: 1024px)";
function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

// 닫힘 동작 시간(ms). 동작 줄이기를 켰으면 바로 닫음
const CLOSE_MS = 200;

// PC 상세: 목록 위에 뜨는 오른쪽 패널(모달 <dialog>). 목록은 움직이지 않고 뒤를 딤 처리함
// 열 때 오른쪽에서 밀려 들어오고 닫을 때 밀려 나감(@starting-style·allow-discrete). 동작 줄이기면 바로
// 포커스는 패널 안에 갇히고 Esc·바깥(딤) 누르기·닫기 버튼으로 닫음. 닫히면 포커스가 누른 줄로 돌아감
function DetailPanel({
  id,
  beaches,
  onClosed,
}: {
  id: string;
  beaches: Beaches;
  onClosed: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);
  const close = () => ref.current?.close();
  return (
    <dialog
      ref={ref}
      // 불러오는 중·실패에도 이름이 있게 고정 문구로 이름을 붙임
      aria-label={t.detailLabel}
      onClose={() => {
        const reduce = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        window.setTimeout(onClosed, reduce ? 0 : CLOSE_MS);
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-[480px] max-w-full overflow-y-auto border-l border-border-default bg-bg-surface px-6 py-5 text-text-default shadow-floating transition-[translate,overlay,display] transition-discrete duration-200 ease-out not-open:translate-x-full backdrop:bg-[rgb(11_26_44/0.4)] backdrop:transition-[opacity,overlay,display] backdrop:transition-discrete backdrop:duration-200 not-open:backdrop:opacity-0 starting:open:translate-x-full starting:open:backdrop:opacity-0 motion-reduce:transition-none motion-reduce:backdrop:transition-none"
    >
      <div className="flex flex-col gap-3">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={close}
            className="flex min-h-admin-control items-center rounded-admin-control px-2 text-body-s font-medium text-text-body hover:bg-bg-page"
          >
            {t.close}
          </button>
        </div>
        <InquiryDetailView id={id} beaches={beaches} onClose={close} />
      </div>
    </dialog>
  );
}

function InquiriesBody({ beaches }: { beaches: Beaches }) {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id");
  const wide = useWide();
  const toList = () => router.push("/inquiries/");

  return (
    <div className="px-4 py-5 md:px-10 md:pt-6 md:pb-10">
      {/* 좁은 화면: 상세를 열면 목록 대신 상세. PC: 목록은 그대로 두고 위에 패널 */}
      <div className={id && !wide ? "hidden" : undefined}>
        <InquiryList beaches={beaches} selectedId={id} />
      </div>
      {id && !wide && (
        <section aria-label={t.detailLabel} className="flex flex-col gap-3">
          <Link
            href="/inquiries/"
            className="flex min-h-touch items-center self-start text-body-s font-medium text-brand-default"
          >
            ← {t.backToList}
          </Link>
          <InquiryDetailView id={id} beaches={beaches} onClose={toList} />
        </section>
      )}
      {id && wide && (
        <DetailPanel key={id} id={id} beaches={beaches} onClosed={toList} />
      )}
    </div>
  );
}

export function InquiriesScreen({ beaches }: { beaches: Beaches }) {
  return (
    <AdminShell title={t.title}>
      {/* 정적 내보내기라 주소 ?id= 는 브라우저에서 읽음(useSearchParams는 Suspense 안) */}
      <Suspense fallback={null}>
        <InquiriesBody beaches={beaches} />
      </Suspense>
    </AdminShell>
  );
}
