"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { refreshTokens, revokeRefreshToken } from "./cognito-api";
import { POOLS, type PoolKind } from "./config";
import { LOGOUT_CHANNEL } from "./policy";
import { AuthSession, type SessionSnapshot } from "./session";

// 화면 전체가 같은 로그인 세션을 쓰게 함 (BRD-148)
// 세션 객체는 이 탭의 메모리에만 하나 있음(D16-A2). 새로고침하면 새 객체 → 다시 로그인
// 활동(누르기·입력·스크롤)은 유휴 시각만 새로 셈. 경고 시트의 '계속 쓰기'도 같은 touch

function createSession(): AuthSession {
  // 정적 빌드(서버)에서는 채널을 열지 않음. Node에도 BroadcastChannel이 있어 열면 빌드가 끝나지 않을 수 있음
  const channel =
    typeof window === "undefined" || typeof BroadcastChannel === "undefined"
      ? undefined
      : new BroadcastChannel(LOGOUT_CHANNEL);
  const clientOf = (pool: PoolKind) => {
    const config = POOLS?.[pool];
    if (!config) throw new Error("pool config missing");
    return config.clientId;
  };
  return new AuthSession({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    refresh: async (pool, refreshToken) => {
      if (process.env.NODE_ENV === "development") {
        const { localRefresh } = await import("./local-dev");
        const local = localRefresh(refreshToken, Date.now());
        if (local) return local;
      }
      const result = await refreshTokens(clientOf(pool), refreshToken);
      return {
        accessToken: result.AccessToken,
        idToken: result.IdToken ?? "",
        refreshToken: result.RefreshToken ?? "",
      };
    },
    revoke: async (pool, refreshToken) => {
      if (process.env.NODE_ENV === "development") {
        const { isLocalToken } = await import("./local-dev");
        if (isLocalToken(refreshToken)) return;
      }
      await revokeRefreshToken(clientOf(pool), refreshToken);
    },
    ...(channel
      ? {
          channel: {
            post: (message: string) => channel.postMessage(message),
            listen: (fn: (message: string) => void) => {
              channel.onmessage = (event) => {
                if (typeof event.data === "string") fn(event.data);
              };
            },
          },
        }
      : {}),
  });
}

const SessionContext = createContext<AuthSession | null>(null);

const ACTIVITY_EVENTS = [
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session] = useState(createSession);

  // 로컬 개발 서버의 테스트 로그인은 새로고침해도 이어 감(BRD-172)
  // 배포 빌드에서 빠지도록 개발 분기 안에서만 불러옴(위에서 가져오면 쓰지 않아도 묶음에 남음)
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    let stop: (() => void) | null = null;
    let live = true;
    void import("./local-dev").then(({ attachLocalSession }) => {
      if (live) stop = attachLocalSession(session);
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [session]);

  useEffect(() => {
    // 활동이 잦아도 1분에 한 번만 셈(타이머 다시 걸기를 줄임)
    let last = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - last < 60_000) return;
      last = now;
      session.touch();
    };
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, onActivity, { passive: true });
    }
    return () => {
      for (const name of ACTIVITY_EVENTS) {
        window.removeEventListener(name, onActivity);
      }
    };
  }, [session]);

  return (
    <SessionContext.Provider value={session}>
      {children}
    </SessionContext.Provider>
  );
}

export function useAuthSession(): AuthSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error("AuthProvider 밖에서 세션을 씀");
  return session;
}

const SIGNED_OUT: SessionSnapshot = { status: "signed_out", reason: null };

export function useSessionSnapshot(): SessionSnapshot {
  const session = useAuthSession();
  return useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    () => SIGNED_OUT,
  );
}
