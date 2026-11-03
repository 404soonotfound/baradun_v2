import type { PoolKind } from "./config";
import { accessClaims, idClaims } from "./tokens";
import {
  nextWakeAt,
  sessionPhase,
  sessionTimes,
  type SessionPhase,
  type SessionTimes,
} from "./session-time";
import type { Tokens } from "./srp";

// 로그인 세션 (BRD-148, 결정 기록 D16-A2·A3·A10·E1)
// - 토큰은 이 객체의 메모리에만 있음. 새로고침·새 탭은 다시 로그인
// - access 만료 1분 전 refresh 회전으로 갱신. 실패하면 '다시 로그인' 상태(화면은 그대로 두고 로그인 창을 띄움)
// - 유휴 30분·최초 인증 8시간에 끝, 2분 전 경고. 8시간은 활동해도 늘지 않음
// - 로그아웃하면 다른 탭에 신호만 보냄(토큰은 보내지 않음). 즉시 전역 폐기를 보장하지 않음
// 시계·타이머·Cognito 호출·탭 신호는 바깥에서 받음(테스트에서 바꿔 끼움)

export type SignOutReason =
  "logout" | "idle" | "max" | "other_tab" | "invalid_token";

export type SessionSnapshot =
  | { readonly status: "signed_out"; readonly reason: SignOutReason | null }
  | {
      readonly status: "signed_in" | "reauth_required";
      readonly pool: PoolKind;
      readonly email: string | null;
      readonly groups: readonly string[];
      readonly phase: SessionPhase;
      readonly times: SessionTimes;
    };

export interface SessionDeps {
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly refresh: (pool: PoolKind, refreshToken: string) => Promise<Tokens>;
  readonly revoke: (pool: PoolKind, refreshToken: string) => Promise<void>;
  // 다른 탭 로그아웃 신호(BroadcastChannel). 없으면(지원 안 함) 이 탭만
  readonly channel?: {
    post: (message: string) => void;
    listen: (fn: (message: string) => void) => void;
  };
}

interface Live {
  pool: PoolKind;
  tokens: Tokens;
  email: string | null;
  groups: readonly string[];
  authTimeMs: number;
  accessExpMs: number;
  lastActivityMs: number;
  reauth: boolean;
}

const LOGOUT_MESSAGE = "logout";

export class AuthSession {
  private live: Live | null = null;
  private signedOutReason: SignOutReason | null = null;
  private timer: unknown = null;
  private refreshing: Promise<boolean> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: SessionSnapshot = { status: "signed_out", reason: null };

  constructor(private readonly deps: SessionDeps) {
    deps.channel?.listen((message) => {
      if (message === LOGOUT_MESSAGE && this.live) this.end("other_tab", false);
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  // 로그인 끝: 토큰 클레임이 틀리면 로그인으로 보지 않음
  signIn(pool: PoolKind, tokens: Tokens): boolean {
    const access = accessClaims(tokens.accessToken);
    if (!access) {
      this.end("invalid_token", false);
      return false;
    }
    this.live = {
      pool,
      tokens,
      email: idClaims(tokens.idToken).email,
      groups: access.groups,
      authTimeMs: access.authTimeMs,
      accessExpMs: access.expMs,
      lastActivityMs: this.deps.now(),
      reauth: false,
    };
    this.signedOutReason = null;
    this.update();
    return true;
  }

  // 사용자 활동(클릭·입력·'계속 쓰기'). 끝난 세션·8시간 경고는 풀지 않음(유휴 시각만 새로 셈)
  touch(): void {
    if (!this.live) return;
    const phase = this.currentPhase();
    if (phase === "idle_expired" || phase === "max_expired") return;
    this.live.lastActivityMs = this.deps.now();
    this.update();
  }

  // 운영 API에 실을 access token. 만료가 가까우면 먼저 갱신. 다시 로그인이 필요하면 null
  async accessToken(): Promise<string | null> {
    if (!this.live || this.live.reauth) return null;
    const times = this.times();
    if (times && this.deps.now() >= times.refreshAt) {
      if (!(await this.refreshNow())) return null;
    }
    return this.live?.reauth ? null : (this.live?.tokens.accessToken ?? null);
  }

  // 같은 탭의 다시 로그인(로그인 창): 같은 풀·같은 계정이면 화면을 유지하고 토큰만 바꿈
  reauthenticate(tokens: Tokens): boolean {
    const pool = this.live?.pool;
    if (!pool) return false;
    return this.signIn(pool, tokens);
  }

  async logout(): Promise<void> {
    const live = this.live;
    this.end("logout", true);
    if (live) {
      // 폐기 실패는 화면 로그아웃을 막지 않음(토큰은 이미 메모리에서 지움)
      await this.deps
        .revoke(live.pool, live.tokens.refreshToken)
        .catch(() => undefined);
    }
  }

  private times(): SessionTimes | null {
    return this.live
      ? sessionTimes({
          authTimeMs: this.live.authTimeMs,
          accessExpMs: this.live.accessExpMs,
          lastActivityMs: this.live.lastActivityMs,
        })
      : null;
  }

  private currentPhase(): SessionPhase {
    const times = this.times();
    return times ? sessionPhase(times, this.deps.now()) : "active";
  }

  private refreshNow(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    const live = this.live;
    if (!live) return Promise.resolve(false);
    this.refreshing = this.deps
      .refresh(live.pool, live.tokens.refreshToken)
      .then((tokens) => {
        const access = accessClaims(tokens.accessToken);
        // 갱신해도 최초 인증 시각은 그대로여야 함(바뀌면 8시간 상한이 늘어나므로 받지 않음)
        if (
          !access ||
          access.authTimeMs !== live.authTimeMs ||
          this.live !== live
        ) {
          if (this.live === live) live.reauth = true;
          return false;
        }
        live.tokens = {
          accessToken: tokens.accessToken,
          idToken: tokens.idToken || live.tokens.idToken,
          refreshToken: tokens.refreshToken || live.tokens.refreshToken,
        };
        live.accessExpMs = access.expMs;
        return true;
      })
      .catch(() => {
        if (this.live === live) live.reauth = true;
        return false;
      })
      .finally(() => {
        this.refreshing = null;
        this.update();
      });
    return this.refreshing;
  }

  private end(reason: SignOutReason, broadcast: boolean): void {
    const wasSignedIn = this.live !== null;
    this.live = null;
    this.signedOutReason = reason;
    if (broadcast && wasSignedIn) this.deps.channel?.post(LOGOUT_MESSAGE);
    this.update();
  }

  // 상태를 다시 계산하고 다음 경계에 깨어나게 함
  private update(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    const live = this.live;
    const times = this.times();
    if (!live || !times) {
      this.publish({ status: "signed_out", reason: this.signedOutReason });
      return;
    }
    const now = this.deps.now();
    const phase = sessionPhase(times, now);
    if (phase === "max_expired" || phase === "idle_expired") {
      this.end(phase === "max_expired" ? "max" : "idle", true);
      return;
    }
    this.publish({
      status: live.reauth ? "reauth_required" : "signed_in",
      pool: live.pool,
      email: live.email,
      groups: live.groups,
      phase,
      times,
    });
    // 다시 로그인을 기다리는 동안은 갱신 시각으로 깨지 않음(갱신 실패를 계속 되풀이하지 않게)
    const wake = nextWakeAt(
      live.reauth ? { ...times, refreshAt: Number.POSITIVE_INFINITY } : times,
      now,
    );
    this.timer = this.deps.setTimer(
      () => {
        this.timer = null;
        if (!this.live) return;
        if (!this.live.reauth && this.deps.now() >= times.refreshAt) {
          void this.refreshNow();
        } else {
          this.update();
        }
      },
      Math.max(0, wake - now),
    );
  }

  private publish(next: SessionSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
