"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { useSessionSnapshot } from "@/lib/auth/provider";
import {
  displayOf,
  filterBeaches,
  historyUrl,
  sidoList,
  type BeachSeason,
  type BeachSummary,
} from "@/lib/beaches";
import { kstDateTime } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import { AdminShell } from "./admin-shell";
import { DisplayBadge, PublishedAlert, usePublished } from "./beach-status";
import { Notice } from "./ui";

// 해변 관리 목록 (BRD-150, 화면 설계서 6장 ADM-BCH, 시안 4차 V2·VM4·E7)
// - 읽기 전용: 편집 칸·노출 토글·일괄 변경 없음(D15-4). 해변 정보는 빌드 때 저장소 파일에서 읽어 옴
// - 지금 표시 상태는 게시본 그대로(G1). 못 받으면 '확인 못 함'(판단불가 계열)
// - 데이터 연결은 특보·관측·운영 기간만. 출입 통제 열 없음(G2)
// - 마지막 수정은 저장소 커밋 기록 링크(빌드 시각의 커밋 날짜를 화면에 굳히지 않음)

const t = messages.beaches;

type Published = ReturnType<typeof usePublished>;

export function seasonText(season: BeachSeason | null): string {
  if (!season) return t.seasonNone;
  if (season.status === "closed") {
    return fill(t.seasonClosed, { year: season.year });
  }
  // 개장인데 날짜가 비면 미개장으로 바꾸지 않음(결측을 다른 값으로 채우지 않음)
  if (!season.openDate || !season.closeDate) {
    return fill(t.seasonOpenNoDates, { year: season.year });
  }
  const md = (iso: string) => {
    const [, m, d] = iso.split("-");
    return `${Number(m)}.${Number(d)}`;
  };
  return fill(t.seasonOpen, {
    year: season.year,
    from: md(season.openDate),
    to: md(season.closeDate),
  });
}

function warningText(b: BeachSummary): string {
  if (!b.hasCheck) return `${b.seaZone} · ${t.checkMissing}`;
  return fill(t.warningLinked, {
    zone: b.seaZone,
    sea: b.seaStatus ?? t.checkMissing,
    land: b.landStatus ?? t.checkMissing,
  });
}

function observationText(b: BeachSummary): string {
  return fill(b.waveHeight ? t.observationLinked : t.observationNoWave, {
    count: b.stations,
  });
}

function aliasText(beach: BeachSummary): string {
  if (!beach.inMeta) return t.metaMissing;
  const [first, ...rest] = beach.aliases;
  if (!first) return t.aliasesNone;
  return rest.length > 0
    ? fill(t.aliasesMore, { first, count: rest.length })
    : first;
}

const detailHref = (id: string) => `/beaches/${encodeURIComponent(id)}/`;

function ShownBadge({ hidden }: { hidden: boolean }) {
  return hidden ? (
    <span className="inline-flex h-6 items-center rounded-admin-badge bg-bg-surface px-1.5 text-label-s font-semibold whitespace-nowrap text-text-muted outline-1 -outline-offset-1 outline-border-strong outline-dashed">
      {t.hidden}
    </span>
  ) : (
    <span className="inline-flex h-6 items-center rounded-admin-badge bg-brand-weak px-1.5 text-label-s font-semibold whitespace-nowrap text-brand-default ring-1 ring-brand-border">
      {t.shown}
    </span>
  );
}

function Links({ beach }: { beach: BeachSummary }) {
  const rows: [string, string][] = [
    [t.linkWarning, warningText(beach)],
    [t.linkObservation, observationText(beach)],
    [t.linkSeason, beach.inMeta ? seasonText(beach.season) : t.metaMissing],
  ];
  return (
    <dl className="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-0.5 text-label-s">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-text-muted">{label}</dt>
          <dd className="text-text-body">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function HistoryLink({ beach }: { beach: BeachSummary }) {
  return (
    <a
      href={historyUrl("beach", beach.id)}
      target="_blank"
      rel="noreferrer"
      aria-label={fill(t.historyLinkFor, { name: beach.nameKo })}
      className="text-label-s font-medium whitespace-nowrap text-brand-default underline-offset-2 hover:underline"
    >
      {t.historyLink}
    </a>
  );
}

function BeachTable({
  items,
  published,
}: {
  items: readonly BeachSummary[];
  published: Published["published"];
}) {
  const th = "border-b border-border-default px-3 py-2 whitespace-nowrap";
  const td = "border-b border-border-default px-3 py-2 align-top";
  return (
    <table className="hidden w-full border-separate border-spacing-0 overflow-hidden rounded-admin-box border border-border-default bg-bg-surface text-body md:table">
      <thead>
        <tr className="bg-bg-page text-left text-label-s font-semibold text-text-body">
          <th scope="col" className={`${th} pl-4`}>
            {t.colBeach}
          </th>
          <th scope="col" className={th}>
            {t.colShown}
          </th>
          <th scope="col" className={th}>
            {t.colStatus}
          </th>
          <th scope="col" className={th}>
            {t.colLinks}
          </th>
          <th scope="col" className={`${th} hidden lg:table-cell`}>
            {t.colPhoto}
          </th>
          <th scope="col" className={`${th} hidden lg:table-cell`}>
            {t.colAliases}
          </th>
          <th scope="col" className={`${th} pr-4`}>
            {t.colHistory}
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((b) => (
          <tr key={b.id} className="hover:bg-bg-page">
            <td className={`${td} pl-4`}>
              <Link
                href={detailHref(b.id)}
                className="font-medium text-text-default underline-offset-2 hover:underline"
              >
                {b.nameKo}
              </Link>
              <p className="text-label-s text-text-muted">
                {b.sido} {b.sigungu} · <span className="font-mono">{b.id}</span>
              </p>
            </td>
            <td className={td}>
              <ShownBadge hidden={b.hidden} />
            </td>
            <td className={td}>
              <DisplayBadge display={displayOf(published, b.id)} />
            </td>
            <td className={td}>
              <Links beach={b} />
            </td>
            <td
              className={`${td} hidden text-body-s whitespace-nowrap text-text-body lg:table-cell`}
            >
              {b.hasPhoto ? t.photoYes : t.photoNo}
            </td>
            <td
              className={`${td} hidden text-body-s text-text-body lg:table-cell`}
            >
              {aliasText(b)}
            </td>
            <td className={`${td} pr-4`}>
              <HistoryLink beach={b} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// 모바일: 표 대신 카드(값은 빼지 않음)
function BeachCards({
  items,
  published,
}: {
  items: readonly BeachSummary[];
  published: Published["published"];
}) {
  return (
    <ul className="flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface md:hidden">
      {items.map((b) => (
        <li key={b.id} className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <Link
              href={detailHref(b.id)}
              className="flex min-h-touch flex-col justify-center"
            >
              <span className="text-body font-medium text-text-default underline-offset-2 hover:underline">
                {b.nameKo}
              </span>
              <span className="text-label-s text-text-muted">
                {b.sido} {b.sigungu} · <span className="font-mono">{b.id}</span>
              </span>
            </Link>
            <ShownBadge hidden={b.hidden} />
          </div>
          <DisplayBadge display={displayOf(published, b.id)} />
          <Links beach={b} />
          <dl className="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-0.5 text-label-s">
            <dt className="text-text-muted">{t.colPhoto}</dt>
            <dd className="text-text-body">
              {b.hasPhoto ? t.photoYes : t.photoNo}
            </dd>
            <dt className="text-text-muted">{t.colAliases}</dt>
            <dd className="text-text-body">{aliasText(b)}</dd>
            <dt className="text-text-muted">{t.colHistory}</dt>
            <dd>
              <HistoryLink beach={b} />
            </dd>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function BeachesBody({ beaches }: { beaches: readonly BeachSummary[] }) {
  const snapshot = useSessionSnapshot();
  const state = usePublished();
  const [query, setQuery] = useState("");
  const [sido, setSido] = useState<string | null>(null);
  const searchId = useId();
  const regionId = useId();
  const items = filterBeaches(beaches, query, sido);
  const fieldClass =
    "h-touch rounded-admin-control border border-border-strong bg-bg-surface px-2.5 text-body text-text-default outline-none placeholder:text-text-muted focus:border-brand-default focus:ring-[3px] focus:ring-brand-border lg:h-admin-control";

  return (
    <section
      aria-labelledby="beaches-title"
      className="flex flex-col gap-4 px-4 py-5 md:px-10 md:pt-6 md:pb-10"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h1
          id="beaches-title"
          className="text-title-l font-semibold text-text-default"
        >
          {t.title}
        </h1>
        <span className="rounded-admin-badge bg-bg-page px-1.5 text-caption font-semibold text-text-body ring-1 ring-border-default">
          {t.readOnlyBadge}
        </span>
        {snapshot.status !== "signed_out" && snapshot.pool === "demo" && (
          <span className="text-caption text-text-muted">{t.demo}</span>
        )}
        <p className="w-full text-body-s text-text-muted">{t.description}</p>
      </div>

      <Notice tone="neutral" title={t.sourceNote} />
      <PublishedAlert state={state} />
      {state.published !== "loading" && state.published?.available && (
        <p className="text-label-s text-text-muted">
          {fill(t.statusAsOf, {
            time: kstDateTime(state.published.generatedAt),
          })}
        </p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1">
          <label
            htmlFor={searchId}
            className="text-label-s font-medium text-text-body"
          >
            {t.searchLabel}
          </label>
          <input
            id={searchId}
            type="search"
            value={query}
            placeholder={t.searchPlaceholder}
            onChange={(e) => setQuery(e.target.value)}
            className={fieldClass}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label
            htmlFor={regionId}
            className="text-label-s font-medium text-text-body"
          >
            {t.regionLabel}
          </label>
          <select
            id={regionId}
            value={sido ?? ""}
            onChange={(e) => setSido(e.target.value || null)}
            className={fieldClass}
          >
            <option value="">{t.regionAll}</option>
            {sidoList(beaches).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p role="status" className="text-body-s text-text-muted tabular-nums">
        {fill(t.count, { total: beaches.length, shown: items.length })}
      </p>

      {items.length === 0 ? (
        <div className="rounded-admin-box border border-border-default bg-bg-surface px-4 py-6 text-center">
          <p className="text-title-s font-semibold text-text-default">
            {t.emptyTitle}
          </p>
          <p className="mt-1 text-body-s text-text-muted">{t.emptyBody}</p>
        </div>
      ) : (
        <>
          <BeachTable items={items} published={state.published} />
          <BeachCards items={items} published={state.published} />
        </>
      )}
    </section>
  );
}

export function BeachesScreen({
  beaches,
}: {
  beaches: readonly BeachSummary[];
}) {
  return (
    <AdminShell title={t.title}>
      <BeachesBody beaches={beaches} />
    </AdminShell>
  );
}
