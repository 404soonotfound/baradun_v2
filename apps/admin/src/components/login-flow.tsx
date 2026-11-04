"use client";

import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { POOLS, type PoolKind } from "@/lib/auth/config";
import { authFailureOf, type AuthFailure } from "@/lib/auth/errors";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import { peekReturnTo, takeReturnTo } from "@/lib/auth/return-to";
import type { SignOutReason } from "@/lib/auth/session";
import {
  newChallengeUser,
  otpauthUri,
  startSignIn,
  type SignInStep,
  type Tokens,
} from "@/lib/auth/srp";
import { messages } from "@/lib/messages";
import { CodeInput, Field, PasswordRules, passwordChecks } from "./fields";
import { SessionResuming } from "./session-guard";
import { AuthShell, Button, Notice, TextLink } from "./ui";

// 로그인 흐름 (BRD-148, 캔버스 V26·V27·V28, F2)
// 운영자: 비밀번호 → 인증 앱 코드(처음이면 새 비밀번호 → 인증 앱 등록) → 운영 홈
// 데모(/login/demo/, D17-2): 비밀번호(처음이면 새 비밀번호) → 운영 홈. 2단계 없음
// 틀린 이메일·비밀번호는 계정이 있는지와 상관없이 같은 문구. 잠금은 남은 시간·횟수를 보여 주지 않음(D16-A5)

const t = messages;

// 로컬 개발 서버 전용 테스트 로그인(BRD-172). 배포 빌드에서 빠지도록 개발 분기 안에서만 불러옴
const LocalDevLogin =
  process.env.NODE_ENV === "development"
    ? lazy(() =>
        import("./local-dev-login").then((m) => ({ default: m.LocalDevLogin })),
      )
    : null;

type View =
  | { kind: "form"; error: string | null }
  | { kind: "locked" }
  | {
      kind: "totp";
      step: Extract<SignInStep, { kind: "totp" }>;
      error: boolean;
    }
  | {
      kind: "new_password";
      step: Extract<SignInStep, { kind: "new_password" }>;
      error: string | null;
    }
  | {
      kind: "totp_setup";
      step: Extract<SignInStep, { kind: "totp_setup" }>;
      qr: string;
      error: boolean;
    }
  | { kind: "done"; tokens: Tokens };

function failureText(failure: AuthFailure): string {
  switch (failure) {
    case "wrong_credentials":
      return t.login.wrongCredentials;
    case "reset_required":
      return t.login.resetRequired;
    case "session_expired":
      return t.login.sessionExpired;
    case "password_rule":
      return t.rules.violated;
    case "password_reused":
      return t.rules.reused;
    case "limit_exceeded":
      return t.common.limit;
    case "network":
      return t.common.network;
    default:
      return t.common.unknown;
  }
}

function SignedOutNotice({ reason }: { reason: SignOutReason | null }) {
  const returnTo = peekReturnTo();
  const returnRow = returnTo && returnTo !== "/" && (
    <p>
      {t.session.returnTo}: {returnTo}
    </p>
  );
  switch (reason) {
    case "idle":
    case "max":
      return (
        <Notice tone="neutral" title={t.session.expiredTitle} role="status">
          <p>
            {reason === "idle"
              ? t.session.idleDescription
              : t.session.maxDescription}
          </p>
          {returnRow}
          <p>{t.session.unsaved}</p>
        </Notice>
      );
    case "other_tab":
      return (
        <Notice tone="neutral" title={t.session.otherTabTitle} role="status">
          {t.session.otherTabDescription}
        </Notice>
      );
    case "logout":
      return (
        <Notice tone="neutral" title={t.session.logoutTitle} role="status">
          {t.session.logoutDescription}
        </Notice>
      );
    case "invalid_token":
      return (
        <Notice tone="fail" title={t.session.invalidTitle} role="alert">
          {t.session.invalidDescription}
        </Notice>
      );
    default:
      return null;
  }
}

export function LoginFlow({ pool }: { pool: PoolKind }) {
  const router = useRouter();
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();
  const config = POOLS?.[pool];
  const [view, setView] = useState<View>({ kind: "form", error: null });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);

  // 새 탭으로 로그인 화면을 열면 같은 풀로 로그인한 탭에서 넘겨받음(데모 주소는 데모 탭만)
  useEffect(() => {
    session.join(pool);
  }, [session, pool]);

  // 이미 로그인한 탭이면 보던 화면(없으면 운영 홈)으로. 돌아갈 화면은 한 번만 꺼냄
  // (개발 서버의 StrictMode가 효과를 두 번 부르면 두 번째가 홈으로 덮어씀)
  const leaving = useRef(false);
  useEffect(() => {
    if (snapshot.status !== "signed_in" || leaving.current) return;
    leaving.current = true;
    router.replace(takeReturnTo());
  }, [snapshot.status, router]);

  // 이동은 위 효과 하나만 함(돌아갈 화면을 두 번 꺼내 쓰면 두 번째가 홈이 됨)
  const finish = (tokens: Tokens) => {
    if (!session.signIn(pool, tokens)) {
      setView({ kind: "form", error: t.session.invalidDescription });
    }
  };

  // 단계마다 화면을 고름. 처음 로그인(새 비밀번호·인증 앱 등록)을 거친 경우엔 '준비가 끝났어요'를 보여 줌
  const show = async (step: SignInStep, firstTime: boolean) => {
    setCode("");
    switch (step.kind) {
      case "signed_in":
        if (firstTime) setView({ kind: "done", tokens: step.tokens });
        else finish(step.tokens);
        return;
      case "totp":
        setView({ kind: "totp", step, error: false });
        return;
      case "new_password":
        setNext("");
        setConfirm("");
        setView({ kind: "new_password", step, error: null });
        return;
      case "totp_setup": {
        const qr = await QRCode.toString(otpauthUri(step.secret, email), {
          type: "svg",
          margin: 0,
          errorCorrectionLevel: "M",
        });
        setShowKey(false);
        setView({ kind: "totp_setup", step, qr, error: false });
        return;
      }
    }
  };

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  // 로컬 개발 서버에서만(BRD-172). 풀 설정이 없어도 씀
  const localDev = LocalDevLogin ? (
    <Suspense fallback={null}>
      <LocalDevLogin pool={pool} />
    </Suspense>
  ) : null;

  if (!config) {
    return (
      <AuthShell title={pool === "demo" ? t.login.demoTitle : t.login.title}>
        <Notice tone="fail" title={t.common.configError} role="alert" />
        {localDev}
      </AuthShell>
    );
  }

  const onPassword = (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setView({ kind: "form", error: t.login.required });
      return;
    }
    void run(async () => {
      try {
        const step = await startSignIn(
          newChallengeUser(config, email.trim()),
          email.trim(),
          password,
        );
        setPassword("");
        await show(step, false);
      } catch (error) {
        const failure = authFailureOf(error);
        if (failure === "locked") setView({ kind: "locked" });
        else setView({ kind: "form", error: failureText(failure) });
      }
    });
  };

  const backToForm = () => {
    setCode("");
    setPassword("");
    setView({ kind: "form", error: null });
  };

  // 로그인을 이어 가는 동안(넘겨받기·새로고침 갱신)은 로그인 칸을 그리지 않음(받으면 바로 보던 화면으로)
  if (snapshot.status === "signed_out" && snapshot.joining) {
    return <SessionResuming />;
  }

  switch (view.kind) {
    case "form":
      return (
        <AuthShell
          title={pool === "demo" ? t.login.demoTitle : t.login.title}
          description={
            pool === "demo" ? t.login.demoDescription : t.login.description
          }
        >
          {snapshot.status === "signed_out" && (
            <SignedOutNotice reason={snapshot.reason} />
          )}
          <form
            className="flex flex-col gap-[18px]"
            onSubmit={onPassword}
            noValidate
          >
            <Field
              label={t.login.email}
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Field
              label={t.login.password}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              error={view.error}
              aside={
                pool === "operator" && (
                  <TextLink href="/login/forgot/">{t.login.forgot}</TextLink>
                )
              }
            />
            <Button type="submit" disabled={busy}>
              {busy ? t.common.working : t.login.submit}
            </Button>
          </form>
          {localDev}
        </AuthShell>
      );
    case "locked":
      return (
        <AuthShell
          title={t.login.lockedTitle}
          description={t.login.lockedDescription}
        >
          <Notice tone="warn" title={t.login.lockedBox} role="alert">
            {t.login.lockedHint}
          </Notice>
          {pool === "operator" && (
            <Button
              variant="secondary"
              onClick={() => router.push("/login/forgot/")}
            >
              {t.login.lockedAction}
            </Button>
          )}
          <Button variant="quiet" size="small" onClick={backToForm}>
            {t.common.backToLogin}
          </Button>
        </AuthShell>
      );
    case "totp":
      return (
        <AuthShell
          title={view.error ? t.totp.mismatchTitle : t.totp.title}
          description={
            view.error ? t.totp.mismatchDescription : t.totp.description
          }
        >
          <form
            className="flex flex-col gap-[18px]"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                try {
                  await show(await view.step.submit(code), false);
                } catch (error) {
                  const failure = authFailureOf(error);
                  if (
                    failure === "code_mismatch" ||
                    failure === "code_expired"
                  ) {
                    setCode("");
                    setView({ ...view, error: true });
                  } else {
                    setView({ kind: "form", error: failureText(failure) });
                  }
                }
              });
            }}
          >
            <CodeInput
              label={t.totp.label}
              value={code}
              onChange={setCode}
              error={view.error ? t.totp.mismatchHint : null}
              autoFocus
            />
            <Button type="submit" disabled={busy || code.length !== 6}>
              {view.error ? t.totp.retry : t.totp.submit}
            </Button>
            <p className="text-label-s text-text-muted">{t.totp.paste}</p>
          </form>
          <Button variant="quiet" size="small" onClick={backToForm}>
            {t.totp.otherAccount}
          </Button>
        </AuthShell>
      );
    case "new_password": {
      const checks = passwordChecks(next, confirm);
      return (
        <AuthShell
          title={t.welcome.passwordTitle}
          description={t.welcome.passwordDescription}
        >
          <form
            className="flex flex-col gap-[18px]"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!checks.length || !checks.number || !checks.match) return;
              void run(async () => {
                try {
                  await show(await view.step.submit(next), true);
                } catch (error) {
                  setView({
                    ...view,
                    error: failureText(authFailureOf(error)),
                  });
                }
              });
            }}
          >
            <Field
              label={t.welcome.newPassword}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoFocus
            />
            <Field
              label={t.welcome.confirmPassword}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              error={view.error}
            />
            <PasswordRules next={next} confirm={confirm} />
            <Button
              type="submit"
              disabled={
                busy || !checks.length || !checks.number || !checks.match
              }
            >
              {t.welcome.next}
            </Button>
          </form>
        </AuthShell>
      );
    }
    case "totp_setup":
      return (
        <AuthShell
          title={t.welcome.setupTitle}
          description={t.welcome.setupDescription}
        >
          <div className="flex flex-col items-center gap-2">
            <div
              role="img"
              aria-label={t.welcome.qrLabel}
              className="size-[160px] rounded-admin-control border border-border-default bg-white p-2 [&_svg]:size-full"
              // QR 라이브러리가 만든 SVG(키만 담음). 외부 주소·스크립트 없음
              dangerouslySetInnerHTML={{ __html: view.qr }}
            />
            <Button
              variant="quiet"
              size="small"
              aria-expanded={showKey}
              onClick={() => setShowKey((v) => !v)}
            >
              {t.welcome.keyToggle}
            </Button>
            {showKey && (
              <div className="w-full rounded-admin-control border border-border-default bg-bg-page p-2.5 text-label-s text-text-body">
                <p className="font-medium text-text-default">
                  {t.welcome.keyLabel}
                </p>
                <p className="mt-1 font-mono text-body break-all text-text-default select-all">
                  {view.step.secret.match(/.{1,4}/g)?.join(" ")}
                </p>
                <p className="mt-1">{t.welcome.keyHint}</p>
              </div>
            )}
          </div>
          <form
            className="flex flex-col gap-[18px]"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                try {
                  await show(await view.step.submit(code), true);
                } catch (error) {
                  const failure = authFailureOf(error);
                  if (failure === "code_mismatch") {
                    setCode("");
                    setView({ ...view, error: true });
                  } else {
                    setView({ kind: "form", error: failureText(failure) });
                  }
                }
              });
            }}
          >
            <CodeInput
              label={t.totp.label}
              value={code}
              onChange={setCode}
              error={view.error ? t.totp.mismatchHint : null}
            />
            <Button type="submit" disabled={busy || code.length !== 6}>
              {t.welcome.connect}
            </Button>
            <p className="text-label-s text-text-muted">{t.welcome.smsNote}</p>
          </form>
        </AuthShell>
      );
    case "done":
      return (
        <AuthShell
          title={t.welcome.doneTitle}
          description={
            pool === "demo"
              ? t.welcome.doneDemoDescription
              : t.welcome.doneDescription
          }
        >
          <Button onClick={() => finish(view.tokens)}>{t.welcome.home}</Button>
        </AuthShell>
      );
  }
}
