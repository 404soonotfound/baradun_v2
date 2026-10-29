"use client"; // 입력·임시 저장(기기)·사진 준비(canvas)·보내기(fetch)를 하므로 브라우저 부품

import { CircleAlert, CircleCheck, ImagePlus, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { BackButton } from "@/components/detail/back-button";
import { Button } from "@/components/ui/button";
import { Toast, useToast } from "@/components/ui/toast";
import { useActivity, type Activity } from "@/lib/activity";
import { cn } from "@/lib/cn";
import { localizedPath, type Locale } from "@/lib/i18n";
import type { BeachId } from "@baradun/contracts";
import {
  sendInquiry,
  type InquiryAttempt,
  type PhotoToSend,
  type Progress,
  type SendFailure,
  type SendStop,
} from "@/lib/inquiry/api";
import {
  clearInquiryDraft,
  clearSentInquiryDraft,
  readInquiryDraft,
  saveInquiryDraft,
  useInquiryDraft,
} from "@/lib/inquiry/draft";
import {
  buildRequest,
  EMAIL_MAX,
  firstErrorField,
  INQUIRY_CONTACT_ENABLED,
  INQUIRY_KINDS,
  MESSAGE_INPUT_MAX,
  MESSAGE_MIN,
  PHOTO_MAX_COUNT,
  validateForm,
  type FormErrors,
  type InquiryKind,
} from "@/lib/inquiry/form";
import { failureCopy } from "@/lib/inquiry/failure-copy";
import { preparePhoto, type PhotoError } from "@/lib/inquiry/photo";

// 데이터 문의 (BRD-37 · 노션 2장 INQ, 결정 기록 9장·11장 '문의(BRD-37)'·10/26 BRD-63, infra/README)
// 유형 칩 4개(계약 유형과 1:1) → (상세에서 왔으면) 해변·활동 자동 입력(계약 칸 beachId·activity) → 내용(5자 이상)
// → 사진(선택, 최대 3장) → 이메일(선택, 입력하면 동의 필수) → 보내기 (결정 기록 12장 결정 21·22)
// 상태: 입력 전 · 입력 오류 · 보내는 중 · 접수 완료 · 보내지 못함(사진 단계 / 문의 단계를 나눠 알림, 결정 27)
// 유형·내용만 기기에 최대 7일 임시 저장(lib/inquiry/draft.ts). 이메일·동의·사진은 화면 메모리에만 두고
// 실패해도 그대로 둬 다시 보낼 수 있게 함. 접수되거나 '지우기'를 누르면 비움(결정 25)
// 응답 기한은 약속하지 않음. 사용자 위치는 보내지 않음
// 이메일·사진 받기가 꺼져 있으면(결정 기록 13장 D13-1·D13-2, BRD-130) 사진·이메일·동의 칸을 그리지 않음
// → 그 상태 값은 빈 채로 남아 요청에 이메일·사진이 실리지 않음. 보관 안내·완료 문구도 꺼짐용 문구를 씀
// 멱등 키(BRD-103): 같은 내용으로 다시 보내면 같은 키를 씀(응답을 못 받은 재시도가 두 번 접수되지 않게). 키는 화면 메모리에만

type Shot = { id: number; photo: PhotoToSend; url: string };

// aria-describedby용 id 잇기(빈 값 빼고)
const idList = (...list: (string | false | null | undefined)[]) =>
  list.filter(Boolean).join(" ") || undefined;

// 오류 칸 몇 개를 지운 새 객체
function without(errors: FormErrors, ...keys: (keyof FormErrors)[]) {
  const next = { ...errors };
  for (const key of keys) delete next[key];
  return next;
}

type Phase =
  | { kind: "editing" }
  | { kind: "sending"; progress: Progress | null }
  | {
      kind: "done";
      accepted: number;
      rejectedLocation: number;
      rejectedOther: number;
    }
  | { kind: "failed"; failure: SendFailure; stop: SendStop };

export function InquiryScreen({
  locale,
  beaches,
  contactEnabled = INQUIRY_CONTACT_ENABLED,
}: {
  locale: Locale;
  // ?beach=slug → id·이름·지원 활동(빌드 때 넘김)
  beaches: {
    id: BeachId;
    slug: string;
    name: string;
    activities: readonly Activity[];
  }[];
  // 이메일·사진 받기. 페이지는 넘기지 않아 기본값(저장소 상수)을 씀. 스토리·테스트가 켜짐 상태를 그릴 때만 넘김
  contactEnabled?: boolean;
}) {
  const t = useTranslations("inquiry");
  const tp = useTranslations("pages");
  const ta = useTranslations("activity");
  const params = useSearchParams();
  const activity = useActivity();
  const toast = useToast();

  // 유형·내용은 임시 저장이 원본(입력할 때마다 저장). 서버 HTML은 빈 칸
  const draft = useInquiryDraft();
  const kind = draft?.kind ?? null;
  const message = draft?.message ?? "";

  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [shots, setShots] = useState<Shot[]>([]);
  const [photoError, setPhotoError] = useState<PhotoError | "tooMany" | null>(
    null,
  );
  const [preparing, setPreparing] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [phase, setPhase] = useState<Phase>({ kind: "editing" });
  const [contextRemoved, setContextRemoved] = useState(false);
  const sendingRef = useRef(false); // 두 번 누름 막기(상태 반영 전 빠른 연타 포함)
  const attemptRef = useRef<InquiryAttempt | null>(null); // 지난 보내기 시도(멱등 키·사진 참조). 접수되면 sendInquiry가 비움
  const nextShotId = useRef(1);
  // 사진 준비 차례. 준비 중에 지우기·실패로 사진을 비우면 올려서 늦게 끝난 준비가 사진을 다시 붙이지 않게 함
  const photoBatch = useRef(0);
  const mounted = useRef(true);

  const ids = {
    kind: useId(),
    kindError: useId(),
    message: useId(),
    messageHint: useId(),
    messageError: useId(),
    photoInput: useId(),
    photoHint: useId(),
    photoError: useId(),
    email: useId(),
    emailHint: useId(),
    emailError: useId(),
    consent: useId(),
    consentError: useId(),
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const kindRef = useRef<HTMLFieldSetElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const consentRef = useRef<HTMLInputElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);

  // 상세에서 들어왔으면(?beach=slug) 그 해변과 지금 고른 활동을 함께 보냄
  const beachSlug = params.get("beach");
  const beach =
    contextRemoved || beachSlug === null
      ? null
      : (beaches.find((item) => item.slug === beachSlug) ?? null);
  // 보내지 못한 뒤에는 처음 보낸 활동을 그대로 씀(다른 탭에서 활동을 바꿔도 다시 보내기가 같은 내용·같은 키로 가게)
  const [sentActivity, setSentActivity] = useState<Activity | null>(null);
  const contextActivity = sentActivity ?? activity;
  // 그 해변이 지원하는 활동만 보냄(지원하지 않는 활동을 해변 맥락으로 남기지 않음)
  const sendActivity =
    beach?.activities.includes(contextActivity) === true
      ? contextActivity
      : null;

  // 미리보기 주소 정리: 화면을 떠나면 모두 풀어 줌
  const shotsRef = useRef(shots);
  useEffect(() => {
    shotsRef.current = shots;
  }, [shots]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; // 준비 중에 떠나면 준비가 끝나도 미리보기 주소를 만들지 않음
      shotsRef.current.forEach((shot) => URL.revokeObjectURL(shot.url));
    };
  }, []);

  // 실패·완료로 바뀌면 그 안내로 포커스(화면 읽기가 바로 읽음)
  useEffect(() => {
    if (phase.kind === "failed") alertRef.current?.focus();
    if (phase.kind === "done") doneRef.current?.focus();
  }, [phase.kind]);

  const sending = phase.kind === "sending";

  function setKind(next: InquiryKind) {
    saveInquiryDraft(next, message);
    if (errors.kind) setErrors((prev) => without(prev, "kind"));
  }
  function setMessage(next: string) {
    saveInquiryDraft(kind, next);
    if (errors.message && next.trim().length >= MESSAGE_MIN)
      setErrors((prev) => without(prev, "message"));
  }

  async function addPhotos(files: FileList | null) {
    if (!files || files.length === 0) return;
    const room = PHOTO_MAX_COUNT - shots.length;
    const picked = [...files].slice(0, Math.max(0, room));
    setPhotoError(files.length > room ? "tooMany" : null);
    setPreparing(true);
    const batch = photoBatch.current;
    // 그사이 사진을 비웠거나 화면을 떠났으면 이번 준비는 버림
    const stale = () => !mounted.current || batch !== photoBatch.current;
    const prepared: PhotoToSend[] = [];
    for (const file of picked) {
      const result = await preparePhoto(file);
      if (stale()) return;
      if (!result.ok) {
        setPhotoError(result.error);
        continue;
      }
      prepared.push(result.photo);
    }
    setPreparing(false);
    if (prepared.length === 0) return;
    // 미리보기 주소는 붙일 때만 만듦(버린 준비에서 풀지 않은 주소가 남지 않게)
    const added = prepared.map((photo) => ({
      id: nextShotId.current++,
      photo,
      url: URL.createObjectURL(photo.blob),
    }));
    setShots((prev) => {
      const next = [...prev, ...added];
      // 최대 장수를 넘는 것은 붙이지 않고 주소도 풂
      next
        .slice(PHOTO_MAX_COUNT)
        .forEach((shot) => URL.revokeObjectURL(shot.url));
      return next.slice(0, PHOTO_MAX_COUNT);
    });
  }

  function removeShot(id: number) {
    setShots((prev) => {
      const gone = prev.find((shot) => shot.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return prev.filter((shot) => shot.id !== id);
    });
    setPhotoError(null);
  }

  function resetSensitive() {
    // 이메일·동의·사진은 기기에 남기지 않고 화면 메모리에만 둠. 접수·지우기 때만 비움(실패 때는 다시 보내게 남김)
    setEmail("");
    setConsent(false);
    shots.forEach((shot) => URL.revokeObjectURL(shot.url));
    setShots([]);
    setPhotoError(null);
    photoBatch.current += 1; // 준비 중인 사진도 붙이지 않음
    setPreparing(false);
    setSentActivity(null); // 다음 문의는 지금 고른 활동으로
  }

  function clearAll() {
    clearInquiryDraft();
    resetSensitive();
    setErrors({});
    setPhase({ kind: "editing" });
    toast.show({ text: t("actions.cleared") });
  }

  async function submit() {
    if (sendingRef.current || preparing) return;
    const found = validateForm({ kind, message, email, consent });
    setErrors(found);
    const first = firstErrorField(found);
    if (first !== null || kind === null) {
      const target = {
        kind: kindRef.current?.querySelector("input"),
        message: messageRef.current,
        email: emailRef.current,
        consent: consentRef.current,
      }[first ?? "kind"];
      target?.focus();
      return;
    }
    sendingRef.current = true;
    const sentSavedAt = readInquiryDraft()?.savedAt ?? null;
    setPhase({ kind: "sending", progress: null });
    const result = await sendInquiry(
      buildRequest({
        kind,
        message,
        email,
        context: beach
          ? {
              beachId: beach.id,
              ...(sendActivity === null ? {} : { activity: sendActivity }),
            }
          : null,
      }),
      shots.map((shot) => shot.photo),
      (progress) => setPhase({ kind: "sending", progress }),
      undefined,
      attemptRef,
    );
    sendingRef.current = false;
    if (result.ok) {
      const photos = result.response.photos;
      clearSentInquiryDraft(sentSavedAt); // 접수 성공 → 보낸 초안만 즉시 삭제
      resetSensitive();
      setPhase({
        kind: "done",
        accepted: photos.filter((p) => p.status === "accepted").length,
        rejectedLocation: photos.filter(
          (p) => p.status === "rejected" && p.reason === "location_metadata",
        ).length,
        rejectedOther: photos.filter(
          (p) => p.status === "rejected" && p.reason !== "location_metadata",
        ).length,
      });
    } else {
      // 이메일·동의·사진을 남겨 둠 → 같은 내용으로 다시 보내면 같은 멱등 키를 써서 두 번 접수되지 않음
      setSentActivity(contextActivity);
      setPhase({ kind: "failed", failure: result.failure, stop: result.stop });
    }
  }

  const header = (
    <header className="-mx-2 flex h-detail-header items-center gap-1">
      <BackButton locale={locale} fallback="/settings/" />
      <h1
        ref={doneRef}
        tabIndex={-1}
        className="text-title-l text-text-default outline-none"
      >
        {phase.kind === "done" ? t("done.title") : tp("inquiry")}
      </h1>
    </header>
  );

  if (phase.kind === "done") {
    return (
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
        {header}
        <section className="flex flex-col items-start gap-3 rounded-card bg-bg-surface p-5 shadow-card">
          <span
            aria-hidden="true"
            className="flex size-10 items-center justify-center rounded-full bg-status-clear-bg text-status-clear-fg"
          >
            <CircleCheck size={22} />
          </span>
          <p className="text-body text-text-default">
            {t(contactEnabled ? "done.body" : "done.bodyTextOnly")}
          </p>
          {phase.accepted > 0 && (
            <p className="text-body-s text-text-body">
              {t("done.photos", { count: phase.accepted })}
            </p>
          )}
          {phase.rejectedLocation > 0 && (
            <p className="text-body-s text-text-body">
              {t("done.rejectedLocation", { count: phase.rejectedLocation })}
            </p>
          )}
          {phase.rejectedOther > 0 && (
            <p className="text-body-s text-text-body">
              {t("done.rejectedOther", { count: phase.rejectedOther })}
            </p>
          )}
          {phase.rejectedLocation + phase.rejectedOther > 0 && (
            <p className="text-body-s text-text-body">
              {t("done.rejectedNext")}
            </p>
          )}
          <p className="text-body-s text-text-body">{t("done.draftCleared")}</p>
          <div className="mt-2 flex w-full flex-col gap-2 sm:flex-row">
            <Button asChild>
              <Link href={localizedPath(locale, "/settings/")}>
                {t("done.back")}
              </Link>
            </Button>
            <Button
              variant="secondary"
              onClick={() => setPhase({ kind: "editing" })}
            >
              {t("done.another")}
            </Button>
          </div>
        </section>
      </div>
    );
  }

  const errorCount = Object.keys(errors).length;
  // 실패 안내 문구 키(접수 여부를 모르면 제목·영향·다음 행동이 달라짐)
  const copy = phase.kind === "failed" ? failureCopy(phase) : null;
  const progressText =
    phase.kind === "sending" && phase.progress
      ? phase.progress.phase === "photos"
        ? t("progress.photos", {
            done: phase.progress.done,
            total: phase.progress.total,
          })
        : t("progress.message")
      : null;

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 pb-6">
      {header}
      <p className="text-body-s text-text-body">{t("intro")}</p>

      {copy && (
        <div
          ref={alertRef}
          tabIndex={-1}
          role="alert"
          className="flex gap-3 rounded-card border-[1.5px] border-banner-red-border bg-bg-surface p-4 outline-none"
        >
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-banner-red-icon-bg text-banner-red-icon-fg"
          >
            <CircleAlert size={16} />
          </span>
          {/* 무슨 일(제목·원인) → 영향(멈춘 단계·접수 여부) → 다음 행동 (lib/inquiry/failure-copy.ts) */}
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-body-s font-bold text-text-default">
              {t(`failed.${copy.title}`)}
            </p>
            <p className="text-caption text-text-body">
              {t(`failed.${copy.cause}`)}
            </p>
            <p className="text-caption text-text-body">
              {"values" in copy.impact
                ? t(`failed.${copy.impact.key}`, copy.impact.values)
                : t(`failed.${copy.impact.key}`)}
            </p>
            <p className="text-caption text-text-body">{t("failed.kept")}</p>
            <p className="text-caption text-text-body">
              {t(`failed.${copy.next}`)}
            </p>
          </div>
        </div>
      )}

      {errorCount > 0 && (
        <p role="alert" className="text-body-s font-bold text-danger-text">
          {t("errors.summary", { count: errorCount })}
        </p>
      )}

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4"
      >
        <fieldset disabled={sending} className="flex flex-col gap-4">
          {/* 유형 */}
          <fieldset
            ref={kindRef}
            aria-describedby={errors.kind ? ids.kindError : undefined}
            className="flex flex-col gap-2 rounded-card bg-bg-surface p-4 shadow-card"
          >
            <legend className="float-left mb-2 text-title-s text-text-default">
              {t("kind.legend")}
            </legend>
            <div className="clear-left grid grid-cols-1 gap-2 sm:grid-cols-2">
              {INQUIRY_KINDS.map((value) => (
                <label
                  key={value}
                  className={cn(
                    "flex min-h-touch cursor-pointer items-center rounded-button border px-3 text-body-s has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand-default",
                    kind === value
                      ? "border-brand-default bg-brand-weak font-bold text-text-default"
                      : errors.kind
                        ? "border-danger-text text-text-body"
                        : "border-border-default text-text-body",
                  )}
                >
                  <input
                    type="radio"
                    name="inquiry-kind"
                    value={value}
                    checked={kind === value}
                    onChange={() => setKind(value)}
                    className="sr-only"
                  />
                  {t(`kind.${value}`)}
                </label>
              ))}
            </div>
            {errors.kind && (
              <p id={ids.kindError} className="text-caption text-danger-text">
                {t(`errors.${errors.kind}`)}
              </p>
            )}
          </fieldset>

          {/* 자동으로 넣은 해변·활동 */}
          {beach && (
            <section
              aria-labelledby={`${ids.kind}-context`}
              className="flex flex-col gap-1 rounded-card bg-bg-surface p-4 shadow-card"
            >
              <h2
                id={`${ids.kind}-context`}
                className="text-title-s text-text-default"
              >
                {t("context.legend")}
              </h2>
              <p className="text-body-s text-text-default">
                {t("context.beach", { name: beach.name })}
                {sendActivity !== null && (
                  <>
                    {" · "}
                    {t("context.activity", { activity: ta(sendActivity) })}
                  </>
                )}
              </p>
              <p className="text-caption text-text-muted">
                {t("context.note")}
              </p>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setContextRemoved(true)}
                className="-ml-3 self-start"
              >
                {t("context.remove")}
              </Button>
            </section>
          )}

          {/* 내용 */}
          <div className="flex flex-col gap-1.5 rounded-card bg-bg-surface p-4 shadow-card">
            <label
              htmlFor={ids.message}
              className="text-title-s text-text-default"
            >
              {t("message.label")}
            </label>
            <p id={ids.messageHint} className="text-caption text-text-muted">
              {t("message.hint")}
            </p>
            <textarea
              ref={messageRef}
              id={ids.message}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={MESSAGE_INPUT_MAX}
              rows={6}
              aria-invalid={errors.message ? true : undefined}
              aria-describedby={idList(
                ids.messageHint,
                errors.message && ids.messageError,
              )}
              className={cn(
                "w-full resize-y rounded-input border bg-bg-surface px-3 py-2.5 text-body text-text-default",
                errors.message
                  ? "border-[1.5px] border-danger-text"
                  : "border-border-strong",
              )}
            />
            <div className="flex items-start justify-between gap-2">
              {errors.message ? (
                <p
                  id={ids.messageError}
                  className="text-caption text-danger-text"
                >
                  {t(`errors.${errors.message}`)}
                </p>
              ) : (
                <span />
              )}
              <span className="shrink-0 text-caption text-text-muted">
                {t("message.count", {
                  count: message.length,
                  max: MESSAGE_INPUT_MAX,
                })}
              </span>
            </div>
          </div>

          {/* 사진 */}
          {contactEnabled && (
            <div className="flex flex-col gap-1.5 rounded-card bg-bg-surface p-4 shadow-card">
              <p
                className="text-title-s text-text-default"
                id={`${ids.photoInput}-label`}
              >
                {t("photos.label")}
              </p>
              <p id={ids.photoHint} className="text-caption text-text-muted">
                {t("photos.hint")}
              </p>
              {shots.length > 0 && (
                <ul className="mt-1 flex flex-wrap gap-2">
                  {shots.map((shot, index) => (
                    <li key={shot.id} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element -- 기기 안 미리보기(blob 주소)라 next/image를 쓰지 않음 */}
                      <img
                        src={shot.url}
                        alt={t("photos.alt", { index: index + 1 })}
                        className="size-20 rounded-icon object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeShot(shot.id)}
                        aria-label={t("photos.remove", { index: index + 1 })}
                        className="absolute -top-3 -right-3 flex size-touch items-center justify-center"
                      >
                        <span className="flex size-7 items-center justify-center rounded-full bg-bg-surface text-text-default shadow-card">
                          <X aria-hidden="true" size={16} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <input
                ref={fileRef}
                id={ids.photoInput}
                type="file"
                accept="image/*"
                multiple
                tabIndex={-1}
                aria-hidden="true"
                className="sr-only"
                onChange={(event) => {
                  void addPhotos(event.target.files);
                  event.target.value = ""; // 같은 사진을 다시 골라도 동작하게
                }}
              />
              <div className="mt-1 flex items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => fileRef.current?.click()}
                  disabled={preparing || shots.length >= PHOTO_MAX_COUNT}
                  aria-describedby={idList(
                    ids.photoHint,
                    photoError && ids.photoError,
                  )}
                >
                  <ImagePlus aria-hidden="true" size={18} />
                  {t("photos.add")}
                </Button>
                <span className="text-caption text-text-muted">
                  {t("photos.count", { count: shots.length })}
                </span>
              </div>
              {preparing && (
                <p role="status" className="text-caption text-text-body">
                  {t("photos.preparing")}
                </p>
              )}
              {photoError && (
                <p
                  id={ids.photoError}
                  role="alert"
                  className="text-caption text-danger-text"
                >
                  {t(`photos.${photoError}`)}
                </p>
              )}
            </div>
          )}

          {/* 이메일 + 동의 */}
          {contactEnabled && (
            <div className="flex flex-col gap-1.5 rounded-card bg-bg-surface p-4 shadow-card">
              <label
                htmlFor={ids.email}
                className="text-title-s text-text-default"
              >
                {t("email.label")}
              </label>
              <p id={ids.emailHint} className="text-caption text-text-muted">
                {t("email.hint")}
              </p>
              <input
                ref={emailRef}
                id={ids.email}
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                maxLength={EMAIL_MAX}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (event.target.value.trim() === "")
                    setErrors((prev) => without(prev, "email", "consent"));
                }}
                aria-invalid={errors.email ? true : undefined}
                aria-describedby={idList(
                  ids.emailHint,
                  errors.email && ids.emailError,
                )}
                className={cn(
                  "h-input w-full rounded-input border bg-bg-surface px-3 text-body text-text-default",
                  errors.email
                    ? "border-[1.5px] border-danger-text"
                    : "border-border-strong",
                )}
              />
              {errors.email && (
                <p
                  id={ids.emailError}
                  className="text-caption text-danger-text"
                >
                  {t(`errors.${errors.email}`)}
                </p>
              )}
              {email.trim() !== "" && (
                <div className="mt-1 flex flex-col gap-1">
                  <label
                    htmlFor={ids.consent}
                    className="flex min-h-touch cursor-pointer items-center gap-3 text-body-s text-text-default"
                  >
                    <input
                      ref={consentRef}
                      id={ids.consent}
                      type="checkbox"
                      checked={consent}
                      onChange={(event) => {
                        setConsent(event.target.checked);
                        if (event.target.checked)
                          setErrors((prev) => without(prev, "consent"));
                      }}
                      aria-invalid={errors.consent ? true : undefined}
                      aria-describedby={
                        errors.consent ? ids.consentError : undefined
                      }
                      className="size-5 shrink-0 accent-brand-default"
                    />
                    {t("consent.label")}
                  </label>
                  {errors.consent && (
                    <p
                      id={ids.consentError}
                      className="text-caption text-danger-text"
                    >
                      {t(`errors.${errors.consent}`)}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 보관 안내 */}
          <section
            aria-labelledby={`${ids.kind}-retention`}
            className="flex flex-col gap-1 rounded-card bg-brand-weak p-4"
          >
            <h2
              id={`${ids.kind}-retention`}
              className="text-body-s font-bold text-text-default"
            >
              {t("retention.title")}
            </h2>
            <p className="text-caption text-text-body">
              {t(contactEnabled ? "retention.body" : "retention.bodyTextOnly")}
            </p>
            <p className="text-caption text-text-body">
              {t(
                contactEnabled ? "retention.draft" : "retention.draftTextOnly",
              )}
            </p>
          </section>
        </fieldset>

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            type="submit"
            disabled={sending || preparing}
            className="sm:min-w-40"
          >
            {sending
              ? t("actions.sending")
              : phase.kind === "failed"
                ? t("actions.retry")
                : t("actions.submit")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={clearAll}
            disabled={sending}
          >
            {t("actions.clear")}
          </Button>
        </div>
        <p role="status" className="min-h-5 text-caption text-text-body">
          {progressText}
        </p>
      </form>
      <Toast message={toast.message} onHold={toast.hold} />
    </div>
  );
}
