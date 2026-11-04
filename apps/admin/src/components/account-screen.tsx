"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  associateTotp,
  changePassword,
  globalSignOut,
  verifyTotp,
} from "@/lib/auth/cognito-api";
import { authFailureOf } from "@/lib/auth/errors";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import { otpauthUri } from "@/lib/auth/srp";
import { messages } from "@/lib/messages";
import { roleLabel } from "@/lib/roles";
import { AdminShell } from "./admin-shell";
import { CodeInput, Field, PasswordRules, passwordChecks } from "./fields";
import { QrCode, qrShape, type QrShape } from "./qr-code";
import { Button, Notice } from "./ui";

// 내 계정 (BRD-148, 캔버스 V24·VM18, D16-A4·A9·A10)
// - 비밀번호 바꾸기·인증 앱 다시 등록은 운영자만. 데모 계정은 바꾸지 않음(읽기 전용)
// - 이름·로그인한 기기 목록·알림 받는 곳은 이번 범위가 아님(이름 속성 쓰기 없음, 기기 추적 끔, 인프라 설정)
// - 모든 기기에서 로그아웃: refresh token을 모두 무효로 함. 이미 받은 access token은 최대 15분 남음

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
