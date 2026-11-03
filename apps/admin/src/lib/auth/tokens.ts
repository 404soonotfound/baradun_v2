// 토큰 클레임 읽기 (BRD-148). 서명 검증은 운영 API가 요청마다 함(D16-A7). 화면은 시각·이름 표시에만 씀
// 모양이 틀리면 null → 로그인 실패로 다룸(디코딩만 한 값을 권한 판단에 쓰지 않음)

export interface AccessClaims {
  readonly sub: string;
  readonly expMs: number;
  readonly authTimeMs: number;
  readonly groups: readonly string[];
}

export interface IdClaims {
  readonly email: string | null;
}

function payloadOf(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const text = new TextDecoder().decode(
      Uint8Array.from(json, (c) => c.charCodeAt(0)),
    );
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function accessClaims(jwt: string): AccessClaims | null {
  const p = payloadOf(jwt);
  if (
    !p ||
    p.token_use !== "access" ||
    typeof p.sub !== "string" ||
    typeof p.exp !== "number" ||
    typeof p.auth_time !== "number"
  ) {
    return null;
  }
  const groups = Array.isArray(p["cognito:groups"])
    ? (p["cognito:groups"] as unknown[]).filter(
        (g): g is string => typeof g === "string",
      )
    : [];
  return {
    sub: p.sub,
    expMs: p.exp * 1000,
    authTimeMs: p.auth_time * 1000,
    groups,
  };
}

export function idClaims(jwt: string): IdClaims {
  const p = payloadOf(jwt);
  return { email: typeof p?.email === "string" ? p.email : null };
}
