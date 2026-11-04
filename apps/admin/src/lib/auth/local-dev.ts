import type { PoolKind } from "./config";
import {
  localInquiry,
  localInquiryPage,
  localSaveInquiry,
} from "./local-inquiries";
import { localAudit } from "./local-audit";
import { localCollection } from "./local-collection";
import { localNotices } from "./local-notices";
import { SESSION } from "./policy";
import type { AuthSession } from "./session";
import type { Tokens } from "./srp";
import type { OpsRequest, OpsResult } from "./ops-fetch";

// 로컬 개발 서버 전용 테스트 로그인 (BRD-172)
// - next dev(NODE_ENV=development)에서만 씀. 부르는 곳은 process.env.NODE_ENV 분기 안에서 import()로만 불러옴
//   (위에서 정적으로 가져오면 쓰지 않아도 배포 묶음에 남음) → 배포 빌드에서는 코드째 빠짐
//   빠졌는지는 빌드 결과 검사가 LOCAL_MARKER로 확인함(scripts/check-out.mts)
// - 실제 Cognito·운영 API를 부르지 않음. 서명 없는 가짜 토큰과 로컬 샘플 응답만 씀
// - 새로고침해도 이어지게 이 탭 sessionStorage에 최초 인증·유휴 만료 시각만 둠(토큰은 두지 않고 다시 만듦)
//   유휴 60분·8시간 상한은 실제 로그인과 같음

export const LOCAL_MARKER = "baradun-local-dev";
export const LOCAL_EMAIL = "local-tester@example.test";

const GROUPS: Record<PoolKind, readonly string[]> = {
  operator: ["publisher"],
  demo: ["sample"],
};

function part(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/=+$/, "");
}

// 서명 자리에 표시를 넣어 로컬 토큰인지 알아봄. refresh token에는 풀·최초 인증 시각을 실음(갱신 때 그대로 이어 감)
export function localTokens(
  pool: PoolKind,
  authTimeMs: number,
  nowMs: number,
): Tokens {
  const now = Math.floor(nowMs / 1000);
  const authTime = Math.floor(authTimeMs / 1000);
  return {
    accessToken: `${part({ alg: "none" })}.${part({
      token_use: "access",
      sub: "local-tester",
      exp: now + 15 * 60,
      iat: now,
      auth_time: authTime,
      "cognito:groups": GROUPS[pool],
    })}.${LOCAL_MARKER}`,
    idToken: `${part({ alg: "none" })}.${part({
      token_use: "id",
      email: LOCAL_EMAIL,
      exp: now + 15 * 60,
      iat: now,
      auth_time: authTime,
    })}.${LOCAL_MARKER}`,
    refreshToken: `${LOCAL_MARKER}.${pool}.${authTime}`,
  };
}

export function isLocalToken(token: string): boolean {
  return (
    token.endsWith(`.${LOCAL_MARKER}`) || token.startsWith(`${LOCAL_MARKER}.`)
  );
}

// 로컬 refresh token이면 같은 최초 인증 시각으로 새 토큰을 줌. 아니면 null(실제 Cognito로)
export function localRefresh(
  refreshToken: string,
  nowMs: number,
): Tokens | null {
  const [marker, pool, authTime] = refreshToken.split(".");
  if (marker !== LOCAL_MARKER || (pool !== "operator" && pool !== "demo"))
    return null;
  return localTokens(pool, Number(authTime) * 1000, nowMs);
}

interface Saved {
  readonly pool: PoolKind;
  readonly authTimeMs: number;
  readonly idleEndAt: number;
}

function read(): Saved | null {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(LOCAL_MARKER) ?? "null",
    );
    const v = value as Partial<Saved> | null;
    return v &&
      (v.pool === "operator" || v.pool === "demo") &&
      typeof v.authTimeMs === "number" &&
      typeof v.idleEndAt === "number"
      ? (v as Saved)
      : null;
  } catch {
    return null;
  }
}

// 저장해 둔 로컬 로그인이 아직 유휴·상한 안이면 이어 감. 이후 상태가 바뀔 때마다 시각을 다시 적고, 로그아웃하면 지움
export function attachLocalSession(session: AuthSession): () => void {
  const now = Date.now();
  const saved = read();
  if (
    saved &&
    now < saved.idleEndAt &&
    now < saved.authTimeMs + SESSION.maxMs &&
    session.getSnapshot().status === "signed_out"
  ) {
    session.signIn(saved.pool, localTokens(saved.pool, saved.authTimeMs, now));
  }
  const save = () => {
    const snapshot = session.getSnapshot();
    try {
      if (snapshot.status === "signed_out") {
        sessionStorage.removeItem(LOCAL_MARKER);
      } else if (snapshot.email === LOCAL_EMAIL) {
        const next: Saved = {
          pool: snapshot.pool,
          authTimeMs: snapshot.times.maxEndAt - SESSION.maxMs,
          idleEndAt: snapshot.times.idleEndAt,
        };
        sessionStorage.setItem(LOCAL_MARKER, JSON.stringify(next));
      }
    } catch {
      // 저장소를 못 쓰면 이어 가기만 안 됨
    }
  };
  save();
  return session.subscribe(save);
}

// 운영 API 대신 주는 로컬 샘플 응답. 화면을 만들 때 여기에 경로를 더함
export function localOps<T>(
  path: string,
  pool: PoolKind,
  request: OpsRequest,
): OpsResult<T> {
  const method = request.method ?? "GET";
  const url = new URL(path, "http://local");
  if (method === "GET" && url.pathname === "/ops/inquiries") {
    return localInquiryPage<T>(url.searchParams);
  }
  const inquiry = /^\/ops\/inquiries\/([^/]+)$/.exec(url.pathname);
  if (method === "GET" && inquiry) {
    return localInquiry<T>(decodeURIComponent(inquiry[1]!));
  }
  if (method === "PATCH" && inquiry) {
    return localSaveInquiry<T>(decodeURIComponent(inquiry[1]!), request.body);
  }
  if (method === "GET" && url.pathname === "/ops/audit") {
    return localAudit<T>(url.searchParams);
  }
  if (method === "GET" && url.pathname === "/ops/collection") {
    return localCollection<T>();
  }
  if (url.pathname.startsWith("/ops/notices")) {
    const notices = localNotices<T>(url.pathname, request);
    if (notices) return notices;
  }
  if (method === "GET" && path === "/ops/me") {
    return {
      ok: true,
      status: 200,
      body: {
        kind: pool === "demo" ? "sample" : "operator",
        role: GROUPS[pool][0],
        authTime: "",
        sessionExpiresAt: "",
      } as T,
    };
  }
  return {
    ok: false,
    status: 501,
    code: "local_sample_missing",
    requestId: null,
  };
}

export function localPoolOf(token: string): PoolKind {
  try {
    const payload: unknown = JSON.parse(atob(token.split(".")[1] ?? ""));
    const groups = (payload as { "cognito:groups"?: unknown })[
      "cognito:groups"
    ];
    return Array.isArray(groups) && groups.includes("sample")
      ? "demo"
      : "operator";
  } catch {
    return "operator";
  }
}
