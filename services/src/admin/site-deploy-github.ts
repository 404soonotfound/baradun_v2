// 조회 전용 GitHub REST API. 인증값과 오류 응답 본문을 밖으로 내보내지 않음.
import type { SiteDeployReason } from "@baradun/contracts";

export class SiteDeployError extends Error {
  constructor(
    readonly reason: SiteDeployReason,
    readonly retryAt?: number,
  ) {
    super(reason);
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SiteDeployError("invalid");
  }
  return value as Record<string, unknown>;
}

export function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new SiteDeployError("invalid");
  return value as unknown[];
}

const API = "https://api.github.com";
const ETAG_CACHE_SIZE = 64;

interface GitHubPage {
  readonly body: unknown;
  readonly next: boolean;
}

function rateLimitUntil(headers: Headers, now: number): number {
  const retry = headers.get("retry-after");
  const reset = headers.get("x-ratelimit-reset");
  if (retry && /^\d+$/.test(retry)) return now + Number(retry) * 1_000;
  if (
    headers.get("x-ratelimit-remaining") === "0" &&
    reset &&
    /^\d+$/.test(reset)
  ) {
    return Math.max(now + 1_000, Number(reset) * 1_000);
  }
  return now + 60_000;
}

export function createSiteDeployGitHub(
  repo: string,
  request: typeof fetch,
  now: () => Date,
) {
  const base = `/repos/${repo}`;
  const cache = new Map<string, { etag: string; page: GitHubPage }>();
  let blockedUntil = 0;

  return async (
    path: string,
    token: string,
    budget: AbortSignal,
  ): Promise<GitHubPage> => {
    const time = now().getTime();
    if (time < blockedUntil)
      throw new SiteDeployError("rate_limit", blockedUntil);
    const saved = cache.get(path);
    const signal = AbortSignal.any([budget, AbortSignal.timeout(2_500)]);
    try {
      const response = await request(API + base + path, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10",
          ...(saved ? { "If-None-Match": saved.etag } : {}),
        },
        redirect: "error",
        signal,
      });
      if (response.status === 304 && saved) return saved.page;
      if (!response.ok) {
        const remaining = response.headers.get("x-ratelimit-remaining");
        // 보조 한도 403은 Retry-After가 없을 수 있어 본문의 고정 메시지만 확인함.
        const message =
          response.status === 403 &&
          remaining !== "0" &&
          !response.headers.has("retry-after")
            ? await response
                .json()
                .then((body: unknown) => record(body).message)
                .catch(() => null)
            : null;
        if (
          response.status === 429 ||
          (response.status === 403 &&
            (remaining === "0" ||
              response.headers.has("retry-after") ||
              (typeof message === "string" && /rate limit/i.test(message))))
        ) {
          blockedUntil = rateLimitUntil(response.headers, now().getTime());
          throw new SiteDeployError("rate_limit", blockedUntil);
        }
        if (response.status === 401) throw new SiteDeployError("unauthorized");
        if (response.status === 403) throw new SiteDeployError("forbidden");
        if (response.status === 404) throw new SiteDeployError("not_found");
        throw new SiteDeployError("unavailable");
      }
      const page = {
        body: (await response.json()) as unknown,
        next: /;\s*rel="next"/.test(response.headers.get("link") ?? ""),
      };
      const etag = response.headers.get("etag");
      // ETag 본문은 재검증에만 사용함. 304 외에는 이전 응답을 현재 값으로 쓰지 않음.
      cache.delete(path);
      if (etag) {
        cache.set(path, { etag, page });
        if (cache.size > ETAG_CACHE_SIZE)
          cache.delete(cache.keys().next().value!);
      }
      return page;
    } catch (error) {
      if (error instanceof SiteDeployError) throw error;
      throw new SiteDeployError(signal.aborted ? "timeout" : "unavailable");
    }
  };
}
