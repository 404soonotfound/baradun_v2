"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  associateTotp,
  changePassword,
  globalSignOut,
  verifyTotp,
} from "@/lib/auth/cognito-api";
import {
  isEmail,
  resetOperatorMfa,
  sameEmail,
  type MfaResetOutcome,
} from "@/lib/account";
import { authFailureOf } from "@/lib/auth/errors";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import { otpauthUri } from "@/lib/auth/srp";
import { fill, messages } from "@/lib/messages";
import { roleLabel } from "@/lib/roles";
import { AdminShell } from "./admin-shell";
import { ConfirmDialog } from "./confirm-dialog";
import { useSlow } from "./use-slow";
import { CodeInput, Field, PasswordRules, passwordChecks } from "./fields";
import { QrCode, qrShape, type QrShape } from "./qr-code";
import { Button, Notice } from "./ui";

// 내 계정 (BRD-148, 캔버스 V24·VM18, D16-A4·A9·A10)
// - 비밀번호 바꾸기·인증 앱 다시 등록은 운영자만. 데모 계정은 바꾸지 않음(읽기 전용)
// - 이름·로그인한 기기 목록·알림 받는 곳은 이번 범위가 아님(이름 속성 쓰기 없음, 기기 추적 끔, 인프라 설정)
// - 모든 기기에서 로그아웃: refresh token을 모두 무효로 함. 이미 받은 access token은 최대 15분 남음
// - 다른 운영자의 2단계 인증 초기화(#335, D16-A9, 사용자 결정 2026-11-13): 운영자 계정이면 역할과 상관없이.
//   대상 이메일 직접 입력 → 확인 창(취소에 먼저 포커스, 대상 이메일 다시 입력) → 운영 API. 데모 계정에는 보이지 않음
//   운영자가 1명이면 인증 앱을 잃은 사람이 로그인하지 못해 이 칸을 쓸 수 없음 → AWS 콘솔 절차(6장)

const t = messages;

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3 border-t border-border-default py-6 md:grid-cols-[260px_1fr] md:gap-7">
      <div>
        <h2 className="text-title-s font-semibold text-text-default">
          {title}
        </h2>
        {hint && <p className="mt-1 text-label-s text-text-muted">{hint}</p>}
      </div>
      <div className="flex max-w-[440px] flex-col gap-3">{children}</div>
    </section>
  );
}

function PasswordSection({ token }: { token: () => Promise<string | null> }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [result, setResult] = useState<"ok" | string | null>(null);
  const [busy, setBusy] = useState(false);
  const checks = passwordChecks(next, confirm);
  const ready = current && checks.length && checks.number && checks.match;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setResult(null);
    void (async () => {
      const access = await token();
      if (!access) return;
      try {
        await changePassword(access, current, next);
        setCurrent("");
        setNext("");
        setConfirm("");
        setResult("ok");
      } catch (err) {
        const failure = authFailureOf(err);
        setResult(
          failure === "wrong_credentials"
            ? t.account.wrongCurrent
            : failure === "password_rule"
              ? t.rules.violated
              : failure === "password_reused"
                ? t.rules.reused
                : failure === "limit_exceeded"
                  ? t.common.limit
                  : failure === "network"
                    ? t.common.network
                    : t.common.unknown,
        );
      }
    })().finally(() => setBusy(false));
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
      {result === "ok" && (
        <Notice tone="neutral" title={t.account.changed} role="status" />
      )}
      <Field
        label={t.account.current}
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        error={result && result !== "ok" ? result : null}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t.welcome.newPassword}
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <Field
          label={t.welcome.confirmPassword}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      <PasswordRules next={next} confirm={confirm} />
      <div>
        <Button type="submit" size="small" disabled={busy || !ready}>
          {t.account.changePassword}
        </Button>
      </div>
    </form>
  );
}

// 인증 앱 다시 등록: 새 키(QR) → 새 앱 코드 확인. 확인이 끝나야 예전 앱이 바뀜(중간에 그만두면 그대로)
function TotpSection({
  token,
  email,
}: {
  token: () => Promise<string | null>;
  email: string;
}) {
  const [setup, setSetup] = useState<{ secret: string; qr: QrShape } | null>(
    null,
  );
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const start = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(false);
    void (async () => {
      const access = await token();
      if (!access) return;
      try {
        const secret = await associateTotp(access);
        const qr = qrShape(otpauthUri(secret, email));
        setCode("");
        setSetup({ secret, qr });
      } catch (err) {
        setError(
          authFailureOf(err) === "network"
            ? t.common.network
            : t.common.unknown,
        );
      }
    })().finally(() => setBusy(false));
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6 || busy) return;
    setBusy(true);
    void (async () => {
      const access = await token();
      if (!access) return;
      try {
        await verifyTotp(access, code);
        setSetup(null);
        setDone(true);
      } catch (err) {
        setCode("");
        setError(
          authFailureOf(err) === "code_mismatch"
            ? t.totp.mismatchHint
            : t.common.unknown,
        );
      }
    })().finally(() => setBusy(false));
  };

  if (!setup) {
    return (
      <>
        {done && (
          <Notice
            tone="neutral"
            title={t.account.reregisterDone}
            role="status"
          />
        )}
        {error && <Notice tone="fail" title={error} role="alert" />}
        <div className="flex items-center justify-between gap-3 rounded-admin-box border border-border-default bg-bg-surface px-3.5 py-3">
          <p className="text-body-s text-text-body">
            {t.account.mfaRegistered}
          </p>
          <Button
            variant="secondary"
            size="small"
            onClick={start}
            disabled={busy}
          >
            {t.account.reregister}
          </Button>
        </div>
      </>
    );
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={verify} noValidate>
      <QrCode shape={setup.qr} label={t.welcome.qrLabel} />
      <p className="text-label-s text-text-muted">
        {t.welcome.keyLabel}:{" "}
        <span className="font-mono text-text-default select-all">
          {setup.secret.match(/.{1,4}/g)?.join(" ")}
        </span>
      </p>
      <CodeInput
        label={t.totp.label}
        value={code}
        onChange={setCode}
        error={error}
      />
      <div className="flex gap-2">
        <Button type="submit" size="small" disabled={busy || code.length !== 6}>
          {t.welcome.connect}
        </Button>
        <Button variant="secondary" size="small" onClick={() => setSetup(null)}>
          {t.account.cancel}
        </Button>
      </div>
    </form>
  );
}

const r = t.account.mfaReset;

// 결과 문구. 성공·이미 없음은 안내(neutral), 그 밖은 실패(fail)
function resetNotice(
  outcome: MfaResetOutcome,
  email: string,
): { tone: "neutral" | "fail"; text: string } {
  switch (outcome) {
    case "reset":
      return { tone: "neutral", text: fill(r.done, { email }) };
    case "already_none":
      return { tone: "neutral", text: fill(r.alreadyNone, { email }) };
    case "self":
      return { tone: "fail", text: r.self };
    case "not_found":
      return { tone: "fail", text: r.notFound };
    case "invalid_email":
      return { tone: "fail", text: r.invalidEmail };
    case "forbidden":
      return { tone: "fail", text: r.forbidden };
    // 요청이 거부돼 바뀐 것이 없음. 세션 문구를 그대로 씀(다시 로그인하면 다시 할 수 있음)
    case "expired":
      return { tone: "fail", text: t.session.expiredTitle };
    case "unknown":
      return { tone: "fail", text: r.unknown };
  }
}

function MfaResetSection({
  token,
  myEmail,
}: {
  token: () => Promise<string | null>;
  myEmail: string;
}) {
  const [email, setEmail] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "neutral" | "fail";
    text: string;
  } | null>(null);

  const slow = useSlow(busy);

  const open = (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    setNotice(null);
    if (!isEmail(value)) {
      setInputError(r.invalidEmail);
      return;
    }
    // 본인은 서버에서도 거부함. 확인 창을 열기 전에 먼저 알려 줌
    if (sameEmail(value, myEmail)) {
      setInputError(r.self);
      return;
    }
    setInputError(null);
    setWord("");
    setTarget(value);
  };

  const confirm = () => {
    if (!target || busy || !sameEmail(word, target)) return;
    setBusy(true);
    void (async () => {
      const outcome = await resetOperatorMfa(target, token);
      setNotice(resetNotice(outcome, target));
      if (outcome === "reset" || outcome === "already_none") setEmail("");
      setTarget(null);
    })().finally(() => setBusy(false));
  };

  return (
    <>
      {notice && (
        <Notice
          tone={notice.tone}
          title={notice.text}
          role={notice.tone === "fail" ? "alert" : "status"}
        />
      )}
      <form className="flex flex-col gap-3" onSubmit={open} noValidate>
        <Field
          label={r.emailLabel}
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={inputError}
        />
        <div>
          <Button
            type="submit"
            variant="secondary"
            size="small"
            disabled={busy || email.trim() === ""}
          >
            {r.start}
          </Button>
        </div>
      </form>
      {target && (
        <ConfirmDialog
          titleId="mfa-reset-confirm-title"
          title={fill(r.confirmTitle, { email: target })}
          confirmLabel={r.confirm}
          cancelLabel={r.cancel}
          confirmDisabled={!sameEmail(word, target)}
          busy={busy}
          onConfirm={confirm}
          onClose={() => setTarget(null)}
        >
          <p>{r.confirmBody}</p>
          <p>{r.confirmUndo}</p>
          <label className="mt-1 flex flex-col gap-1">
            <span className="font-medium text-text-default">
              {r.confirmWordLabel}
            </span>
            <input
              value={word}
              onChange={(e) => setWord(e.target.value)}
              type="email"
              autoComplete="off"
              className="h-touch rounded-admin-control border border-border-strong bg-bg-surface px-3 text-body text-text-default lg:h-admin-control"
            />
          </label>
          {slow && (
            <p role="status" className="text-text-muted">
              {r.slow}
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

function AccountBody() {
  const router = useRouter();
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  if (snapshot.status === "signed_out") return null;
  const token = () => session.accessToken();
  const loginPath = snapshot.pool === "demo" ? "/login/demo/" : "/login/";

  return (
    <main className="w-full px-4 py-5 md:px-10 md:pt-6 md:pb-10">
      <h1 className="text-title-l font-semibold text-text-default">
        {t.account.title}
      </h1>
      <p className="mt-1 mb-4 text-body-s text-text-muted">
        {snapshot.email}
        {` · ${roleLabel(snapshot.pool, snapshot.groups) ?? ""}`}
      </p>
      <Section title={t.account.profile} hint={t.account.profileHint}>
        <Field label={t.account.email} value={snapshot.email ?? ""} readOnly />
      </Section>
      {snapshot.pool === "demo" ? (
        <Section title={t.account.password}>
          <Notice tone="neutral" title={t.account.demoNoChange} />
        </Section>
      ) : (
        <>
          <Section title={t.account.password} hint={t.account.passwordHint}>
            <PasswordSection token={token} />
          </Section>
          <Section title={t.account.mfa} hint={t.account.mfaHint}>
            <TotpSection token={token} email={snapshot.email ?? ""} />
          </Section>
          <Section title={r.title} hint={r.hint}>
            <MfaResetSection token={token} myEmail={snapshot.email ?? ""} />
          </Section>
        </>
      )}
      <Section title={t.account.sessions} hint={t.account.sessionsHint}>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="small"
            onClick={() => {
              void session.logout();
              router.replace(loginPath);
            }}
          >
            {t.account.logout}
          </Button>
          {snapshot.pool === "operator" && (
            <Button
              variant="secondary"
              size="small"
              onClick={() => {
                void (async () => {
                  const access = await token();
                  if (access)
                    await globalSignOut(access).catch(() => undefined);
                  await session.logout();
                  router.replace(loginPath);
                })();
              }}
            >
              {t.account.logoutAll}
            </Button>
          )}
        </div>
      </Section>
    </main>
  );
}

export function AccountScreen() {
  return (
    <AdminShell title={messages.account.title}>
      <AccountBody />
    </AdminShell>
  );
}
