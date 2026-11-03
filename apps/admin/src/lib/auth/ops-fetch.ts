import { ACCESS_TOKEN_HEADER } from "./policy";

// 운영 API 부르기 (BRD-148). 같은 주소의 /ops/* (CloudFront → OAC → 운영 API 함수 URL, BRD-147)
// - access token은 Authorization이 아닌 전용 헤더로 보냄(Authorization은 OAC 서명이 씀)
// - 본문이 있는 요청은 본문 SHA-256(x-amz-content-sha256)을 함께 보내야 OAC 서명이 통과함
// - 토큰이 없으면(다시 로그인 필요) 요청하지 않고 'reauth'로 돌려줌. 쓰기를 자동으로 다시 보내지 않음(D16-E1)

export type OpsResult<T> =
  | { readonly ok: true; readonly status: number; readonly body: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly requestId: string | null;
    }
  | {
      readonly ok: false;
      readonly status: 0;
      readonly code: "reauth" | "network";
    };

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface OpsRequest {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  // 쓰기 멱등 키(UUID v4). 화면이 쓰기마다 새로 만들어 넘김
  readonly idempotencyKey?: string;
}

export async function opsFetch<T>(
  path: `/ops/${string}`,
  accessToken: () => Promise<string | null>,
  request: OpsRequest = {},
  fetcher: typeof fetch = fetch,
): Promise<OpsResult<T>> {
  const token = await accessToken();
  if (!token) return { ok: false, status: 0, code: "reauth" };
  const headers: Record<string, string> = { [ACCESS_TOKEN_HEADER]: token };
  let body: string | undefined;
  if (request.body !== undefined) {
    body = JSON.stringify(request.body);
    headers["content-type"] = "application/json";
    headers["x-amz-content-sha256"] = await sha256Hex(body);
  }
  if (request.idempotencyKey) {
    headers["x-idempotency-key"] = request.idempotencyKey;
  }
  let response: Response;
  try {
    response = await fetcher(path, {
      method: request.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    return { ok: false, status: 0, code: "network" };
  }
  const value: unknown = await response.json().catch(() => null);
  if (response.ok)
    return { ok: true, status: response.status, body: value as T };
  const error = (
    value as { error?: { code?: unknown; requestId?: unknown } } | null
  )?.error;
  return {
    ok: false,
    status: response.status,
    code: typeof error?.code === "string" ? error.code : "unknown",
    requestId: typeof error?.requestId === "string" ? error.requestId : null,
  };
}
