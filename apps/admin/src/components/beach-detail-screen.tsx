"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import {
  BEACH_MEMO_MAX,
  charCount,
  displayOf,
  editUrl,
  fetchBeachMemo,
  filePath,
  historyUrl,
  METRIC_KEYS,
  parseBeachMemo,
  type BeachFile,
  type BeachMemo,
  type BeachRecord,
  saveBeachMemo,
  type ZoneCheck,
} from "@/lib/beaches";
import { kstDateTime } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import { AdminShell } from "./admin-shell";
import { seasonText } from "./beaches-screen";
import {
  DisplayBadge,
  ExpiredNotice,
  PublishedAlert,
  ReasonList,
  usePublished,
} from "./beach-status";
import { Button, Notice } from "./ui";

// 해변 관리 상세 (BRD-150, 화면 설계서 6장 ADM-BCH, 시안 4차 V3·VM5·E7·F6)
// - 기본 정보·데이터 연결·검증 결과·사진은 읽기 전용. 칸마다 'GitHub에서 수정'(그 값이 있는 파일)
// - 구역·관측소 '변경' 링크·노출 토글·저장 버튼 없음(10/21 자동 판정, D15-4)
// - 지금 표시 상태는 게시본 그대로(G1). 못 받으면 '확인 못 함'
// - 운영 메모만 저장(운영 DB). 편집 권한만, 데모 계정은 읽지도 않음. 화면 상태를 먼저 바꾸지 않고 저장 성공 뒤 다시 읽음

const t = messages.beaches;

function ExternalLink({
  href,
  label,
  children,
}: {
  href: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      className="inline-flex min-h-touch items-center text-label-s font-medium text-brand-default underline underline-offset-2 lg:min-h-0"
    >
      {children}
    </a>
  );
}

function EditLink({
  file,
  id,
  section,
}: {
  file: BeachFile;
  id: string;
  section: string;
}) {
  const path = filePath(file, id);
  return (
    <ExternalLink
      href={editUrl(file, id)}
      label={fill(t.editOnGitHubFor, { section, path })}
    >
      {t.editOnGitHub}
    </ExternalLink>
  );
}

function Section({
  id,
  title,
  edit,
  children,
}: {
  id: string;
  title: string;
  edit?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 rounded-admin-box border border-border-default bg-bg-surface px-4 py-4 md:px-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3">
        <h2 id={id} className="text-title-s font-semibold text-text-default">
          {title}
        </h2>
        {edit}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 py-2 sm:grid-cols-[148px_1fr] sm:gap-3">
      <dt className="text-body-s text-text-muted">{label}</dt>
      <dd className="text-body break-words text-text-default">{children}</dd>
    </div>
  );
}

const orNone = (value: string | null) => value ?? t.none;

function zoneValue(check: ZoneCheck): ReactNode {
  return (
    <>
      <span>
        {fill(t.checkZoneValue, {
          status: orNone(check.status),
          zone: orNone(check.zone),
        })}
      </span>
      {check.basis && (
        <span className="block text-body-s text-text-body">{check.basis}</span>
      )}
      {(check.checkedAt || check.rule) && (
        <span className="block text-label-s text-text-muted">
          {fill(t.checkZoneAt, {
            time: orNone(check.checkedAt),
            rule: orNone(check.rule),
          })}
        </span>
      )}
    </>
  );
}

function StatusSection({
  beach,
  state,
}: {
  beach: BeachRecord;
  state: ReturnType<typeof usePublished>;
}) {
  const display = displayOf(state.published, beach.id, state.nowMs);
  return (
    <Section id="beach-status" title={t.detailStatus}>
      <PublishedAlert state={state} />
      <div className="flex flex-col gap-2">
        <DisplayBadge display={display} />
        <ReasonList display={display} />
        <ExpiredNotice display={display} />
        {state.published !== "loading" && state.published?.available && (
          <p className="text-label-s text-text-muted">
            {fill(t.statusAsOf, {
              time: kstDateTime(state.published.generatedAt),
            })}
          </p>
        )}
        <p className="text-body-s text-text-body">{t.detailStatusNote}</p>
      </div>
    </Section>
  );
}

function BasicSection({ beach }: { beach: BeachRecord }) {
  return (
    <Section
      id="beach-basic"
      title={t.basicTitle}
      edit={<EditLink file="beach" id={beach.id} section={t.basicTitle} />}
    >
      <dl className="divide-y divide-border-default">
        <Row label={t.fieldNameKo}>{beach.nameKo}</Row>
        <Row label={t.fieldNameEn}>{beach.nameEn}</Row>
        <Row label={t.fieldId}>
          <span className="font-mono">{beach.id}</span>
        </Row>
        <Row label={t.fieldSlug}>
          <span className="font-mono">{beach.slug}</span>
        </Row>
        <Row label={t.fieldRegion}>
          {beach.sido} {beach.sigungu}
        </Row>
        <Row label={t.fieldCoast}>
          {beach.coast in t.coast
            ? t.coast[beach.coast as keyof typeof t.coast]
            : beach.coast}
        </Row>
        <Row label={t.fieldCoords}>
          <span className="tabular-nums">
            {beach.lat}, {beach.lng}
          </span>
        </Row>
        <Row label={t.fieldActivities}>
          {beach.activities
            .map((a) =>
              a in t.activity ? t.activity[a as keyof typeof t.activity] : a,
            )
            .join(" · ")}
        </Row>
        <Row label={t.fieldShown}>{beach.hidden ? t.shownNo : t.shownYes}</Row>
        <Row label={t.fieldAliases}>
          <span className="flex flex-wrap items-center gap-x-3">
            <span>
              {beach.inMeta
                ? beach.aliases.length > 0
                  ? beach.aliases.join(" · ")
                  : t.aliasesNone
                : t.metaMissing}
            </span>
            <EditLink file="meta" id={beach.id} section={t.fieldAliases} />
          </span>
        </Row>
      </dl>
    </Section>
  );
}

function LinksSection({ beach }: { beach: BeachRecord }) {
  const th = "border-b border-border-default px-3 py-2 text-left";
  const td = "border-b border-border-default px-3 py-2 align-top";
  const rows: { source: string; value: ReactNode; file: BeachFile }[] = [
    {
      source: t.sourceWarning,
      file: "beach",
      value: (
        <>
          <span className="block">
            {fill(t.zoneSea, { zone: beach.zones.sea })}
          </span>
          <span className="block">
            {beach.zones.land
              ? fill(t.zoneLand, { zone: beach.zones.land })
              : t.zoneLandNone}
          </span>
        </>
      ),
    },
    {
      source: t.sourceObservation,
      file: "beach",
      value: (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          {METRIC_KEYS.map((key) => {
            const station = beach.stations[key];
            return (
              <div key={key} className="contents">
                <dt className="text-text-muted">{t.metric[key]}</dt>
                <dd>
                  {station
                    ? fill(t.station, {
                        name: station.name,
                        distance: station.distanceKm,
                        id: station.id,
                      })
                    : t.stationNone}
                </dd>
              </div>
            );
          })}
        </dl>
      ),
    },
    {
      source: t.sourceSeason,
      file: "meta",
      value: beach.inMeta ? seasonText(beach.season) : t.metaMissing,
    },
  ];
  return (
    <Section id="beach-links" title={t.linksTitle}>
      <table className="w-full border-separate border-spacing-0 overflow-hidden rounded-admin-control border border-border-default text-body-s">
        <thead>
          <tr className="bg-bg-page text-label-s font-semibold text-text-body">
            <th scope="col" className={th}>
              {t.colSource}
            </th>
            <th scope="col" className={th}>
              {t.colConnection}
            </th>
            <th scope="col" className={`${th} hidden sm:table-cell`}>
              {t.colFile}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.source}>
              <th
                scope="row"
                className={`${td} text-left font-medium whitespace-nowrap text-text-default`}
              >
                {row.source}
              </th>
              <td className={`${td} text-text-body`}>
                {row.value}
                <span className="mt-1 block sm:hidden">
                  <EditLink
                    file={row.file}
                    id={beach.id}
                    section={row.source}
                  />
                </span>
              </td>
              <td className={`${td} hidden sm:table-cell`}>
                <span className="block font-mono text-label-s text-text-muted">
                  {filePath(row.file, beach.id)}
                </span>
                <EditLink file={row.file} id={beach.id} section={row.source} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-label-s text-text-muted">{t.linksNote}</p>
    </Section>
  );
}

function CheckSection({ beach }: { beach: BeachRecord }) {
  const check = beach.check;
  return (
    <Section
      id="beach-check"
      title={t.checkTitle}
      edit={<EditLink file="coverage" id={beach.id} section={t.checkTitle} />}
    >
      {check ? (
        <>
          <p className="text-label-s text-text-muted">{t.checkNote}</p>
          <dl className="divide-y divide-border-default">
            <Row label={t.checkStage}>{orNone(check.stage)}</Row>
            <Row label={t.checkCoords}>{orNone(check.coordsSource)}</Row>
            <Row label={t.checkSea}>{zoneValue(check.sea)}</Row>
            <Row label={t.checkLand}>{zoneValue(check.land)}</Row>
            <Row label={t.checkStations}>
              <span className="text-body-s">{orNone(check.stationBasis)}</span>
            </Row>
            <Row label={t.checkResponse}>{orNone(check.responseCheck)}</Row>
            <Row label={t.checkExclusion}>{orNone(check.exclusion)}</Row>
            <Row label={t.checkReview}>{orNone(check.reviewReason)}</Row>
          </dl>
        </>
      ) : (
        <Notice tone="warn" title={t.checkMissing}>
          {t.checkMissingBody}
        </Notice>
      )}
    </Section>
  );
}

function PhotoSection({ beach }: { beach: BeachRecord }) {
  const photo = beach.photo;
  return (
    <Section
      id="beach-photo"
      title={t.photoTitle}
      edit={<EditLink file="beach" id={beach.id} section={t.photoTitle} />}
    >
      {photo ? (
        <dl className="divide-y divide-border-default">
          <Row label={t.photoTitleField}>{orNone(photo.title)}</Row>
          <Row label={t.photoSource}>{photo.source}</Row>
          <Row label={t.photoLicense}>
            {photo.license in t.license
              ? t.license[photo.license as keyof typeof t.license]
              : photo.license}
          </Row>
          <Row label={t.photoOpen}>
            <ExternalLink href={photo.url}>
              {t.photoOpen} {t.newTab}
            </ExternalLink>
          </Row>
        </dl>
      ) : (
        <p className="text-body-s text-text-body">{t.photoNone}</p>
      )}
    </Section>
  );
}

function HistorySection({ beach }: { beach: BeachRecord }) {
  const links: [BeachFile, string][] = [
    ["beach", t.historyBeach],
    ["meta", t.historyMeta],
    ["coverage", t.historyCoverage],
  ];
  return (
    <Section id="beach-history" title={t.historyTitle}>
      <p className="text-body-s text-text-body">{t.historyNote}</p>
      <ul className="flex flex-col gap-1">
        {links.map(([file, label]) => (
          <li key={file}>
            <ExternalLink href={historyUrl(file, beach.id)}>
              {label} {t.newTab}
            </ExternalLink>
            <span className="ml-2 font-mono text-label-s text-text-muted">
              {filePath(file, beach.id)}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

type SaveError =
  | { kind: "conflict" }
  | { kind: "replay" }
  | { kind: "failed"; requestId: string | null };

// 운영 메모: 편집 권한만 저장. 보기 권한은 읽기만(비활성 + 안내), 데모 계정은 요청하지 않음
function MemoSection({ beachId }: { beachId: string }) {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const demo = snapshot.status !== "signed_out" && snapshot.pool === "demo";
  const canEdit =
    snapshot.status !== "signed_out" &&
    !demo &&
    snapshot.groups.some((g) => g === "editor" || g === "publisher");
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}|${generation}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: OpsResult<unknown>;
  } | null>(null);
  // 쓰는 중인 값과 그 기준이 된 메모. 다시 읽어도 쓰던 내용을 조용히 지우지 않음
  const [base, setBase] = useState<BeachMemo | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SaveError | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  // 다음에 받은 메모를 쓰던 값 대신 그대로 받음('새 내용 불러오기')
  const [accept, setAccept] = useState(false);
  const sent = useRef<{ body: string; key: string } | null>(null);

  useEffect(() => {
    if (demo) return;
    let live = true;
    void fetchBeachMemo(() => session.accessToken(), beachId).then((result) => {
      if (live) setLoaded({ key, result });
    });
    return () => {
      live = false;
    };
  }, [session, beachId, key, demo]);

  const result = loaded?.key === key ? loaded.result : null;
  const memo = result?.ok ? parseBeachMemo(result.body, beachId) : null;
  const draftValue = draft.trim() === "" ? null : draft;
  const changed = base !== null && draftValue !== base.memo;
  if (
    memo &&
    (base === null || accept || (!changed && memo.version !== base.version))
  ) {
    setBase(memo);
    setDraft(memo.memo ?? "");
    setAccept(false);
  } else if (
    memo &&
    base !== null &&
    memo.version === base.version &&
    memo.updatedAt !== base.updatedAt
  ) {
    // 내가 저장한 version을 다시 읽음: 저장 시각만 받고 그사이 쓰던 내용은 그대로 둠
    setBase({ ...base, updatedAt: memo.updatedAt });
  }
  const stale = memo !== null && base !== null && memo.version !== base.version;
  const tooLong = charCount(draft) > BEACH_MEMO_MAX;

  if (demo) {
    return (
      <Section id="beach-memo" title={t.memoTitle}>
        <Notice tone="neutral" title={t.memoDemo} />
      </Section>
    );
  }

  const save = () => {
    if (!base || !canEdit || busy || !changed || tooLong) return;
    const body = { version: base.version, memo: draftValue };
    const text = JSON.stringify(body);
    if (sent.current?.body !== text) {
      sent.current = { body: text, key: crypto.randomUUID() };
    }
    const idem = sent.current.key;
    setBusy(true);
    setError(null);
    setSaved(false);
    void saveBeachMemo(() => session.accessToken(), beachId, body, idem)
      .then((res) => {
        if (res.ok) {
          sent.current = null;
          // 서버가 확인한 새 version을 기준으로 둠. 다시 읽기 전·다시 읽기 실패 때 옛 version으로 또 보내 409가 나지 않게
          setBase({
            ...base,
            memo: body.memo,
            version: res.body.version,
          });
          setSaved(true);
          // 다시 읽기는 저장 시각만 받음(응답 전에 이어 쓴 내용을 덮지 않게 accept는 켜지 않음)
          setAttempt((n) => n + 1);
        } else if (res.status === 409) {
          setError({
            kind: res.reason === "idempotency_mismatch" ? "replay" : "conflict",
          });
        } else {
          setError({
            kind: "failed",
            requestId: "requestId" in res ? res.requestId : null,
          });
        }
      })
      .finally(() => setBusy(false));
  };

  const reload = () => {
    setAccept(true);
    setError(null);
    setAttempt((n) => n + 1);
  };
  const copy = () => {
    void navigator.clipboard?.writeText(draft).then(() => setCopied(true));
  };

  const fieldClass =
    "w-full rounded-admin-control border border-border-strong bg-bg-surface px-2.5 py-2 text-body text-text-default outline-none placeholder:text-text-muted focus:border-brand-default focus:ring-[3px] focus:ring-brand-border disabled:bg-bg-page disabled:text-text-muted";

  return (
    <Section id="beach-memo" title={t.memoTitle}>
      {result === null && base === null && (
        <p role="status" className="text-body-s text-text-muted">
          {t.memoLoading}
        </p>
      )}
      {result && !result.ok && result.code === "reauth" && (
        <Notice tone="warn" title={t.reauth} role="alert" />
      )}
      {result && (!result.ok ? result.code !== "reauth" : memo === null) && (
        <Notice tone="fail" title={t.memoError} role="alert">
          {/* 응답이 없거나 서버 오류일 때만 '응답하지 않아요'. 그 밖(403·404·모양이 틀림)은 읽지 못했다고 씀 */}
          <p>
            {!result.ok && (result.status === 0 || result.status >= 500)
              ? t.memoErrorHint
              : t.memoErrorUnknown}
          </p>
          {!result.ok && "requestId" in result && result.requestId && (
            <p>{fill(t.requestId, { id: result.requestId })}</p>
          )}
          <Button
            variant="secondary"
            size="small"
            className="mt-2"
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t.retry}
          </Button>
        </Notice>
      )}
      {base && (
        <>
          {!canEdit && <Notice tone="neutral" title={t.memoNeedEditor} />}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="beach-memo-text"
              className="text-body font-medium text-text-default"
            >
              {t.memoLabel}
            </label>
            <textarea
              id="beach-memo-text"
              rows={4}
              value={draft}
              disabled={!canEdit || busy}
              aria-describedby="beach-memo-hint"
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
                setSaved(false);
              }}
              className={fieldClass}
            />
            <p id="beach-memo-hint" className="text-label-s text-text-muted">
              {tooLong ? (
                <span className="text-danger-text">
                  {fill(t.tooLong, {
                    max: BEACH_MEMO_MAX,
                    count: charCount(draft),
                  })}
                </span>
              ) : (
                t.memoHint
              )}
            </p>
            <p className="text-label-s text-text-muted">
              {base.updatedAt
                ? fill(t.memoUpdatedAt, { time: kstDateTime(base.updatedAt) })
                : t.memoNever}
            </p>
          </div>
          {stale && (
            <Notice tone="warn" title={t.conflictVersion} role="alert">
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="secondary" size="small" onClick={reload}>
                  {t.reload}
                </Button>
                <Button variant="secondary" size="small" onClick={copy}>
                  {copied ? t.copied : t.copyMemo}
                </Button>
              </div>
            </Notice>
          )}
          {error && !stale && (
            <Notice
              tone={error.kind === "failed" ? "fail" : "warn"}
              title={
                error.kind === "conflict"
                  ? t.conflictVersion
                  : error.kind === "replay"
                    ? t.conflictReplay
                    : t.saveFailed
              }
              role="alert"
            >
              {error.kind === "failed" ? (
                <>
                  <p>{t.saveFailedHint}</p>
                  {error.requestId && (
                    <p>{fill(t.requestId, { id: error.requestId })}</p>
                  )}
                </>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="secondary" size="small" onClick={reload}>
                    {t.reload}
                  </Button>
                  {error.kind === "conflict" && (
                    <Button variant="secondary" size="small" onClick={copy}>
                      {copied ? t.copied : t.copyMemo}
                    </Button>
                  )}
                </div>
              )}
            </Notice>
          )}
          {saved && !changed && (
            <Notice tone="brand" title={t.saved} role="status" />
          )}
          {/* 저장 바: 아래에 붙어 긴 메모를 쓰는 중에도 보임(화면 설계서 6장 모바일 규칙) */}
          <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-3 border-t border-border-default bg-bg-surface px-1 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <span className="text-body-s text-text-muted" aria-live="polite">
              {busy ? t.saving : changed ? t.changed : t.noChanges}
            </span>
            <Button
              size="small"
              disabled={!canEdit || busy || !changed || tooLong || stale}
              onClick={save}
            >
              {t.save}
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}

function DetailBody({ beach }: { beach: BeachRecord }) {
  const state = usePublished();
  return (
    <article
      aria-labelledby="beach-name"
      className="flex flex-col gap-4 px-4 py-5 md:px-10 md:pt-6 md:pb-10"
    >
      <Link
        href="/beaches/"
        className="flex min-h-touch items-center self-start text-body-s font-medium text-brand-default"
      >
        ← {t.backToList}
      </Link>
      <div className="flex flex-col gap-1">
        <h1
          id="beach-name"
          className="text-title-l font-semibold text-text-default"
        >
          {beach.nameKo}
        </h1>
        <p className="text-body-s text-text-muted">
          {beach.sido} {beach.sigungu} ·{" "}
          <span className="font-mono">{beach.id}</span> ·{" "}
          {beach.hidden ? t.shownNo : t.shownYes}
        </p>
      </div>
      <Notice tone="neutral" title={t.sourceNote} />
      <StatusSection beach={beach} state={state} />
      <BasicSection beach={beach} />
      <LinksSection beach={beach} />
      <CheckSection beach={beach} />
      <PhotoSection beach={beach} />
      <HistorySection beach={beach} />
      <MemoSection beachId={beach.id} />
    </article>
  );
}

export function BeachDetailScreen({ beach }: { beach: BeachRecord }) {
  return (
    <AdminShell title={t.title}>
      <DetailBody beach={beach} />
    </AdminShell>
  );
}
