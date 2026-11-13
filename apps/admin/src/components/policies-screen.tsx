"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { fill, messages } from "@/lib/messages";
import {
  policyTime,
  sectionOf,
  type PolicyRun,
  type PolicySection,
  type PolicySnapshot,
} from "@/lib/policies";
import { AdminShell } from "./admin-shell";
import { Notice } from "./ui";

// 운영 정책 (#335, 화면 설계서 6장 ADM-POL, 결정 기록 D20-8~11·D16-E5, 시안 4차 V22·VM15)
// - 읽기 전용. 9개 항목을 한 번에 하나씩. PC는 왼쪽 목록 + 오른쪽 내용, 모바일은 목록 → 상세 두 단계(6장 모바일 규칙)
// - 내용은 빌드 때 넣은 저장소 파일(src/content/ops-policy.json)만 보여 줌. 운영 API를 부르지 않음
// - revision(노션 마지막 수정 시각)·가져온 시각·원문 링크를 보여 주고 '최신'이라고 쓰지 않음(D16-E5)
// - 시안의 '확정 5 · 초안 4'·항목 제목은 원본 페이지와 달라 원본(노션) 값을 그대로 씀
// - 상세는 정적 내보내기라 /policies/?id=n 으로 엶(데이터 출처·공지와 같음)

const t = messages.policies;

const detailHref = (n: number) => `/policies/?id=${n}`;

const BADGE =
  "inline-flex h-6 shrink-0 items-center rounded-admin-badge bg-bg-surface px-2 text-label-s font-medium whitespace-nowrap text-text-body ring-1 ring-border-strong ring-inset";

// 원본의 확정·초안 표시를 문구 키로 보여 줌
const STATUS_LABEL: Record<PolicySection["status"], string> = {
  확정: t.status.confirmed,
  초안: t.status.draft,
};

function Runs({ runs }: { runs: readonly PolicyRun[] }) {
  return runs.map((run, i) =>
    run.code ? (
      <code
        key={i}
        className="rounded-sm bg-bg-page px-1 font-mono text-[0.95em] text-text-default"
      >
        {run.text}
      </code>
    ) : run.bold ? (
      <strong key={i} className="font-semibold text-text-default">
        {run.text}
      </strong>
    ) : (
      <span key={i}>{run.text}</span>
    ),
  );
}

const SELECTED =
  "bg-brand-weak font-semibold text-text-default shadow-[inset_3px_0_0_var(--color-brand-default)]";
// PC에서 주소에 항목이 없을 때 보여 주는 첫 항목. 모바일은 목록만이라 강조하지 않음
const SELECTED_LG =
  "text-text-body hover:bg-bg-page lg:bg-brand-weak lg:font-semibold lg:text-text-default lg:shadow-[inset_3px_0_0_var(--color-brand-default)]";

function SectionList({
  snapshot,
  current,
  pcDefault,
  className,
}: {
  snapshot: PolicySnapshot;
  current: number | null;
  pcDefault: number | null;
  className: string;
}) {
  return (
    <nav aria-label={t.listLabel} className={className}>
      <ol className="flex flex-col overflow-hidden rounded-admin-box border border-border-default bg-bg-surface">
        {snapshot.sections.map((s) => {
          const selected = s.number === current;
          return (
            <li
              key={s.number}
              className="border-b border-border-default last:border-b-0"
            >
              <Link
                href={detailHref(s.number)}
                aria-current={selected ? "page" : undefined}
                className={`flex min-h-touch items-center justify-between gap-3 px-4 py-2.5 text-body-s lg:min-h-admin-control ${
                  selected
                    ? SELECTED
                    : s.number === pcDefault
                      ? SELECTED_LG
                      : "text-text-body hover:bg-bg-page"
                }`}
              >
                <span>
                  {fill(t.itemTitle, { number: s.number, title: s.title })}
                </span>
                <span className={BADGE}>{STATUS_LABEL[s.status]}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function SectionDetail({
  section,
  className,
}: {
  section: PolicySection;
  className: string;
}) {
  return (
    <article
      aria-labelledby="policy-title"
      className={`rounded-admin-box border border-border-default bg-bg-surface px-4 py-4 md:px-6 md:py-5 ${className}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2
          id="policy-title"
          className="text-title-m font-semibold text-text-default"
        >
          {fill(t.itemTitle, { number: section.number, title: section.title })}
        </h2>
        <span className={BADGE}>{STATUS_LABEL[section.status]}</span>
      </div>
      <ul className="mt-3 flex list-disc flex-col gap-2 pl-5 text-body text-text-body marker:text-text-muted">
        {section.items.map((runs, i) => (
          <li key={i}>
            <Runs runs={runs} />
          </li>
        ))}
      </ul>
      <p className="mt-4 text-label-s text-text-muted">
        {fill(t.basis, { basis: section.basis })}
      </p>
    </article>
  );
}

function PoliciesBody({ snapshot }: { snapshot: PolicySnapshot }) {
  const params = useSearchParams();
  const id = params.get("id");
  const chosen = sectionOf(snapshot, id);
  // 고른 항목이 없으면 PC는 첫 항목을 보여 주고, 모바일은 목록만 보여 줌
  const shown = chosen ?? (id === null ? snapshot.sections[0]! : null);
  const mobileDetail = chosen !== null;

  return (
    <div className="flex w-full flex-col gap-4 px-4 py-5 md:px-10 md:pt-6 md:pb-10">
      {mobileDetail && (
        <Link
          href="/policies/"
          className="inline-flex min-h-touch items-center self-start text-body-s font-medium text-brand-default underline-offset-2 hover:underline lg:hidden"
        >
          {t.backLink}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-title-l font-semibold text-text-default">
            {t.title}
          </h1>
          <p className="mt-1 text-body-s text-text-muted">{t.intro}</p>
          <p className="mt-1 text-label-s text-text-muted tabular-nums">
            {[
              fill(t.revision, { time: policyTime(snapshot.revision) }),
              fill(t.fetchedAt, { time: policyTime(snapshot.fetchedAt) }),
            ].join(t.metaJoin)}
          </p>
        </div>
        {/* 바깥 원문이라 새 탭으로 엶(운영 화면 안 이동이 아니어서 로그인이 사라지지 않음) */}
        <a
          href={snapshot.source.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-touch items-center rounded-admin-control border border-border-strong bg-bg-surface px-3 text-body font-medium text-text-default hover:bg-bg-page lg:h-admin-control"
        >
          {t.openNotion}
          <span className="sr-only"> {t.newTab}</span>
        </a>
      </div>

      <Notice tone="neutral" title={t.syncTitle}>
        <p>{t.syncBody}</p>
      </Notice>

      {id !== null && chosen === null && (
        <Notice tone="warn" title={t.notFound} role="status">
          <p>{t.notFoundHint}</p>
        </Notice>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(240px,300px)_1fr] lg:items-start">
        <SectionList
          snapshot={snapshot}
          current={chosen?.number ?? null}
          pcDefault={chosen ? null : (shown?.number ?? null)}
          className={mobileDetail ? "hidden lg:block" : ""}
        />
        {shown && (
          <SectionDetail
            section={shown}
            className={mobileDetail ? "" : "hidden lg:block"}
          />
        )}
      </div>
    </div>
  );
}

export function PoliciesScreen({ snapshot }: { snapshot: PolicySnapshot }) {
  return (
    <AdminShell title={t.title}>
      {/* 정적 내보내기라 주소 ?id= 는 브라우저에서 읽음(useSearchParams는 Suspense 안) */}
      <Suspense fallback={null}>
        <PoliciesBody snapshot={snapshot} />
      </Suspense>
    </AdminShell>
  );
}
