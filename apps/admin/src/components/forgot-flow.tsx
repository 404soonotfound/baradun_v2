"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { confirmForgotPassword, forgotPassword } from "@/lib/auth/cognito-api";
import { POOLS } from "@/lib/auth/config";
import { authFailureOf } from "@/lib/auth/errors";
import { messages } from "@/lib/messages";
import { CodeInput, Field, PasswordRules, passwordChecks } from "./fields";
import { AuthShell, Button, Notice, TextLink } from "./ui";

// 비밀번호 찾기 (BRD-148, 캔버스 V29, D16-A5)
// 등록되지 않은 이메일이어도 같은 화면·같은 문구(계정이 있는지 알려 주지 않음, 풀 설정 preventUserExistenceErrors)

const t = messages;

type View = "email" | "code" | "done";

export function ForgotFlow() {
  const config = POOLS?.operator;
  const [view, setView] = useState<View>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [codeError, setCodeError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!config) {
    return (
      <AuthShell title={t.forgot.title}>
        <Notice tone="fail" title={t.common.configError} role="alert" />
      </AuthShell>
    );
  }

  const run = (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void work().finally(() => setBusy(false));
  };

  const sendCode = (e?: FormEvent) => {
    e?.preventDefault();
    if (!email.trim()) return;
    run(async () => {
      try {
        await forgotPassword(config.clientId, email.trim());
      } catch (err) {
        const failure = authFailureOf(err);
        // 계정 없음·잠김도 같은 다음 화면으로 넘어감(존재 여부를 드러내지 않음). 연결 실패만 알림
        if (failure === "network" || failure === "limit_exceeded") {
          setError(failure === "network" ? t.common.network : t.common.limit);
          return;
        }
      }
      setCode("");
      setCodeError(false);
      setView("code");
    });
  };

  const checks = passwordChecks(next, confirm);

  if (view === "done") {
    return (
      <AuthShell
        title={t.forgot.doneTitle}
        description={t.forgot.doneDescription}
      >
        <Link
          href="/login/"
          className="inline-flex h-11 items-center justify-center rounded-[6px] bg-brand-default text-[15px] font-medium text-brand-on hover:bg-brand-hover sm:h-10 sm:text-[14px]"
        >
          {t.forgot.login}
        </Link>
      </AuthShell>
    );
  }

  if (view === "code") {
    return (
      <AuthShell
        title={codeError ? t.forgot.mismatchTitle : t.forgot.codeTitle}
        description={
          codeError ? t.forgot.mismatchDescription : t.forgot.codeDescription
        }
      >
        <form
          className="flex flex-col gap-[18px]"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (
              code.length !== 6 ||
              !checks.length ||
              !checks.number ||
              !checks.match
            )
              return;
            run(async () => {
              try {
                await confirmForgotPassword(
                  config.clientId,
                  email.trim(),
                  code,
                  next,
                );
                setView("done");
              } catch (err) {
                const failure = authFailureOf(err);
                if (failure === "code_mismatch" || failure === "code_expired") {
                  setCode("");
                  setCodeError(true);
                } else if (
                  failure === "password_rule" ||
                  failure === "password_reused"
                ) {
                  setError(
                    failure === "password_rule"
                      ? t.rules.violated
                      : t.rules.reused,
                  );
                } else {
                  setError(
                    failure === "network" ? t.common.network : t.common.unknown,
                  );
                }
              }
            });
          }}
        >
          <CodeInput
            label={t.forgot.codeLabel}
            value={code}
            onChange={setCode}
            error={codeError ? t.totp.mismatchHint : null}
            autoFocus
          />
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
            error={error}
          />
          <PasswordRules next={next} confirm={confirm} />
          <Button
            type="submit"
            disabled={
              busy ||
              code.length !== 6 ||
              !checks.length ||
              !checks.number ||
              !checks.match
            }
          >
            {t.forgot.change}
          </Button>
          {codeError && (
            <Button
              variant="secondary"
              onClick={() => sendCode()}
              disabled={busy}
            >
              {t.forgot.resend}
            </Button>
          )}
        </form>
        <p className="text-[12.5px] text-text-muted">{t.forgot.lost}</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={t.forgot.title} description={t.forgot.description}>
      <form className="flex flex-col gap-[18px]" onSubmit={sendCode} noValidate>
        <Field
          label={t.login.email}
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error}
          autoFocus
        />
        <Button type="submit" disabled={busy || !email.trim()}>
          {t.forgot.send}
        </Button>
      </form>
      <TextLink href="/login/">{t.common.backToLogin}</TextLink>
    </AuthShell>
  );
}
