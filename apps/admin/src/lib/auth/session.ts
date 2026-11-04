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
// - 토큰은 이 객체의 메모리에만 있음. 새로고침·새 탭은 열린 로그인한 탭에서 넘겨받고, 없으면 다시 로그인
// - access 만료 1분 전 refresh 회전으로 갱신. 실패하면 '다시 로그인' 상태(화면은 그대로 두고 로그인 창을 띄움)
// - 유휴 60분·최초 인증 8시간에 끝, 2분 전 경고. 8시간은 활동해도 늘지 않음
// - 로그아웃하면 다른 탭에도 알림. 즉시 전역 폐기를 보장하지 않음
// - 새 탭은 열려 있는 로그인한 탭에서 토큰을 넘겨받음(BroadcastChannel, 결정 기록 D17-9)
//   토큰은 계속 메모리에만 있음(D16-A2 그대로). 로그인한 탭이 하나도 없으면 다시 로그인
//   같은 계정·같은 최초 인증 시각의 탭끼리만 새 토큰·활동 시각을 맞춤 → 유휴 60분·8시간 상한은 탭 묶음에 한 번
// - refresh token은 회전(유예 0초)이라 두 탭이 같은 토큰으로 갱신하면 한쪽이 끊김 → 갱신은 잠금 안에서 한 탭씩
// 시계·타이머·Cognito 호출·탭 신호·잠금은 바깥에서 받음(테스트에서 바꿔 끼움)

export type SignOutReason =
  "logout" | "idle" | "max" | "other_tab" | "invalid_token";

export type SessionSnapshot =
  | {
      readonly status: "signed_out";
      readonly reason: SignOutReason | null;
      // 다른 탭에서 로그인을 넘겨받기를 기다리는 중(짧게). 로그인 화면은 이 동안 그리지 않음
      readonly joining?: true;
    }
  | {
      readonly status: "signed_in" | "reauth_required";
      readonly pool: PoolKind;
      readonly email: string | null;
      readonly groups: readonly string[];
      readonly phase: SessionPhase;
      // 로그인·다시 로그인할 때마다 1씩 늚(토큰 갱신에는 늘지 않음). 화면이 '다시 로그인 뒤 다시 읽기'에 씀
      readonly generation: number;
      readonly times: SessionTimes;
    };

export interface SessionDeps {
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly refresh: (pool: PoolKind, refreshToken: string) => Promise<Tokens>;
  readonly revoke: (pool: PoolKind, refreshToken: string) => Promise<void>;
  // 다른 탭과 주고받는 신호(BroadcastChannel). 없으면(지원 안 함) 이 탭만
  readonly channel?: {
    post: (message: unknown) => void;
    listen: (fn: (message: unknown) => void) => void;
  };
  // 탭 사이 갱신 잠금(Web Locks). 없으면 잠금 없이 바로 부름
  readonly lock?: <T>(fn: () => Promise<T>) => Promise<T>;
  // 넘겨받기 요청 id(테스트에서 고정)
  readonly newId?: () => string;
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

// 넘겨받기를 기다리는 시간. 로그인한 탭은 같은 기기라 바로 답함
export const JOIN_WAIT_MS = 400;
// 갱신에 실패했을 때 다른 탭이 먼저 갱신해 보낸 새 토큰을 기다리는 시간(잠금과 신호 도착 순서가 어긋날 때)
const ADOPT_WAIT_MS = 1500;

interface HelloMessage {
  readonly kind: "hello";
  readonly id: string;
}

// 로그인 상태 나누기. to: 넘겨받기 요청 id(답장), null이면 모든 탭(갱신·활동)
interface ShareMessage {
  readonly kind: "share";
  readonly to: string | null;
  readonly pool: PoolKind;
  readonly tokens: Tokens;
  readonly lastActivityMs: number;
}

function isHello(m: unknown): m is HelloMessage {
  return (
    typeof m === "object" &&
    m !== null &&
    (m as HelloMessage).kind === "hello" &&
    typeof (m as HelloMessage).id === "string"
  );
}

function isShare(m: unknown): m is ShareMessage {
  if (typeof m !== "object" || m === null) return false;
  const v = m as ShareMessage;
  return (
    v.kind === "share" &&
    (v.to === null || typeof v.to === "string") &&
    (v.pool === "operator" || v.pool === "demo") &&
    typeof v.lastActivityMs === "number" &&
    typeof v.tokens === "object" &&
    v.tokens !== null &&
    typeof v.tokens.accessToken === "string" &&
    typeof v.tokens.idToken === "string" &&
    typeof v.tokens.refreshToken === "string"
  );
}

export class AuthSession {
  private live: Live | null = null;
  private signedOutReason: SignOutReason | null = null;
  private generation = 0;
  private timer: unknown = null;
  private refreshing: Promise<boolean> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: SessionSnapshot = { status: "signed_out", reason: null };
  private joinId: string | null = null;
  // 넘겨받기는 탭을 연 뒤 한 번만(로그아웃 뒤 다시 넘겨받지 않음)
  private joinTried = false;

  constructor(private readonly deps: SessionDeps) {
    deps.channel?.listen((message) => {
      if (message === LOGOUT_MESSAGE) {
        if (this.live) this.end("other_tab", false);
      } else if (isHello(message)) {
        this.answerHello(message.id);
      } else if (isShare(message)) {
        this.receiveShare(message);
      }
    });
  }

  // 새 탭: 열려 있는 로그인한 탭에 로그인을 달라고 함. 잠깐 기다려 답이 없으면 로그인 화면
  join(): void {
    const channel = this.deps.channel;
    if (!channel || this.live || this.joinTried) return;
    this.joinTried = true;
    const id = this.deps.newId?.() ?? crypto.randomUUID();
    this.joinId = id;
    this.publishSignedOut();
    channel.post({ kind: "hello", id } satisfies HelloMessage);
    this.deps.setTimer(() => {
      if (this.joinId !== id) return;
      this.joinId = null;
      if (!this.live) this.publishSignedOut();
    }, JOIN_WAIT_MS);
  }

  private answerHello(id: string): void {
    const live = this.live;
    if (!live || live.reauth) return;
    // 끝날 때가 된 세션은 넘기지 않음(update가 곧 끝냄)
    const phase = this.currentPhase();
    if (phase === "idle_expired" || phase === "max_expired") return;
    this.share(id);
  }

  private share(to: string | null): void {
    const live = this.live;
    if (!live) return;
    this.deps.channel?.post({
      kind: "share",
      to,
      pool: live.pool,
      tokens: live.tokens,
      lastActivityMs: live.lastActivityMs,
    } satisfies ShareMessage);
  }

  private receiveShare(message: ShareMessage): void {
    const access = accessClaims(message.tokens.accessToken);
    if (!access) return;
    const live = this.live;
    if (!live) {
      // 내가 기다리던 답만 받음(로그아웃한 탭이 남의 갱신 신호로 다시 로그인되지 않게)
      if (message.to === null || message.to !== this.joinId) return;
      this.joinId = null;
      // 새 탭을 연 것도 활동으로 셈(signIn이 지금 시각으로 둠). 다른 탭의 유휴 시각도 함께 늦춤
      if (this.signIn(message.pool, message.tokens)) this.share(null);
      return;
    }
    if (message.to !== null) return;
    // 같은 풀·같은 사용자·같은 최초 인증의 탭끼리만 맞춤(다른 계정·새 로그인과 섞지 않음)
    const mine = accessClaims(live.tokens.accessToken);
    if (
      message.pool !== live.pool ||
      !mine ||
      access.sub !== mine.sub ||
      access.authTimeMs !== live.authTimeMs
    ) {
      return;
    }
    if (access.expMs > live.accessExpMs) {
      live.tokens = message.tokens;
      live.accessExpMs = access.expMs;
      // 다시 로그인을 기다리던 탭이 풀리면 화면이 다시 읽도록 generation을 늘림
      if (live.reauth) this.generation += 1;
      live.reauth = false;
    }
    live.lastActivityMs = Math.max(live.lastActivityMs, message.lastActivityMs);
    this.update();
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
    this.joinId = null;
    this.generation += 1;
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
    // 다른 탭의 유휴 시각도 늦춤(쓰지 않던 탭이 쓰던 탭까지 로그아웃시키지 않게)
    this.share(null);
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
    const lock = this.deps.lock ?? ((fn) => fn());
    this.refreshing = lock(async () => {
      // 잠금을 기다리는 동안 로그아웃·다른 로그인으로 바뀌었으면 옛 토큰으로 부르지 않음
      if (this.live !== live) return false;
      // 잠금을 기다리는 동안 다른 탭이 갱신해 보낸 토큰을 받았으면 다시 부르지 않음
      const times = this.times();
      if (times && this.deps.now() < times.refreshAt) return true;
      const sent = live.tokens.refreshToken;
      let tokens: Tokens;
      try {
        tokens = await this.deps.refresh(live.pool, sent);
      } catch (error) {
        // 다른 탭이 같은 refresh token을 먼저 회전시켰을 수 있음 → 그 탭이 보낸 새 토큰을 잠깐 기다림
        await new Promise<void>((done) =>
          this.deps.setTimer(() => done(), ADOPT_WAIT_MS),
        );
        if (this.live === live && live.tokens.refreshToken !== sent) {
          return true;
        }
        throw error;
      }
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
      // 잠금을 풀기 전에 알림(다음 탭이 회전된 refresh token으로 다시 부르지 않게)
      this.share(null);
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
      this.publishSignedOut();
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
      generation: this.generation,
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

  private publishSignedOut(): void {
    this.publish(
      this.joinId
        ? { status: "signed_out", reason: this.signedOutReason, joining: true }
        : { status: "signed_out", reason: this.signedOutReason },
    );
  }

  private publish(next: SessionSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
