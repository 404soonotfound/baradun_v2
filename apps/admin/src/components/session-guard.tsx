"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { POOLS, type PoolKind } from "@/lib/auth/config";
import { authFailureOf } from "@/lib/auth/errors";
import { useAuthSession, useSessionSnapshot } from "@/lib/auth/provider";
import { rememberReturnTo } from "@/lib/auth/return-to";
import { secondsLeft } from "@/lib/auth/session-time";
import { idClaims } from "@/lib/auth/tokens";
import { newChallengeUser, startSignIn, type SignInStep } from "@/lib/auth/srp";
import { fill, messages } from "@/lib/messages";
import { CodeInput, Field } from "./fields";
import { Button, Notice } from "./ui";

// 로그인한 화면을 감쌈 (BRD-148, 캔버스 V31·E8·E11·VE3, D16-A3·E1)
// - 로그아웃 상태면 보던 주소를 기억하고 로그인 화면으로(데모 계정이었으면 데모 로그인으로)
//   새 탭은 먼저 열린 탭에서 로그인을 넘겨받기를 잠깐 기다림(provider·session.join)
// - 유휴 만료 2분 전: '계속 쓰기' 경고. 8시간 상한 2분 전: 연장 없는 경고
// - 갱신 실패: 화면을 그대로 두고 위에 다시 로그인 창(같은 계정만). 쓰던 입력은 이 탭 메모리에 그대로

const t = messages;

// 마지막으로 쓴 풀. 로그아웃 뒤 어느 로그인 화면으로 보낼지 정함(메모리만)
let lastPool: PoolKind = "operator";

function clock(ms: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  }).format(ms);
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

// 경고가 뜰 때 처음 그려짐 → 그때부터 남은 시간을 셈(화면을 처음 연 시각으로 세지 않게)
function IdleCountdown({ endsAt }: { endsAt: number }) {
  const session = useAuthSession();
  const now = useNow();
  const minutes = Math.max(1, Math.ceil(secondsLeft(endsAt, now) / 60));
  return (
    <Notice
      tone="brand"
      title={fill(t.session.idleWarning, { minutes })}
      role="alert"
    >
      <p>{t.session.idleWarningHint}</p>
      <Button size="small" className="mt-2" onClick={() => session.touch()}>
        {t.session.keepGoing}
      </Button>
    </Notice>
  );
}

function SessionWarning() {
  const snapshot = useSessionSnapshot();
  if (snapshot.status !== "signed_in") return null;
  if (snapshot.phase === "max_warning") {
    return (
      <Notice tone="warn" title={t.session.maxWarning} role="alert">
        {fill(t.session.maxWarningHint, {
          time: clock(snapshot.times.maxEndAt),
        })}
      </Notice>
    );
  }
  if (snapshot.phase === "idle_warning") {
    return <IdleCountdown endsAt={snapshot.times.idleEndAt} />;
  }
  return null;
}

// 다시 로그인 창: 같은 계정의 비밀번호(운영자는 인증 앱 코드까지)로 토큰만 바꿈
function ReauthDialog({ pool, email }: { pool: PoolKind; email: string }) {
  const session = useAuthSession();
  const dialog = useRef<HTMLDialogElement>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Extract<
    SignInStep,
    { kind: "totp" }
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  const accept = (next: SignInStep) => {
    if (next.kind === "totp") {
      setStep(next);
      setError(null);
      return;
    }
    if (next.kind !== "signed_in") {
      setError(t.session.reauthOtherAccount);
      return;
    }
    // 다른 계정 토큰으로 이 화면을 이어 쓰지 않음
    if (idClaims(next.tokens.idToken).email !== email) {
      setError(t.session.reauthOtherAccount);
      return;
    }
    session.reauthenticate(next.tokens);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const config = POOLS?.[pool];
    if (!config || busy) return;
    setBusy(true);
    void (async () => {
      try {
        accept(
          step
            ? await step.submit(code)
            : await startSignIn(
                newChallengeUser(config, email),
                email,
                password,
              ),
        );
      } catch (err) {
        const failure = authFailureOf(err);
        setCode("");
        setError(
          failure === "code_mismatch"
            ? t.totp.mismatchHint
            : failure === "wrong_credentials"
              ? t.login.wrongCredentials
              : failure === "network"
                ? t.common.network
                : t.common.unknown,
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="reauth-title"
      // Esc로 닫으면 토큰 없는 화면이 남으므로 닫지 않음(로그아웃은 화면의 버튼으로)
      onCancel={(e) => e.preventDefault()}
      className="m-auto w-[calc(100%-32px)] max-w-[360px] rounded-admin-box border border-border-default bg-bg-surface p-6 text-text-default shadow-floating backdrop:bg-[rgb(11_26_44/0.4)]"
    >
      <form className="flex flex-col gap-[18px]" onSubmit={submit} noValidate>
        <div>
          <h2 id="reauth-title" className="text-title-m font-semibold">
            {t.session.reauthTitle}
          </h2>
          <p className="mt-1 text-label-s text-text-muted">
            {t.session.reauthDescription}
          </p>
        </div>
        {step ? (
          <CodeInput
            label={t.totp.label}
            value={code}
            onChange={setCode}
            error={error}
            autoFocus
          />
        ) : (
          <>
            <Field label={t.login.email} type="email" value={email} readOnly />
            <Field
              label={t.login.password}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={error}
              autoFocus
            />
          </>
        )}
        <Button
          type="submit"
          disabled={busy || (step ? code.length !== 6 : !password)}
        >
          {busy ? t.common.working : t.session.reauthSubmit}
        </Button>
      </form>
    </dialog>
  );
}

// 데모 표시와 세션 경고. 공통 틀이 본문 맨 위에 둠(메뉴 위가 아니라 지금 보는 화면 위)
export function SessionNotices() {
  const snapshot = useSessionSnapshot();
  if (snapshot.status === "signed_out") return null;
  return (
    <>
      {snapshot.pool === "demo" && (
        <div className="bg-status-stale-bg px-4 py-2 text-center text-body-s font-medium text-status-stale-fg">
          {t.home.demoBadge}
        </div>
      )}
      <div className="w-full px-4 pt-4 empty:hidden md:px-10">
        <SessionWarning />
      </div>
    </>
  );
}

// 로그인을 이어 가는 동안(열린 탭에서 넘겨받기 최대 0.4초, 새로고침 갱신은 Cognito 응답까지, D17-11) 안내
// 짧은 넘겨받기에서 깜박이지 않게 1초 뒤에 글을 넣음(알림 영역은 처음부터 둠)
export function SessionResuming() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 1000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <p
      role="status"
      className="px-4 py-10 text-center text-body-s text-text-muted"
    >
      {shown ? t.session.resuming : ""}
    </p>
  );
}

export function SessionGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const session = useAuthSession();
  const snapshot = useSessionSnapshot();

  useEffect(() => {
    // 새 탭: 로그인 화면으로 보내기 전에 넘겨받기를 먼저 시작함(탭마다 한 번, 로그인 화면은 LoginFlow가 풀을 정해 부름)
    // 시작한 직후의 상태(joining)를 보려고 스냅숏을 다시 읽음
    session.join();
    const current = session.getSnapshot();
    // 다른 탭에서 로그인을 넘겨받는 중이면 기다림(받으면 이 화면 그대로)
    if (current.status === "signed_out" && current.joining) return;
    if (current.status === "signed_out") {
      rememberReturnTo(pathname);
      // 새로고침하면 lastPool은 처음 값이라, 끝난 저장 값의 풀이 있으면 그 풀로 보냄
      const pool = current.pool ?? lastPool;
      router.replace(pool === "demo" ? "/login/demo/" : "/login/");
    } else {
      lastPool = current.pool;
    }
  }, [session, snapshot, pathname, router]);

  if (snapshot.status === "signed_out") {
    return snapshot.joining ? <SessionResuming /> : null;
  }

  return (
    <>
      {children}
      {snapshot.status === "reauth_required" && snapshot.email && (
        <ReauthDialog pool={snapshot.pool} email={snapshot.email} />
      )}
    </>
  );
}
