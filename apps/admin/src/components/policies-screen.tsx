"use client";

import { ArrowUpRight } from "lucide-react";
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
import { Notice, SUCCESS_BADGE } from "./ui";

// 운영 정책 (#335·#460, 화면 설계서 6장 ADM-POL, 결정 기록 D20-8~11·D16-E5, 시안 4차 V22·VM15)
// - 읽기 전용. 9개 항목을 한 번에 하나씩. PC는 왼쪽 240px 목록 + 오른쪽 본문(둘 다 테두리 없음), 모바일은 목록 → 상세 두 단계
// - 내용은 빌드 때 넣은 저장소 파일(src/content/ops-policy.json)만 보여 줌. 운영 API를 부르지 않음
// - 노션 마지막 수정·동기화 시각과 안내를 머리 설명 한 줄에 두고, '최신'이라고 쓰지 않음(D16-E5)
// - 확정일·반영일·걸린 화면은 ops-policy.json에 없어 지어내지 않고 생략함
// - 상세는 정적 내보내기라 /policies/?id=n 으로 엶(데이터 출처·공지와 같음)

const t = messages.policies;

const detailHref = (n: number) => `/policies/?id=${n}`;

const BADGE_BASE =
  "inline-flex shrink-0 items-center rounded-admin-badge px-1.5 py-px text-caption leading-[18px] font-semibold whitespace-nowrap";

const DRAFT_BADGE =
  "bg-info-bg text-info-fg ring-1 ring-border-strong ring-inset";

// 원본의 확정·초안 표시를 문구 키로 보여 줌
const STATUS_LABEL: Record<PolicySection["status"], string> = {
  확정: t.status.confirmed,
  초안: t.status.draft,
};

function StatusBadge({ status }: { status: PolicySection["status"] }) {
  return (
    <span
      className={`${BADGE_BASE} ${status === "확정" ? SUCCESS_BADGE : DRAFT_BADGE}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

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

const SELECTED = "bg-bg-subtle text-text-default";
// PC에서 주소에 항목이 없을 때 보여 주는 첫 항목. 모바일은 목록만이라 강조하지 않음
const SELECTED_LG =
  "text-text-body hover:bg-bg-subtle lg:bg-bg-subtle lg:text-text-default";

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
      <ol className="flex flex-col gap-0.5">
        {snapshot.sections.map((s) => {
          const selected = s.number === current;
          return (
            <li key={s.number}>
              <Link
                href={detailHref(s.number)}
                aria-current={selected ? "page" : undefined}
                className={`flex min-h-touch items-center justify-between gap-2 rounded-admin-control px-2.5 py-2 text-body font-medium lg:min-h-0 ${
                  selected
                    ? SELECTED
                    : s.number === pcDefault
                      ? SELECTED_LG
                      : "text-text-body hover:bg-bg-subtle"
                }`}
              >
                <span>{s.title}</span>
                <StatusBadge status={s.status} />
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
    <article aria-labelledby="policy-title" className={className}>
      <div className="flex flex-wrap items-center gap-2.5">
        <h2
          id="policy-title"
          className="text-[18px] leading-snug font-semibold text-text-default"
        >
          {section.title}
        </h2>
        <StatusBadge status={section.status} />
      </div>
      <ol className="mt-4 flex list-decimal flex-col gap-3 pl-5 text-[15px] leading-[1.65] text-text-body marker:text-text-body">
        {section.items.map((runs, i) => (
          <li key={i}>
            <Runs runs={runs} />
          </li>
        ))}
      </ol>
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
  const confirmed = snapshot.sections.filter((s) => s.status === "확정").length;
  const draft = snapshot.sections.length - confirmed;
  const statusSummary =
    draft === 0
      ? fill(t.statusAllConfirmed, { count: snapshot.sections.length })
      : fill(t.statusMixed, { confirmed, draft });

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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[20px] leading-[1.4] font-semibold tracking-[-0.01em] text-text-default">
            {t.title}
          </h1>
          <p className="mt-0.5 text-label-s text-text-muted tabular-nums">
            {fill(t.introMeta, {
              statusSummary,
              revision: policyTime(snapshot.revision),
              fetchedAt: policyTime(snapshot.fetchedAt),
            })}
          </p>
        </div>
        {/* 바깥 원문이라 새 탭으로 엶(운영 화면 안 이동이 아니어서 로그인이 사라지지 않음) */}
        <a
          href={snapshot.source.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-touch items-center gap-1.5 rounded-admin-control border border-border-strong bg-bg-surface px-3 text-body font-medium whitespace-nowrap text-text-default shadow-card hover:bg-bg-page lg:h-admin-control"
        >
          {t.openNotion}
          <ArrowUpRight size={13} aria-hidden="true" />
          <span className="sr-only"> {t.newTab}</span>
        </a>
      </div>

      {id !== null && chosen === null && (
        <Notice tone="warn" title={t.notFound} role="status">
          <p>{t.notFoundHint}</p>
        </Notice>
      )}

      <div className="mt-2 grid grid-cols-1 gap-8 lg:grid-cols-[240px_1fr] lg:items-start">
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
