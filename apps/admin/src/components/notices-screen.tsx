"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import type { OpsResult } from "@/lib/auth/ops-fetch";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import { kstDateTime } from "@/lib/inquiries";
import { fill, messages } from "@/lib/messages";
import {
  createNotice,
  fetchNotices,
  fromKstInput,
  isNoticeState,
  kstRange,
  NOTICE_KINDS,
  NOTICE_STATES,
  noticeAction,
  periodProblems,
  saveProblems,
  textChecks,
  toKstInput,
  updateNotice,
  type NoticeContent,
  type NoticeKind,
  type NoticeProblem,
  type NoticeState,
  type NoticeTexts,
  type NoticeView,
  type TextField,
} from "@/lib/notices";
import {
  graphemeLength,
  NOTICE_DRAFT_TEXT_MAX,
  NOTICE_TEXT_MAX,
} from "@baradun/contracts/notice-rules";
import { AdminShell } from "./admin-shell";
import { Button, Notice } from "./ui";

// 운영자 공지 목록·편집 (BRD-151, 화면 설계서 6장 ADM-NTC, 시안 4차 V18·V19·VM10·VM11·E5·E10·F5)
// - 목록: 상태 탭(노출·예약·대기·종료) + 표(모바일은 카드). 수정 대기·가려짐은 보조 표시(D16-D4)
// - 편집: 주소 ?id= (새 공지는 ?new=1). 한·영 제목·내용, 종류, 노출 기간(KST로 쓰고 UTC로 저장)
// - 저장(편집 권한)은 대기본만 바꿈. '게시 대상으로 확정'·'노출 종료'는 노출 변경 권한(D16-D4)
// - 저장·확정 성공을 앱 반영으로 말하지 않음. 앱에는 다음 게시 때 나감(D16-D4·C4)
// - 초안은 빈칸·글자 수 초과·차단 표현도 저장됨(D16-D1). 확정은 한·영 모두·글자 수·차단 표현·기간을 확인(서버도 다시 봄)
// - 표현 검사는 결정 기록 D17-8 목록. 차단은 확정을 막고, 문맥 확인 표현은 경고만 함
// - '지금 게시'는 데이터 게시 화면(ADM-PUB)에서 함. 공지는 판단 상태·실제 점검을 바꾸지 않음(D16-C6)

const t = messages.notices;

type Failed = Extract<OpsResult<unknown>, { ok: false }>;

// 바꿀 수 있는지: 문구 저장은 편집 이상, 확정·노출 종료는 노출 변경. 서버가 요청마다 다시 확인함
// 권한이 없어도 숨기지 않고 비활성 + 안내(10/16 결정)
function usePermissions(): { edit: string | null; publish: string | null } {
  const snapshot = useSessionSnapshot();
  if (snapshot.status === "signed_out") {
    return { edit: t.needEditor, publish: t.needPublisher };
  }
  if (snapshot.pool === "demo") {
    return { edit: t.demoReadOnly, publish: t.demoReadOnly };
  }
  const publisher = snapshot.groups.includes("publisher");
  return {
    edit: publisher || snapshot.groups.includes("editor") ? null : t.needEditor,
    publish: publisher ? null : t.needPublisher,
  };
}

// 목록 읽기. 다시 로그인하면(generation이 늚) 'reauth'로 끝난 읽기를 저절로 다시 함
function useNoticeList(): {
  result: OpsResult<{ items: NoticeView[] }> | null;
  // 앞서 받은 목록을 보이는 채로 다시 읽기만 실패함(편집 중 쓰던 내용을 지우지 않게 위에 실패만 알림)
  refreshFailure: Failed | null;
  reload: () => void;
} {
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const generation = snapshot.status === "signed_out" ? 0 : snapshot.generation;
  const [attempt, setAttempt] = useState(0);
  const key = `${attempt}|${generation}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: OpsResult<{ items: NoticeView[] }>;
  } | null>(null);
  // 마지막으로 성공한 목록. 다시 읽는 중에는 이것을 그대로 보여 줌(편집 중 내용이 깜빡이지 않게)
  const [good, setGood] = useState<OpsResult<{ items: NoticeView[] }> | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    void fetchNotices(() => session.accessToken()).then((next) => {
      if (!live) return;
      setLoaded({ key, result: next });
      if (next.ok) setGood(next);
    });
    return () => {
      live = false;
    };
  }, [session, key]);
  const current = loaded?.key === key ? loaded.result : null;
  return {
    result: current?.ok ? current : (good ?? current),
    refreshFailure: good && current && !current.ok ? current : null,
    reload: () => setAttempt((n) => n + 1),
  };
}

function Failure({
  title,
  result,
  onRetry,
}: {
  title: string;
  result: Failed;
  onRetry: () => void;
}) {
  const i = messages.inquiries;
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

// 상태 배지: 글자로 상태를 말하고 색·테두리는 보조(색만으로 구분하지 않음)
const BADGE: Record<NoticeState, string> = {
  live: "bg-brand-weak text-brand-default ring-1 ring-brand-border",
  scheduled: "bg-info-bg text-info-fg ring-1 ring-border-default",
  draft:
    "bg-status-stale-bg text-status-stale-fg outline-1 outline-status-stale-border outline-dashed -outline-offset-1",
  ended: "bg-bg-surface text-text-muted ring-1 ring-border-strong",
};

function StateBadge({ state }: { state: string }) {
  const known = isNoticeState(state);
  return (
    <span
      className={`inline-flex items-center rounded-admin-badge px-1.5 text-caption font-semibold whitespace-nowrap ${
        known
          ? BADGE[state]
          : "bg-bg-surface text-text-muted outline-1 outline-border-strong outline-dashed -outline-offset-1"
      }`}
    >
      {known ? t.state[state] : fill(t.unknownState, { state })}
    </span>
  );
}

// 수정 대기·가려짐: 상태 배지 옆 보조 표시
function SubBadges({ notice }: { notice: NoticeView }) {
  return (
    <>
      {notice.pendingEdit && (
        <span className="inline-flex items-center rounded-admin-badge bg-bg-surface px-1.5 text-caption font-semibold whitespace-nowrap text-status-stale-fg ring-1 ring-status-stale-border">
          {t.pendingEdit}
        </span>
      )}
      {notice.hidden && (
        <span className="inline-flex items-center rounded-admin-badge bg-bg-surface px-1.5 text-caption font-semibold whitespace-nowrap text-text-muted ring-1 ring-border-strong">
          {t.hidden}
        </span>
      )}
    </>
  );
}

// 앱에 나간 문구가 있으면 그것을, 없으면 저장한 문구를 목록에 보여 줌
const shownContent = (n: NoticeView) => n.live ?? n.draft;

function langsLabel(content: NoticeContent): string {
  const ko = content.title.ko.trim() !== "" && content.body.ko.trim() !== "";
  const en = content.title.en.trim() !== "" && content.body.en.trim() !== "";
  if (ko && en) return t.bothLangs;
  return !en ? t.missingEn : t.missingKo;
}

const editHref = (id: string) => `/notices/?id=${encodeURIComponent(id)}`;

function NoticeList({
  result,
  onRetry,
  flash,
}: {
  result: OpsResult<{ items: NoticeView[] }> | null;
  onRetry: () => void;
  flash: string | null;
}) {
  const router = useRouter();
  const snapshot = useSessionSnapshot();
  const { edit } = usePermissions();
  const [filter, setFilter] = useState<NoticeState | null>(null);
  const all = result?.ok ? result.body.items : [];
  const count = (s: NoticeState) => all.filter((n) => n.state === s).length;
  const items = filter ? all.filter((n) => n.state === filter) : all;

  return (
    <section aria-labelledby="notices-title" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <h1
              id="notices-title"
              className="text-title-l font-semibold text-text-default"
            >
              {t.title}
            </h1>
            {snapshot.status !== "signed_out" && snapshot.pool === "demo" && (
              <span className="rounded-admin-badge bg-info-bg px-1.5 text-caption font-semibold text-info-fg ring-1 ring-border-default">
                {t.sample}
              </span>
            )}
          </div>
          <p className="text-body-s text-text-muted">{t.description}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button
            size="small"
            disabled={edit !== null}
            aria-describedby={edit ? "notice-new-block" : undefined}
            onClick={() => router.push("/notices/?new=1")}
          >
            {t.new}
          </Button>
          {edit && (
            <p id="notice-new-block" className="text-label-s text-text-muted">
              {edit}
            </p>
          )}
        </div>
      </div>

      {flash && <Notice tone="success" title={flash} role="status" />}
      <p className="text-body-s text-text-body">{t.order}</p>

      <div
        role="group"
        aria-label={t.tabsLabel}
        className="flex gap-1 overflow-x-auto border-b border-border-default"
      >
        {[null, ...NOTICE_STATES].map((s) => {
          const on = s === filter;
          return (
            <button
              key={s ?? "all"}
              type="button"
              aria-pressed={on}
              onClick={() => setFilter(s)}
              className={`-mb-px flex min-h-touch shrink-0 items-center gap-1.5 border-b-2 px-2 text-body whitespace-nowrap lg:min-h-admin-control ${
                on
                  ? "border-brand-default font-semibold text-brand-default"
                  : "border-transparent font-medium text-text-muted hover:text-text-default"
              }`}
            >
              {s ? t.state[s] : t.all}
              {result?.ok && (
                <span className="text-label-s tabular-nums">
                  {s ? count(s) : all.length}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {result === null && (
        <p role="status" className="text-body-s text-text-muted">
          {t.loading}
        </p>
      )}
      {result && !result.ok && (
        <Failure title={t.listError} result={result} onRetry={onRetry} />
      )}
      {result?.ok && items.length === 0 && (
        <div className="rounded-admin-box border border-border-default bg-bg-surface px-4 py-6 text-center">
          <p className="text-title-s font-semibold text-text-default">
            {t.emptyTitle}
          </p>
          <p className="mt-1 text-body-s text-text-muted">
            {filter
              ? fill(t.emptyState, { state: t.state[filter] })
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
                {[t.colTitle, t.colPeriod, t.colText, t.colState].map(
                  (label) => (
                    <th
                      key={label}
                      scope="col"
                      className="border-b border-border-default px-3 py-2 first:pl-4"
                    >
                      {label}
                    </th>
                  ),
                )}
                <th
                  scope="col"
                  className="border-b border-border-default px-4 py-2 text-right"
                >
                  {t.colUpdated}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((n) => {
                const c = shownContent(n);
                return (
                  <tr key={n.id} className="hover:bg-bg-page">
                    <td className="border-b border-border-default py-2 pr-3 pl-4">
                      <Link
                        href={editHref(n.id)}
                        className="font-medium text-text-default underline-offset-2 hover:underline"
                      >
                        {n.draft.title.ko.trim() || t.untitled}
                      </Link>
                      <p className="text-label-s text-text-muted">
                        {t.kind[c.kind]} · {t.placement}
                      </p>
                    </td>
                    <td className="border-b border-border-default px-3 py-2 whitespace-nowrap text-text-body tabular-nums">
                      {kstRange(c.startsAt, c.endsAt, t.openEnd)}
                    </td>
                    <td className="border-b border-border-default px-3 py-2 text-body-s text-text-body">
                      {langsLabel(n.draft)}
                    </td>
                    <td className="border-b border-border-default px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        <StateBadge state={n.state} />
                        <SubBadges notice={n} />
                      </span>
                    </td>
                    <td className="border-b border-border-default px-4 py-2 text-right whitespace-nowrap text-text-body tabular-nums">
                      {kstDateTime(n.updatedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* 모바일: 카드(값은 빼지 않음) */}
          <ul className="flex flex-col divide-y divide-border-default rounded-admin-box border border-border-default bg-bg-surface md:hidden">
            {items.map((n) => {
              const c = shownContent(n);
              return (
                <li key={n.id}>
                  <Link
                    href={editHref(n.id)}
                    className="flex min-h-touch flex-col gap-1 px-4 py-3 hover:bg-bg-page"
                  >
                    <span className="flex flex-wrap items-center gap-1">
                      <StateBadge state={n.state} />
                      <SubBadges notice={n} />
                    </span>
                    <span className="text-body font-medium text-text-default">
                      {n.draft.title.ko.trim() || t.untitled}
                    </span>
                    <span className="text-body-s text-text-body">
                      {t.kind[c.kind]} · {t.placement} ·{" "}
                      <span className="tabular-nums">
                        {kstRange(c.startsAt, c.endsAt, t.openEnd)}
                      </span>
                    </span>
                    <span className="text-label-s text-text-muted">
                      {langsLabel(n.draft)} ·{" "}
                      {fill(t.updatedAt, { time: kstDateTime(n.updatedAt) })}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="text-label-s text-text-muted">{t.legend}</p>
        </>
      )}
    </section>
  );
}

// ---- 편집 ----

interface Form {
  kind: NoticeKind;
  titleKo: string;
  titleEn: string;
  bodyKo: string;
  bodyEn: string;
  // KST 벽시계(datetime-local)
  start: string;
  end: string;
  noEnd: boolean;
}

function formOf(content: NoticeContent): Form {
  return {
    kind: content.kind,
    titleKo: content.title.ko,
    titleEn: content.title.en,
    bodyKo: content.body.ko,
    bodyEn: content.body.en,
    start: toKstInput(content.startsAt),
    end: content.endsAt ? toKstInput(content.endsAt) : "",
    noEnd: content.endsAt === null,
  };
}

// 새 공지: 다음 정시 시작, 하루 뒤 끝
function blankForm(now: number): Form {
  const start = Math.ceil(now / 3_600_000) * 3_600_000;
  return {
    kind: "general",
    titleKo: "",
    titleEn: "",
    bodyKo: "",
    bodyEn: "",
    start: toKstInput(new Date(start).toISOString()),
    end: toKstInput(new Date(start + 86_400_000).toISOString()),
    noEnd: false,
  };
}

const FORM_KEYS = [
  "kind",
  "titleKo",
  "titleEn",
  "bodyKo",
  "bodyEn",
  "start",
  "end",
  "noEnd",
] as const;

function changedCount(form: Form, base: Form): number {
  return FORM_KEYS.filter((k) =>
    k === "end" && form.noEnd && base.noEnd ? false : form[k] !== base[k],
  ).length;
}

// 저장할 내용. 시각이 틀리면 null 칸이 생기고 saveProblems가 막음
function contentOf(form: Form): {
  content: NoticeContent | null;
  problems: NoticeProblem[];
} {
  const startsAt = fromKstInput(form.start);
  const endsAt = form.noEnd ? null : (fromKstInput(form.end) ?? undefined);
  const problems = saveProblems(startsAt, endsAt);
  if (problems.length > 0 || startsAt === null || endsAt === undefined) {
    return { content: null, problems };
  }
  return {
    content: {
      kind: form.kind,
      title: { ko: form.titleKo, en: form.titleEn },
      body: { ko: form.bodyKo, en: form.bodyEn },
      startsAt,
      endsAt,
    },
    problems,
  };
}

const FIELD_LABEL: Record<TextField, string> = {
  "title.ko": `${t.ko} ${t.titleLabel}`,
  "body.ko": `${t.ko} ${t.bodyLabel}`,
  "title.en": `${t.en} ${t.titleLabelEn}`,
  "body.en": `${t.en} ${t.bodyLabelEn}`,
};

// 한 칸에 문제가 여럿(글자 수·차단 표현 여러 개)일 수 있어 사유·맞은 문구까지 붙여 구분
const problemKey = (p: NoticeProblem) =>
  `${p.field}:${p.reason}:${"text" in p ? p.text : ""}`;

function problemText(p: NoticeProblem): string {
  if (p.reason === "order" || p.reason === "invalid")
    return t.problem[p.reason];
  if (p.reason === "blocked_phrase") {
    return fill(t.problem.blocked_phrase, {
      field: FIELD_LABEL[p.field],
      text: p.text,
      category: t.phraseCategory[p.category],
    });
  }
  const field = p.field as TextField;
  const [name, lang] = field.split(".") as ["title" | "body", "ko" | "en"];
  return fill(t.problem[p.reason], {
    field: FIELD_LABEL[field],
    max: NOTICE_TEXT_MAX[name][lang],
  });
}

const fieldClass =
  "w-full rounded-admin-control border border-border-strong bg-bg-surface px-2.5 py-2 text-body text-text-default outline-none placeholder:text-text-muted focus:border-brand-default focus:ring-[3px] focus:ring-brand-border disabled:bg-bg-page disabled:text-text-muted aria-invalid:border-danger-border";

function TextInput({
  id,
  label,
  value,
  max,
  multiline,
  problems,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  max: number;
  multiline?: boolean;
  problems: NoticeProblem[];
  onChange: (next: string) => void;
}) {
  const count = graphemeLength(value);
  const over = problems.some((p) => p.reason === "too_long");
  // 빈칸은 확인 목록에서만 알림(쓰는 중인 칸을 빨갛게 하지 않음)
  const shown = problems.filter(
    (p) => p.reason === "too_long" || p.reason === "blocked_phrase",
  );
  const common = {
    id,
    value,
    maxLength: NOTICE_DRAFT_TEXT_MAX,
    "aria-invalid": shown.length > 0 ? true : undefined,
    "aria-describedby":
      shown.length > 0 ? `${id}-count ${id}-problems` : `${id}-count`,
    className: fieldClass,
  } as const;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-body font-medium text-text-default">
          {label}
        </label>
        <span
          id={`${id}-count`}
          className={`text-label-s tabular-nums ${over ? "font-semibold text-danger-text" : "text-text-muted"}`}
        >
          {fill(t.count, { count, max })}
        </span>
      </div>
      {multiline ? (
        <textarea
          {...common}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          {...common}
          type="text"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {shown.length > 0 && (
        <div id={`${id}-problems`} className="flex flex-col gap-0.5">
          {shown.map((p) => (
            <p key={problemKey(p)} className="text-label-s text-danger-text">
              {problemText(p)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function Preview({ form }: { form: Form }) {
  const [lang, setLang] = useState<"ko" | "en">("ko");
  const title = lang === "ko" ? form.titleKo : form.titleEn;
  const body = lang === "ko" ? form.bodyKo : form.bodyEn;
  return (
    <section aria-labelledby="notice-preview" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3
          id="notice-preview"
          className="text-body font-semibold text-text-default"
        >
          {t.preview}
        </h3>
        <div
          role="group"
          aria-label={t.previewLang}
          className="flex gap-1 rounded-admin-control bg-bg-page p-1"
        >
          {(["ko", "en"] as const).map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={lang === l}
              onClick={() => setLang(l)}
              className="min-h-touch rounded-admin-control px-2.5 text-body-s font-medium text-text-body aria-pressed:bg-bg-surface aria-pressed:font-semibold aria-pressed:text-text-default aria-pressed:shadow-card lg:min-h-admin-control"
            >
              {l === "ko" ? t.ko : t.en}
            </button>
          ))}
        </div>
      </div>
      <div
        lang={lang}
        className="rounded-admin-box border border-border-default bg-bg-page p-3"
      >
        <div className="rounded-admin-box border border-status-stale-border bg-status-stale-bg px-3 py-2.5">
          <p className="text-body font-semibold text-text-default">
            {title.trim() || t.untitled}
          </p>
          {body.trim() && (
            <p className="mt-0.5 text-body-s text-text-body">{body}</p>
          )}
        </div>
      </div>
      <p className="text-label-s text-text-muted">{t.previewNote}</p>
    </section>
  );
}

type WriteError =
  | { kind: "conflict" | "replay" | "notLive" | "deleteLive" | "notFound" }
  | { kind: "invalid"; field: string; blocked: boolean }
  | { kind: "failed"; action: boolean; requestId: string | null };

function writeError(result: Failed, action: boolean): WriteError {
  if (result.code === "reauth")
    return { kind: "failed", action, requestId: null };
  if (result.status === 409) {
    if (result.reason === "idempotency_mismatch") return { kind: "replay" };
    if (result.reason === "not_live") return { kind: "notLive" };
    if (result.reason === "live") return { kind: "deleteLive" };
    return { kind: "conflict" };
  }
  if (result.status === 404) return { kind: "notFound" };
  if (result.status === 400 && "field" in result && result.field) {
    return {
      kind: "invalid",
      field: result.field,
      blocked: "reason" in result && result.reason === "blocked_phrase",
    };
  }
  return {
    kind: "failed",
    action,
    requestId: "requestId" in result ? result.requestId : null,
  };
}

type Confirm = "expose" | "end" | "delete" | "leave";

function ConfirmBox({
  title,
  body,
  confirmLabel,
  cancelLabel,
  busy,
  onConfirm,
  onCancel,
  focusCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  focusCancel?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  // 열리면 첫 버튼으로 포커스(나가기 확인은 '계속 쓰기'가 먼저, 시안 E5 7)
  useEffect(() => {
    box.current?.querySelector("button")?.focus();
  }, []);
  const confirmButton = (
    <Button
      variant={focusCancel ? "secondary" : "primary"}
      size="small"
      disabled={busy}
      onClick={onConfirm}
    >
      {busy ? t.saving : confirmLabel}
    </Button>
  );
  const cancelButton = (
    <Button
      variant={focusCancel ? "primary" : "secondary"}
      size="small"
      disabled={busy}
      onClick={onCancel}
    >
      {cancelLabel}
    </Button>
  );
  return (
    <Notice tone="warn" title={title} role="alert">
      <p>{body}</p>
      <div ref={box} className="mt-2 flex flex-wrap gap-2">
        {focusCancel ? cancelButton : confirmButton}
        {focusCancel ? confirmButton : cancelButton}
      </div>
    </Notice>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: ReactNode;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-admin-box border border-border-default bg-bg-surface p-4">
      <legend className="px-1 text-body font-semibold text-text-default">
        {title}
      </legend>
      {hint && <p className="-mt-2 text-label-s text-text-muted">{hint}</p>}
      {children}
    </fieldset>
  );
}

function NoticeEditor({
  notice,
  onWritten,
  onReload,
  onLeave,
}: {
  // 새 공지면 null
  notice: NoticeView | null;
  onWritten: (
    result: { noticeId: string; version: number },
    message: string,
    leave?: boolean,
  ) => void;
  onReload: () => void;
  onLeave: () => void;
}) {
  const router = useRouter();
  const session = useAuthSession();
  const { edit, publish } = usePermissions();
  const [now] = useState(() => Date.now());
  // 쓰는 중인 값의 기준이 된 공지. 목록을 다시 읽어도 쓰던 내용을 조용히 지우지 않음
  const [base, setBase] = useState<NoticeView | null>(notice);
  const baseForm = base ? formOf(base.draft) : null;
  const [form, setForm] = useState<Form>(
    () => baseForm ?? blankForm(Date.now()),
  );
  const [initial] = useState<Form>(form);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WriteError | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [copied, setCopied] = useState(false);
  // 내가 쓴 version. 목록을 다시 읽어 이 version이 오면 그대로 받음
  const [accept, setAccept] = useState<number | "next" | null>(null);
  const attempt = useRef<{ body: string; key: string } | null>(null);

  const changes = changedCount(form, baseForm ?? initial);
  if (
    notice &&
    base &&
    notice.version !== base.version &&
    (accept === notice.version || accept === "next" || changes === 0)
  ) {
    setBase(notice);
    setForm(formOf(notice.draft));
    setAccept(null);
    setError(null);
  } else if (
    notice &&
    base &&
    notice !== base &&
    notice.version === base.version
  ) {
    // 같은 version을 다시 받음: 상태(예약→노출→종료)는 version 없이 시각으로 바뀌므로 상태만 새로 받음
    // 문구는 version이 같아 그대로라 쓰던 내용은 두고, '새 내용 불러오기'로 기다리던 잠금을 풂
    setBase(notice);
    if (accept === "next") {
      setAccept(null);
      setError(null);
    }
  }
  const stale =
    notice !== null && base !== null && notice.version !== base.version;

  const { content, problems: saveBlocks } = contentOf(form);
  // 문구 확인(빈칸·글자 수·차단 표현)과 문맥 확인 경고는 시각이 틀려 내용을 못 만들 때도 문구만으로 알림
  const texts: NoticeTexts = {
    title: { ko: form.titleKo, en: form.titleEn },
    body: { ko: form.bodyKo, en: form.bodyEn },
  };
  const { problems: textBlocks, warnings } = textChecks(texts);
  const blocks = [
    ...textBlocks,
    ...(content ? periodProblems(content, now) : saveBlocks),
  ];
  const problemOf = (field: string) => blocks.find((p) => p.field === field);
  const problemsOf = (field: TextField) =>
    blocks.filter((p) => p.field === field);
  const startPast = content !== null && Date.parse(content.startsAt) < now;

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setError(null);
  };

  // 같은 내용을 다시 보내면 같은 멱등 키(응답을 못 받았을 때 한 번만 저장되게)
  const keyFor = (body: string) => {
    if (attempt.current?.body !== body) {
      attempt.current = { body, key: crypto.randomUUID() };
    }
    return attempt.current.key;
  };

  const save = () => {
    if (edit || busy || !content || (base && changes === 0)) return;
    const body = JSON.stringify({
      id: base?.id,
      version: base?.version,
      content,
    });
    const key = keyFor(body);
    setBusy(true);
    setError(null);
    const request = base
      ? updateNotice(
          () => session.accessToken(),
          base.id,
          base.version,
          content,
          key,
        )
      : createNotice(() => session.accessToken(), content, key);
    void request.then(
      (result) => {
        setBusy(false);
        if (result.ok) {
          attempt.current = null;
          setAccept(result.body.version);
          onWritten(result.body, base?.live ? t.savedPending : t.savedDraft);
          return;
        }
        setError(writeError(result, false));
      },
      () => {
        setBusy(false);
        setError({ kind: "failed", action: false, requestId: null });
      },
    );
  };

  const act = (action: "expose" | "end" | "delete") => {
    if (!base || busy) return;
    const key = keyFor(
      JSON.stringify({ id: base.id, action, version: base.version }),
    );
    setBusy(true);
    setError(null);
    void noticeAction(
      () => session.accessToken(),
      base.id,
      action,
      base.version,
      key,
    ).then(
      (result) => {
        setBusy(false);
        setConfirm(null);
        if (result.ok) {
          attempt.current = null;
          setAccept(result.body.version);
          onWritten(
            result.body,
            action === "expose"
              ? t.exposed
              : action === "end"
                ? t.ended
                : t.deleted,
            action === "delete",
          );
          return;
        }
        setError(writeError(result, true));
      },
      () => {
        setBusy(false);
        setError({ kind: "failed", action: true, requestId: null });
      },
    );
  };

  // 저장하지 않은 변경이 있으면 탭을 닫거나 새로고침할 때 브라우저가 묻게 함
  // 저장 요청 중에도 보호를 유지함(실패하면 쓰던 내용이 그대로 남으므로)
  const dirty = changes > 0;
  // 나가려던 곳: 안쪽 주소(메뉴 등 링크) 또는 'back'(브라우저 뒤로). null이면 공지 목록
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  // '나가기'를 누른 뒤에는 아래 가로채기를 하지 않음
  const leaving = useRef(false);
  // 브라우저 뒤로 보호용으로 쌓은 같은 주소 항목이 있는지. 한 번에 하나만 둠
  const guarded = useRef(false);
  useEffect(() => {
    if (!dirty) {
      // 보호를 풂(저장함·되돌림): 쌓아 둔 항목을 걷어 뒤로 가기가 실제 앞 화면으로 가게 함
      if (guarded.current && !leaving.current) {
        guarded.current = false;
        window.history.back();
      }
      return;
    }
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    // 앱 안 링크(왼쪽 메뉴 등)는 페이지를 새로 불러오지 않아 beforeunload가 없음 → 눌림을 먼저 가로채 확인
    // React보다 먼저 받도록 document 캡처 단계에서 받음(Next Link의 이동을 막음)
    const click = (e: MouseEvent) => {
      if (leaving.current || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank")
        return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaveTo(`${url.pathname}${url.search}`);
      setConfirm("leave");
    };
    // 브라우저 뒤로: 같은 주소를 하나 쌓아 두고, 뒤로 가면(그 항목이 빠짐) 다시 쌓은 뒤 확인을 띄움
    const guard = () => {
      window.history.pushState(window.history.state, "", window.location.href);
      guarded.current = true;
    };
    if (!guarded.current) guard();
    const back = () => {
      if (leaving.current) return;
      guard();
      setLeaveTo("back");
      setConfirm("leave");
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", click, true);
    window.addEventListener("popstate", back);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", click, true);
      window.removeEventListener("popstate", back);
    };
  }, [dirty]);

  const leave = () => {
    setLeaveTo(null);
    if (changes > 0) setConfirm("leave");
    else onLeave();
  };

  const confirmLeave = () => {
    leaving.current = true;
    if (leaveTo === "back") {
      // 쌓아 둔 보호 항목과 이 화면을 건너 원래 앞 화면으로
      window.history.go(-2);
    } else if (leaveTo) {
      router.push(leaveTo);
    } else {
      onLeave();
    }
  };

  const state = base?.state ?? null;
  const locked = edit !== null || busy || accept !== null;
  const canExpose =
    base !== null &&
    publish === null &&
    changes === 0 &&
    blocks.length === 0 &&
    (base.live === null || base.pendingEdit);
  // 노출 종료·삭제는 저장하지 않은 변경이 있으면 막음(결과를 받으며 쓰던 문구를 덮어쓰지 않게)
  const canEnd =
    base !== null &&
    publish === null &&
    changes === 0 &&
    (state === "live" || state === "scheduled");
  const deleteBlock =
    base === null
      ? null
      : state === "live"
        ? t.deleteLive
        : changes > 0
          ? t.unsavedBlocks
          : state === "scheduled"
            ? publish
            : edit;
  const copyText = [form.titleKo, form.bodyKo, form.titleEn, form.bodyEn]
    .filter((s) => s.trim())
    .join("\n");

  const errorTitle = (e: WriteError): string => {
    switch (e.kind) {
      case "conflict":
        return t.conflict;
      case "replay":
        return t.replay;
      case "notLive":
        return t.notLive;
      case "deleteLive":
        return t.deleteLive;
      case "notFound":
        return t.notFoundTitle;
      case "invalid":
        // 확정 검사에 걸린 칸은 화면 이름으로(내부 칸 이름을 보이지 않게)
        return fill(e.blocked ? t.blockedField : t.invalidField, {
          field:
            e.field in FIELD_LABEL
              ? FIELD_LABEL[e.field as TextField]
              : e.field === "startsAt"
                ? t.startsAt
                : e.field === "endsAt"
                  ? t.endsAt
                  : e.field,
        });
      case "failed":
        return e.action ? t.actionFailed : t.failed;
    }
  };

  return (
    <article
      aria-labelledby="notice-edit-title"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={leave}
          className="flex min-h-touch items-center self-start text-body-s font-medium text-brand-default"
        >
          ← {t.backToList}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <h1
            id="notice-edit-title"
            className="text-title-l font-semibold text-text-default"
          >
            {base ? base.draft.title.ko.trim() || t.untitled : t.newTitle}
          </h1>
          {base && <StateBadge state={base.state} />}
          {base && <SubBadges notice={base} />}
        </div>
        {base && (
          <p className="text-label-s text-text-muted">
            {fill(t.updatedAt, { time: kstDateTime(base.updatedAt) })}
          </p>
        )}
      </div>

      {confirm === "leave" && (
        <ConfirmBox
          title={t.leaveTitle}
          body={fill(t.leaveBody, { count: changes })}
          confirmLabel={t.leave}
          cancelLabel={t.stay}
          busy={false}
          focusCancel
          onConfirm={confirmLeave}
          onCancel={() => setConfirm(null)}
        />
      )}
      {edit && <Notice tone="neutral" title={edit} />}
      {stale && (
        <Notice tone="warn" title={t.staleDraft} role="alert">
          <ReloadCopy
            copied={copied}
            onReload={() => {
              setAccept("next");
              onReload();
            }}
            onCopy={
              changes > 0
                ? () =>
                    void navigator.clipboard
                      ?.writeText(copyText)
                      .then(() => setCopied(true))
                : undefined
            }
          />
        </Notice>
      )}
      {base?.pendingEdit && base.live && (
        <Notice tone="neutral" title={t.liveDiffers}>
          <p>
            {t.liveNow}: {base.live.title.ko} ·{" "}
            {kstRange(base.live.startsAt, base.live.endsAt, t.openEnd)}
          </p>
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <fieldset disabled={locked} className="flex min-w-0 flex-col gap-4">
          <Section title={t.kindLegend} hint={t.kindHint}>
            <div className="grid grid-cols-2 gap-1 rounded-admin-control bg-bg-page p-1">
              {NOTICE_KINDS.map((k) => (
                <label
                  key={k}
                  className="flex min-h-touch cursor-pointer items-center justify-center rounded-admin-control text-body-s font-medium text-text-body has-checked:bg-bg-surface has-checked:font-semibold has-checked:text-text-default has-checked:shadow-card has-focus-visible:ring-[3px] has-focus-visible:ring-brand-border has-disabled:cursor-not-allowed lg:min-h-admin-control"
                >
                  <input
                    type="radio"
                    name="notice-kind"
                    value={k}
                    checked={form.kind === k}
                    onChange={() => set("kind", k)}
                    className="sr-only"
                  />
                  {t.kind[k]}
                </label>
              ))}
            </div>
            <p className="text-body-s text-text-body">
              {t.placementLabel}: {t.placement}
            </p>
          </Section>

          <Section title={t.ko} hint={t.koHint}>
            <TextInput
              id="notice-title-ko"
              label={t.titleLabel}
              value={form.titleKo}
              max={NOTICE_TEXT_MAX.title.ko}
              problems={problemsOf("title.ko")}
              onChange={(v) => set("titleKo", v)}
            />
            <TextInput
              id="notice-body-ko"
              label={t.bodyLabel}
              value={form.bodyKo}
              max={NOTICE_TEXT_MAX.body.ko}
              multiline
              problems={problemsOf("body.ko")}
              onChange={(v) => set("bodyKo", v)}
            />
          </Section>

          <Section
            title={
              <>
                {t.en}{" "}
                <span className="text-label-s font-medium text-danger-text">
                  {t.required}
                </span>
              </>
            }
            hint={t.enHint}
          >
            <TextInput
              id="notice-title-en"
              label={t.titleLabelEn}
              value={form.titleEn}
              max={NOTICE_TEXT_MAX.title.en}
              problems={problemsOf("title.en")}
              onChange={(v) => set("titleEn", v)}
            />
            <TextInput
              id="notice-body-en"
              label={t.bodyLabelEn}
              value={form.bodyEn}
              max={NOTICE_TEXT_MAX.body.en}
              multiline
              problems={problemsOf("body.en")}
              onChange={(v) => set("bodyEn", v)}
            />
          </Section>

          <Section title={t.colPeriod} hint={t.endsHint}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="notice-start"
                  className="text-body font-medium text-text-default"
                >
                  {t.startsAt}
                </label>
                <input
                  id="notice-start"
                  type="datetime-local"
                  value={form.start}
                  aria-invalid={problemOf("startsAt") ? true : undefined}
                  onChange={(e) => set("start", e.target.value)}
                  className={fieldClass}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="notice-end"
                  className="text-body font-medium text-text-default"
                >
                  {t.endsAt}
                </label>
                <input
                  id="notice-end"
                  type="datetime-local"
                  value={form.noEnd ? "" : form.end}
                  disabled={form.noEnd}
                  aria-invalid={problemOf("endsAt") ? true : undefined}
                  aria-describedby="notice-period-hint"
                  onChange={(e) => set("end", e.target.value)}
                  className={fieldClass}
                />
              </div>
            </div>
            <label className="flex min-h-touch items-center gap-2 text-body-s text-text-body lg:min-h-admin-control">
              <input
                type="checkbox"
                checked={form.noEnd}
                onChange={(e) => set("noEnd", e.target.checked)}
                className="size-4 accent-brand-default"
              />
              {t.noEnd}
            </label>
            <p
              id="notice-period-hint"
              className="text-label-s"
              aria-live="polite"
            >
              {problemOf("endsAt") || problemOf("startsAt") ? (
                <span className="text-danger-text">
                  {problemText((problemOf("endsAt") ?? problemOf("startsAt"))!)}
                </span>
              ) : startPast ? (
                <span className="text-status-stale-fg">{t.startPast}</span>
              ) : null}
            </p>
          </Section>
        </fieldset>

        <div className="flex flex-col gap-4">
          <section
            aria-labelledby="notice-checks"
            className="flex flex-col gap-2 rounded-admin-box border border-border-default bg-bg-surface p-4"
          >
            <h3
              id="notice-checks"
              className="text-body font-semibold text-text-default"
            >
              {t.checksTitle}
            </h3>
            <ul
              id="notice-checks-list"
              className="flex flex-col gap-1.5 text-body-s"
            >
              <Check
                ok={!blocks.some((p) => p.reason === "required")}
                label={t.checkBoth}
              />
              <Check
                ok={!blocks.some((p) => p.reason === "too_long")}
                label={t.checkLength}
              />
              <Check
                ok={
                  !blocks.some(
                    (p) => p.reason === "order" || p.reason === "invalid",
                  )
                }
                label={t.checkPeriod}
              />
              <Check
                ok={!blocks.some((p) => p.reason === "blocked_phrase")}
                label={t.checkWords}
              />
            </ul>
            {blocks.length > 0 && (
              <ul className="flex flex-col gap-1 text-label-s text-danger-text">
                {blocks.map((p) => (
                  <li key={problemKey(p)}>{problemText(p)}</li>
                ))}
              </ul>
            )}
            {warnings.length > 0 && (
              <div
                id="notice-warnings"
                className="flex flex-col gap-1 border-t border-border-default pt-2"
              >
                <p className="text-label-s font-semibold text-status-stale-fg">
                  {fill(t.warnTitle, { count: warnings.length })}
                </p>
                <ul className="flex flex-col gap-1 text-label-s text-text-body">
                  {warnings.map((w) => (
                    <li key={`${w.field}:${w.text}`}>
                      {fill(t.warnItem, {
                        field: FIELD_LABEL[w.field],
                        text: w.text,
                      })}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
          <Preview form={form} />
        </div>
      </div>

      {error && (
        <Notice
          tone={error.kind === "failed" ? "fail" : "warn"}
          title={errorTitle(error)}
          role="alert"
        >
          {error.kind === "failed" && error.requestId && (
            <p>{fill(messages.inquiries.requestId, { id: error.requestId })}</p>
          )}
          {(error.kind === "conflict" ||
            error.kind === "replay" ||
            error.kind === "notLive") && (
            <ReloadCopy
              copied={copied}
              onReload={() => {
                setAccept("next");
                setError(null);
                onReload();
              }}
              onCopy={
                error.kind === "conflict" && changes > 0
                  ? () =>
                      void navigator.clipboard
                        ?.writeText(copyText)
                        .then(() => setCopied(true))
                  : undefined
              }
            />
          )}
        </Notice>
      )}

      {confirm === "expose" && (
        <ConfirmBox
          title={t.exposeConfirm}
          body={t.exposeBody}
          confirmLabel={t.expose}
          cancelLabel={t.confirmCancel}
          busy={busy}
          onConfirm={() => act("expose")}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "end" && (
        <ConfirmBox
          title={t.endConfirm}
          body={t.endBody}
          confirmLabel={t.end}
          cancelLabel={t.confirmCancel}
          busy={busy}
          onConfirm={() => act("end")}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "delete" && (
        <ConfirmBox
          title={t.deleteConfirm}
          body={t.deleteBody}
          confirmLabel={t.delete}
          cancelLabel={t.confirmCancel}
          busy={busy}
          onConfirm={() => act("delete")}
          onCancel={() => setConfirm(null)}
        />
      )}

      {base && (
        <div className="flex flex-col gap-2 rounded-admin-box border border-border-default bg-bg-surface p-4">
          <div className="flex flex-wrap gap-2">
            <Button
              size="small"
              disabled={!canExpose || busy || confirm !== null}
              aria-describedby="notice-action-hint"
              onClick={() => setConfirm("expose")}
            >
              {t.expose}
            </Button>
            <Button
              variant="secondary"
              size="small"
              disabled={!canEnd || busy || confirm !== null}
              aria-describedby="notice-action-hint"
              onClick={() => setConfirm("end")}
            >
              {t.end}
            </Button>
            <Button
              variant="secondary"
              size="small"
              disabled={deleteBlock !== null || busy || confirm !== null}
              aria-describedby="notice-action-hint"
              onClick={() => setConfirm("delete")}
            >
              {t.delete}
            </Button>
          </div>
          <p id="notice-action-hint" className="text-label-s text-text-muted">
            {publish ??
              (changes > 0
                ? t.unsavedBlocks
                : blocks.length > 0
                  ? t.exposeBlocked
                  : state === "live"
                    ? t.deleteLive
                    : "")}
          </p>
        </div>
      )}

      {/* 저장 바: 아래에 붙어 있어 긴 문구를 쓰는 중에도 보임(화면 설계서 6장 모바일 규칙) */}
      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-end gap-3 border-t border-border-default bg-bg-surface px-1 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <span
          className="mr-auto text-body-s text-text-muted"
          aria-live="polite"
        >
          {busy
            ? t.saving
            : [
                changes > 0 ? fill(t.changes, { count: changes }) : t.noChanges,
                ...(blocks.length > 0
                  ? [fill(t.problems, { count: blocks.length })]
                  : []),
              ].join(" · ")}
        </span>
        <Button variant="secondary" size="small" onClick={leave}>
          {t.cancel}
        </Button>
        <Button
          size="small"
          disabled={
            edit !== null ||
            busy ||
            accept !== null ||
            !content ||
            (base !== null && changes === 0)
          }
          onClick={save}
        >
          {t.save}
        </Button>
      </div>
    </article>
  );
}

function Check({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden="true"
        className={
          ok === null
            ? "text-text-muted"
            : ok
              ? "text-brand-default"
              : "text-danger-text"
        }
      >
        {ok === null ? "–" : ok ? "✓" : "!"}
      </span>
      <span className={ok === null ? "text-text-muted" : "text-text-body"}>
        {ok !== null && (
          <span className="sr-only">{ok ? t.checkPass : t.checkFail}</span>
        )}
        {label}
      </span>
    </li>
  );
}

function ReloadCopy({
  copied,
  onReload,
  onCopy,
}: {
  copied: boolean;
  onReload: () => void;
  onCopy: (() => void) | undefined;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      <Button variant="secondary" size="small" onClick={onReload}>
        {t.reload}
      </Button>
      {onCopy && (
        <Button variant="secondary" size="small" onClick={onCopy}>
          {copied ? t.copied : t.copy}
        </Button>
      )}
    </div>
  );
}

function NoticesBody() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id");
  const creating = params.get("new") === "1";
  const { result, refreshFailure, reload } = useNoticeList();
  // 저장·확정 안내. 화면(목록·편집)이 바뀌어도 이 값으로 한 번 보여 줌
  const [flash, setFlash] = useState<{ at: string; text: string } | null>(null);
  const here = id ?? (creating ? "new" : "list");
  // 방금 만든 공지: 목록을 다시 읽어 올 때까지 '없음' 대신 불러오는 중
  const [created, setCreated] = useState<string | null>(null);
  const toList = () => router.push("/notices/");

  const editing = id !== null || creating;
  const notice =
    id && result?.ok
      ? (result.body.items.find((n) => n.id === id) ?? null)
      : null;

  return (
    <div className="px-4 py-5 md:px-10 md:pt-6 md:pb-10">
      {!editing && refreshFailure && (
        <div className="mb-4">
          <Failure
            title={t.listError}
            result={refreshFailure}
            onRetry={reload}
          />
        </div>
      )}
      {!editing && (
        <NoticeList
          result={result}
          onRetry={reload}
          flash={flash?.at === "list" ? flash.text : null}
        />
      )}
      {editing && (
        <section aria-label={t.editLabel} className="flex flex-col gap-3">
          {flash?.at === here && (
            <Notice tone="success" title={flash.text} role="status" />
          )}
          {refreshFailure && (
            <Failure
              title={t.listError}
              result={refreshFailure}
              onRetry={reload}
            />
          )}
          {id &&
            (result === null || (result.ok && !notice && id === created)) && (
              <p role="status" className="text-body-s text-text-muted">
                {t.loading}
              </p>
            )}
          {id && result && !result.ok && (
            <Failure title={t.listError} result={result} onRetry={reload} />
          )}
          {id && result?.ok && !notice && id !== created && (
            <div className="flex flex-col items-start gap-2 py-6">
              <p className="text-title-s font-semibold text-text-default">
                {t.notFoundTitle}
              </p>
              <p className="text-body-s text-text-body">{t.notFoundBody}</p>
              <Button variant="secondary" size="small" onClick={toList}>
                {t.backToList}
              </Button>
            </div>
          )}
          {(creating || notice) && (
            <NoticeEditor
              key={id ?? "new"}
              notice={notice}
              onReload={reload}
              onLeave={toList}
              onWritten={(written, text, leave) => {
                reload();
                if (leave) {
                  setFlash({ at: "list", text });
                  toList();
                } else if (creating) {
                  setCreated(written.noticeId);
                  setFlash({ at: written.noticeId, text });
                  router.replace(
                    `/notices/?id=${encodeURIComponent(written.noticeId)}`,
                  );
                } else {
                  setFlash({ at: here, text });
                }
              }}
            />
          )}
        </section>
      )}
    </div>
  );
}

export function NoticesScreen() {
  return (
    <AdminShell title={t.title}>
      {/* 정적 내보내기라 주소 ?id= 는 브라우저에서 읽음(useSearchParams는 Suspense 안) */}
      <Suspense fallback={null}>
        <NoticesBody />
      </Suspense>
    </AdminShell>
  );
}
