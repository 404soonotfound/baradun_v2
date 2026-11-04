import type { PoolKind } from "./config";
import { authFailureOf } from "./errors";
import { accessClaims, idClaims } from "./tokens";
import {
  nextWakeAt,
  sessionPhase,
  sessionTimes,
  type SessionPhase,
  type SessionTimes,
} from "./session-time";
import type { Tokens } from "./srp";

// 로그인 세션 (BRD-148·179, 결정 기록 D16-A2·A3·A10·E1·D17-11)
// - access·ID token은 이 객체의 메모리에만 있음. refresh token만 이 탭의 저장소(sessionStorage)에도 둠(D17-11)
// - 새로고침·새 탭은 열린 로그인한 탭에서 넘겨받고, 없으면 이 탭에 둔 refresh token으로 갱신해 이어 감. 그것도 없으면 다시 로그인
// - access 만료 1분 전 refresh 회전으로 갱신. 실패하면 '다시 로그인' 상태(화면은 그대로 두고 로그인 창을 띄움)
// - 유휴 60분·최초 인증 8시간에 끝, 2분 전 경고. 8시간은 활동해도 늘지 않음
// - 로그아웃하면 다른 탭에도 알림. 즉시 전역 폐기를 보장하지 않음
// - 새 탭은 열려 있는 로그인한 탭에서 토큰을 넘겨받음(BroadcastChannel, 결정 기록 D17-9)
//   같은 계정·같은 최초 인증 시각의 탭끼리만 새 토큰·활동 시각을 맞춤 → 유휴 60분·8시간 상한은 탭 묶음에 한 번
// - refresh token은 회전(유예 0초)이라 두 탭이 같은 토큰으로 갱신하면 한쪽이 끊김 → 갱신은 잠금 안에서 한 탭씩
// 시계·타이머·Cognito 호출·탭 신호·잠금은 바깥에서 받음(테스트에서 바꿔 끼움)

export type SignOutReason =
  | "logout"
  | "idle"
  | "max"
  | "other_tab"
  | "invalid_token"
  // 새로고침 때 이 탭에 둔 로그인을 이어 가지 못함: 토큰 거부(저장 값 지움) · 일시적 실패(저장 값 둠, D17-11)
  | "resume_rejected"
  | "resume_failed";

export type SessionSnapshot =
  | {
      readonly status: "signed_out";
      readonly reason: SignOutReason | null;
      // 끝난 저장 값의 풀(로그인 화면을 그 풀로). 이어 가기·저장 값이 끝났을 때만
      readonly pool?: PoolKind;
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
  // 새로고침해도 로그인을 잇는 이 탭의 저장소(sessionStorage, D17-11). 없으면 새로고침은 다시 로그인
  readonly store?: {
    load: () => unknown;
    save: (saved: SavedSession | null) => void;
  };
}

// 이 탭에 두는 값. access·ID token은 두지 않음
export interface SavedSession {
  readonly pool: PoolKind;
  readonly sub: string;
  readonly refreshToken: string;
  readonly authTimeMs: number;
  readonly lastActivityMs: number;
}

function parseSaved(v: unknown): SavedSession | null {
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  return isPool(s.pool) &&
    typeof s.sub === "string" &&
    typeof s.refreshToken === "string" &&
    s.refreshToken !== "" &&
    typeof s.authTimeMs === "number" &&
    typeof s.lastActivityMs === "number"
    ? (s as unknown as SavedSession)
    : null;
}

interface Live {
  pool: PoolKind;
  sub: string;
  tokens: Tokens;
  email: string | null;
  groups: readonly string[];
  authTimeMs: number;
  accessExpMs: number;
  lastActivityMs: number;
  reauth: boolean;
}

// 넘겨받기를 기다리는 시간. 로그인한 탭은 같은 기기라 바로 답함
export const JOIN_WAIT_MS = 400;
// 갱신에 실패했을 때 다른 탭이 먼저 갱신해 보낸 새 토큰을 기다리는 시간(잠금과 신호 도착 순서가 어긋날 때)
const ADOPT_WAIT_MS = 1500;

// 탭 사이 신호. 받는 쪽은 모양을 확인하고, 같은 풀·같은 사용자(·같은 최초 인증)의 신호만 따름
// - logout: 로그아웃·유휴·상한으로 끝남. 유휴는 받는 탭이 더 늦은 활동을 봤으면 따르지 않음
// - hello: 새 탭이 로그인을 달라고 함(pool이 있으면 그 풀만 답함)
// - share: 토큰 나누기(넘겨받기 답장 to=요청 id, 갱신·다시 로그인 뒤 to=null)
// - activity: 활동 시각만 맞춤(토큰 없음). ask면 받은 탭도 자기 활동 시각을 답함(유휴 만료 전 확인)
interface Group {
  readonly pool: PoolKind;
  readonly sub: string;
  readonly authTimeMs: number;
}

interface LogoutMessage extends Group {
  readonly kind: "logout";
  readonly reason: "logout" | "idle" | "max";
}

interface HelloMessage {
  readonly kind: "hello";
  readonly id: string;
  readonly pool: PoolKind | null;
}

interface ShareMessage {
  readonly kind: "share";
  readonly to: string | null;
  readonly pool: PoolKind;
  readonly tokens: Tokens;
  readonly lastActivityMs: number;
}

interface ActivityMessage extends Group {
  readonly kind: "activity";
  readonly lastActivityMs: number;
  readonly ask: boolean;
}

type Message = LogoutMessage | HelloMessage | ShareMessage | ActivityMessage;

const isPool = (v: unknown): v is PoolKind => v === "operator" || v === "demo";

function isGroup(v: Record<string, unknown>): boolean {
  return (
    isPool(v.pool) &&
    typeof v.sub === "string" &&
    typeof v.authTimeMs === "number"
  );
}

function parseMessage(m: unknown): Message | null {
  if (typeof m !== "object" || m === null) return null;
  const v = m as Record<string, unknown>;
  switch (v.kind) {
    case "logout":
      return isGroup(v) &&
        (v.reason === "logout" || v.reason === "idle" || v.reason === "max")
        ? (v as unknown as LogoutMessage)
        : null;
    case "hello":
      return typeof v.id === "string" && (v.pool === null || isPool(v.pool))
        ? (v as unknown as HelloMessage)
        : null;
    case "share": {
      const tokens = v.tokens as Record<string, unknown> | null;
      return (v.to === null || typeof v.to === "string") &&
        isPool(v.pool) &&
        typeof v.lastActivityMs === "number" &&
        typeof tokens === "object" &&
        tokens !== null &&
        typeof tokens.accessToken === "string" &&
        typeof tokens.idToken === "string" &&
        typeof tokens.refreshToken === "string"
        ? (v as unknown as ShareMessage)
        : null;
    }
    case "activity":
      return isGroup(v) &&
        typeof v.lastActivityMs === "number" &&
        typeof v.ask === "boolean"
        ? (v as unknown as ActivityMessage)
        : null;
    default:
      return null;
  }
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
  // 이 탭에 둔 refresh token으로 갱신해 이어 가는 중인 저장 값(로그인 화면은 이 동안 그리지 않음)
  private restoring: SavedSession | null = null;
  // 넘겨받기를 기다리거나 이어 가는 동안의 저장 값(같은 묶음 탭이 나눈 토큰을 알아보려고)
  private resumable: SavedSession | null = null;
  // 이어 가는 동안 같은 묶음의 다른 탭이 회전해 나눈 토큰
  private adopted: Tokens | null = null;
  // 이어 가기·저장 값이 끝난 풀(로그인 화면을 그 풀로 보냄). 새로고침하면 모듈 메모리의 마지막 풀이 사라지므로
  private signedOutPool: PoolKind | null = null;
  // 유휴 만료 전에 다른 탭의 활동 시각을 한 번 물어봤는지(새 활동이 오면 다시 물음)
  private idleAsked = false;

  constructor(private readonly deps: SessionDeps) {
    deps.channel?.listen((raw) => {
      const message = parseMessage(raw);
      if (!message) return;
      if (message.kind === "logout") this.receiveLogout(message);
      else if (message.kind === "hello") this.answerHello(message);
      else if (message.kind === "share") this.receiveShare(message);
      else this.receiveActivity(message);
    });
  }

  // 새 탭·새로고침: 열려 있는 로그인한 탭에 로그인을 달라고 함. 잠깐 기다려 답이 없으면
  // 이 탭에 둔 refresh token으로 이어 가고(D17-11), 그것도 없으면 로그인 화면
  // pool: 로그인 화면이 정한 풀(데모 주소면 데모 탭·데모 저장 값만). 없으면 아무 풀
  join(pool: PoolKind | null = null): void {
    const channel = this.deps.channel;
    if (this.live || this.joinTried) return;
    const saved = this.savedFor(pool);
    if (!channel && !saved) return;
    this.joinTried = true;
    this.resumable = saved;
    const id = this.deps.newId?.() ?? crypto.randomUUID();
    this.joinId = id;
    this.publishSignedOut();
    // 저장 값이 있으면 그 풀의 탭에만 물음(데모로 쓰던 탭이 새로고침에 운영자 로그인으로 바뀌지 않게)
    channel?.post({
      kind: "hello",
      id,
      pool: pool ?? saved?.pool ?? null,
    } satisfies HelloMessage);
    this.deps.setTimer(
      () => {
        if (this.joinId !== id) return;
        this.joinId = null;
        if (this.live) {
          this.resumable = null;
          return;
        }
        if (saved) void this.restore(saved);
        else this.publishSignedOut();
      },
      channel ? JOIN_WAIT_MS : 0,
    );
  }

  // 이어 갈 수 있는 저장 값. 유휴 60분·8시간이 지났으면 지움
  private savedFor(pool: PoolKind | null): SavedSession | null {
    const store = this.deps.store;
    if (!store) return null;
    const saved = parseSaved(store.load());
    if (!saved) return null;
    if (pool !== null && saved.pool !== pool) return null;
    const now = this.deps.now();
    const phase = sessionPhase(
      sessionTimes({
        authTimeMs: saved.authTimeMs,
        accessExpMs: now,
        lastActivityMs: saved.lastActivityMs,
      }),
      now,
    );
    if (phase === "idle_expired" || phase === "max_expired") {
      store.save(null);
      // 로그인 화면에 만료 안내(보던 화면·저장하지 않은 변경)
      this.signedOutReason = phase === "max_expired" ? "max" : "idle";
      this.signedOutPool = saved.pool;
      return null;
    }
    return saved;
  }

  // 새로고침: 이 탭에 둔 refresh token으로 갱신해 로그인을 이어 감(D17-11)
  // - 회전 유예 0초라 잠금 안에서 갱신하고, 잠금을 풀기 전에 로그인·새 토큰 나누기까지 끝냄
  // - 함께 복원된 같은 묶음의 탭(브라우저 세션 복원)이 먼저 회전해 나눈 토큰이 있으면 그것을 받음
  // - 토큰이 거부되면(NotAuthorized·다른 계정·다른 최초 인증) 저장 값을 지우고 로그인 화면
  // - 그 밖의 실패(망 오류·시간 초과·요청 제한·서버 오류)는 저장 값을 두고 로그인 화면(다시 새로고침하면 다시 시도)
  private async restore(saved: SavedSession): Promise<void> {
    this.restoring = saved;
    this.adopted = null;
    this.publishSignedOut();
    const lock = this.deps.lock ?? ((fn) => fn());
    let outcome: "ok" | "rejected" | "failed";
    try {
      outcome = await lock(async () => {
        if (this.live) return "ok";
        let tokens = this.adopted;
        if (!tokens) {
          try {
            tokens = await this.deps.refresh(saved.pool, saved.refreshToken);
          } catch (error) {
            // 같은 묶음의 탭이 먼저 회전시켰을 수 있음 → 그 탭이 나눈 새 토큰을 잠깐 기다림
            if (this.deps.channel) {
              await new Promise<void>((done) =>
                this.deps.setTimer(() => done(), ADOPT_WAIT_MS),
              );
            }
            tokens = this.adopted;
            if (!tokens) throw error;
          }
        }
        return this.resume(saved, tokens) ? "ok" : "rejected";
      });
    } catch (error) {
      const failure = authFailureOf(error);
      outcome =
        failure === "wrong_credentials" || failure === "session_expired"
          ? "rejected"
          : "failed";
    } finally {
      this.restoring = null;
      this.resumable = null;
      this.adopted = null;
    }
    if (outcome === "ok" || this.live) return;
    if (outcome === "rejected") this.deps.store?.save(null);
    this.signedOutReason =
      outcome === "rejected" ? "resume_rejected" : "resume_failed";
    this.signedOutPool = saved.pool;
    this.publishSignedOut();
  }

  // 이어 가기로 받은 토큰을 확인하고 로그인. 다른 계정·다른 최초 인증이면 받지 않고 그 refresh token을 폐기
  private resume(saved: SavedSession, tokens: Tokens): boolean {
    const access = accessClaims(tokens.accessToken);
    if (
      !access ||
      access.sub !== saved.sub ||
      access.authTimeMs !== saved.authTimeMs
    ) {
      void this.deps
        .revoke(saved.pool, tokens.refreshToken || saved.refreshToken)
        .catch(() => undefined);
      return false;
    }
    const ok = this.signIn(saved.pool, {
      accessToken: tokens.accessToken,
      idToken: tokens.idToken,
      refreshToken: tokens.refreshToken || saved.refreshToken,
    });
    // 같은 묶음의 다른 탭이 회전 전 refresh token을 쥐고 있지 않게 새 토큰을 나눔(잠금을 풀기 전에)
    if (ok) this.share(null);
    return ok;
  }

  private group(): Group | null {
    const live = this.live;
    return live
      ? { pool: live.pool, sub: live.sub, authTimeMs: live.authTimeMs }
      : null;
  }

  private sameGroup(other: Group, withAuthTime = true): boolean {
    const live = this.live;
    return (
      !!live &&
      other.pool === live.pool &&
      other.sub === live.sub &&
      (!withAuthTime || other.authTimeMs === live.authTimeMs)
    );
  }

  private receiveLogout(message: LogoutMessage): void {
    // 직접 로그아웃은 같은 계정의 모든 탭(다시 로그인해 최초 인증이 달라도). 유휴·상한은 같은 묶음만
    if (!this.sameGroup(message, message.reason !== "logout")) return;
    // 멈춰 있던 탭이 옛 활동 시각으로 유휴 만료를 보내면 쓰던 탭은 따르지 않음
    if (message.reason === "idle" && this.currentPhase() !== "idle_expired") {
      return;
    }
    this.end("other_tab", false);
  }

  private answerHello(message: HelloMessage): void {
    const live = this.live;
    if (!live || live.reauth) return;
    if (message.pool !== null && message.pool !== live.pool) return;
    // 끝날 때가 된 세션은 넘기지 않음(update가 곧 끝냄)
    const phase = this.currentPhase();
    if (phase === "idle_expired" || phase === "max_expired") return;
    this.share(message.id);
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

  private postActivity(ask: boolean): void {
    const group = this.group();
    if (!group || !this.live) return;
    this.deps.channel?.post({
      kind: "activity",
      ...group,
      lastActivityMs: this.live.lastActivityMs,
      ask,
    } satisfies ActivityMessage);
  }

  private receiveActivity(message: ActivityMessage): void {
    const live = this.live;
    if (!live || !this.sameGroup(message)) return;
    if (message.lastActivityMs > live.lastActivityMs) {
      live.lastActivityMs = message.lastActivityMs;
      this.idleAsked = false;
      this.update();
    } else if (message.ask && live.lastActivityMs > message.lastActivityMs) {
      // 묻는 탭보다 늦은 활동을 봤으면 알려 줌(그 탭이 유휴로 끝나지 않게)
      this.postActivity(false);
    }
  }

  private receiveShare(message: ShareMessage): void {
    const access = accessClaims(message.tokens.accessToken);
    if (!access) return;
    const live = this.live;
    if (!live) {
      const resumable = this.resumable;
      // 함께 복원된 같은 묶음의 탭이 회전해 나눈 토큰(이 탭의 저장 토큰은 이제 쓸 수 없음)
      const sibling =
        resumable !== null &&
        message.to === null &&
        message.pool === resumable.pool &&
        access.sub === resumable.sub &&
        access.authTimeMs === resumable.authTimeMs;
      if (this.restoring) {
        // 이어 가는 중: 받아 두고 잠금 안에서 씀
        if (sibling) this.adopted = message.tokens;
        return;
      }
      if (sibling && this.joinId) {
        // 아직 넘겨받기를 기다리는 중: 넘겨받은 것과 같음
        this.joinId = null;
        this.resumable = null;
        if (this.signIn(message.pool, message.tokens)) this.postActivity(false);
        return;
      }
      // 내가 기다리던 답만 받음(로그아웃한 탭이 남의 갱신 신호로 다시 로그인되지 않게)
      if (message.to === null || message.to !== this.joinId) return;
      this.joinId = null;
      // 새 탭을 연 것도 활동으로 셈(signIn이 지금 시각으로 둠). 다른 탭의 유휴 시각도 함께 늦춤
      if (this.signIn(message.pool, message.tokens)) this.postActivity(false);
      return;
    }
    if (message.to !== null) return;
    const group = {
      pool: message.pool,
      sub: access.sub,
      authTimeMs: access.authTimeMs,
    };
    if (this.sameGroup(group)) {
      // 같은 묶음: 더 늦게 만료되는 토큰(다른 탭이 갱신한 것)을 받음
      if (access.expMs <= live.accessExpMs) return;
      live.tokens = message.tokens;
      live.accessExpMs = access.expMs;
      // 다시 로그인을 기다리던 탭이 풀리면 화면이 다시 읽도록 generation을 늘림
      if (live.reauth) this.generation += 1;
      live.reauth = false;
    } else if (live.reauth && this.sameGroup(group, false)) {
      // 다시 로그인을 기다리던 탭: 같은 계정이 다른 탭에서 다시 로그인했으면 그 로그인으로 이어 감
      live.tokens = message.tokens;
      live.accessExpMs = access.expMs;
      live.authTimeMs = access.authTimeMs;
      live.groups = access.groups;
      live.reauth = false;
      this.generation += 1;
    } else {
      return;
    }
    if (message.lastActivityMs > live.lastActivityMs) {
      live.lastActivityMs = message.lastActivityMs;
      this.idleAsked = false;
    }
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
      sub: access.sub,
      tokens,
      email: idClaims(tokens.idToken).email,
      groups: access.groups,
      authTimeMs: access.authTimeMs,
      accessExpMs: access.expMs,
      lastActivityMs: this.deps.now(),
      reauth: false,
    };
    this.signedOutReason = null;
    this.signedOutPool = null;
    this.joinId = null;
    this.idleAsked = false;
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
    this.idleAsked = false;
    this.update();
    // 다른 탭의 유휴 시각도 늦춤(쓰지 않던 탭이 쓰던 탭까지 로그아웃시키지 않게). 토큰은 보내지 않음
    this.postActivity(false);
  }

  // 운영 API에 실을 access token. 만료가 가까우면 먼저 갱신. 다시 로그인이 필요하면 null
  async accessToken(): Promise<string | null> {
    if (!this.live || this.live.reauth) return null;
    const times = this.times();
    if (times && this.deps.now() >= times.refreshAt) {
      const before = this.live;
      if (!(await this.refreshNow())) {
        // 잠금을 기다리는 사이 이 탭에서 다시 로그인했으면 새 세션의 토큰을 씀
        const now = this.live;
        return now && now !== before && !now.reauth
          ? now.tokens.accessToken
          : null;
      }
    }
    return this.live?.reauth ? null : (this.live?.tokens.accessToken ?? null);
  }

  // 같은 탭의 다시 로그인(로그인 창): 같은 풀·같은 계정이면 화면을 유지하고 토큰만 바꿈
  reauthenticate(tokens: Tokens): boolean {
    const pool = this.live?.pool;
    if (!pool) return false;
    // 같은 계정으로 다시 로그인을 기다리던 다른 탭도 이 로그인으로 이어 가게 나눔
    const ok = this.signIn(pool, tokens);
    if (ok) this.share(null);
    return ok;
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
      // 회전된 refresh token을 바로 저장(옛 토큰은 이미 쓸 수 없음)
      this.persist();
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
    const group = this.group();
    this.live = null;
    this.signedOutReason = reason;
    this.signedOutPool = null;
    if (
      broadcast &&
      group &&
      (reason === "logout" || reason === "idle" || reason === "max")
    ) {
      this.deps.channel?.post({
        kind: "logout",
        reason,
        ...group,
      } satisfies LogoutMessage);
    }
    this.update();
  }

  // 새로고침해도 이어 가도록 이 탭에 refresh token·시각을 둠. 로그아웃·만료면 지움
  private persist(): void {
    const store = this.deps.store;
    if (!store) return;
    const live = this.live;
    if (!live) {
      store.save(null);
      return;
    }
    // 다른 로그인(다른 풀·계정·최초 인증)의 저장 값을 덮어쓰면 그 refresh token을 폐기(쓸 수 있는 채로 남기지 않음)
    const before = parseSaved(store.load());
    if (
      before &&
      (before.pool !== live.pool ||
        before.sub !== live.sub ||
        before.authTimeMs !== live.authTimeMs)
    ) {
      void this.deps
        .revoke(before.pool, before.refreshToken)
        .catch(() => undefined);
    }
    store.save({
      pool: live.pool,
      sub: live.sub,
      refreshToken: live.tokens.refreshToken,
      authTimeMs: live.authTimeMs,
      lastActivityMs: live.lastActivityMs,
    });
  }

  // 상태를 다시 계산하고 다음 경계에 깨어나게 함
  private update(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
    this.persist();
    const live = this.live;
    const times = this.times();
    if (!live || !times) {
      this.publishSignedOut();
      return;
    }
    const now = this.deps.now();
    const phase = sessionPhase(times, now);
    // 유휴 만료 전에 다른 탭에 한 번 물어봄(이 탭이 멈춰 있어 활동 신호를 못 받았을 수 있음)
    if (phase === "idle_expired" && this.deps.channel && !this.idleAsked) {
      this.idleAsked = true;
      this.postActivity(true);
      this.timer = this.deps.setTimer(() => {
        this.timer = null;
        this.update();
      }, JOIN_WAIT_MS);
      return;
    }
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
    this.publish({
      status: "signed_out",
      reason: this.signedOutReason,
      ...(this.signedOutPool ? { pool: this.signedOutPool } : {}),
      ...(this.joinId || this.restoring ? { joining: true as const } : {}),
    });
  }

  private publish(next: SessionSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
