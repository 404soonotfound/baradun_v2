import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { AuditView } from "./audit";
import { errorName, safeLog, type RequestIds } from "./http";

// 변경 이력 조회 시 운영자 sub → 이메일 변환 (D16-B5: 감사 기록에 이메일을 저장하지 않고 읽을 때만 조회)
// - 운영자 풀은 signInAliases: { email: true }라 Username이 sub와 다를 수 있음 → ListUsers(Filter: sub = "...") 사용
// - 데모(샘플) 계정은 조회하지 않음
// - 조회 실패·없는 계정은 actorEmail 없이 돌려주어 화면이 임시 표시('운영자 {sub 앞 4자}')를 유지하게 함

export const ACTOR_EMAIL_CACHE_TTL_MS = 10 * 60 * 1000;

// Cognito Filter 문자열 안에서 따옴표·역슬래시·제어문자가 섞이지 않게 허용 문자만 통과
const SAFE_SUB = /^[A-Za-z0-9_.:@-]{1,128}$/;

export interface OperatorEmailLookup {
  findEmailBySub(sub: string): Promise<string | null>;
}

// 운영자 풀 하나에만 묶은 Cognito ListUsers 조회(infra가 그 풀 ARN에만 cognito-idp:ListUsers를 줌)
export function cognitoOperatorEmailLookup(
  userPoolId: string,
  client = new CognitoIdentityProviderClient({}),
): OperatorEmailLookup {
  return {
    async findEmailBySub(sub) {
      if (!SAFE_SUB.test(sub)) return null;
      const result = await client.send(
        new ListUsersCommand({
          UserPoolId: userPoolId,
          Filter: `sub = "${sub}"`,
          Limit: 1,
        }),
      );
      const email = result.Users?.[0]?.Attributes?.find(
        (a) => a.Name === "email",
      )?.Value?.trim();
      return email || null;
    },
  };
}

interface CacheEntry {
  readonly email: string | null;
  readonly expiresAt: number;
}

// Lambda 메모리 캐시(10분). 조회 예외는 캐시하지 않아 다음 요청에서 다시 시도함
export function createCachedOperatorEmailLookup(
  inner: OperatorEmailLookup,
  now: () => Date,
  ttlMs = ACTOR_EMAIL_CACHE_TTL_MS,
): OperatorEmailLookup {
  const cache = new Map<string, CacheEntry>();
  return {
    async findEmailBySub(sub) {
      const nowMs = now().getTime();
      const cached = cache.get(sub);
      if (cached && cached.expiresAt > nowMs) {
        return cached.email;
      }
      const email = await inner.findEmailBySub(sub);
      cache.set(sub, { email, expiresAt: nowMs + ttlMs });
      return email;
    },
  };
}

// 한 페이지 안의 운영자 sub를 중복 없이 모아 이메일로 채움
export async function enrichAuditActors(
  items: readonly AuditView[],
  lookup: OperatorEmailLookup | null | undefined,
  ids?: Pick<RequestIds, "traceId">,
): Promise<readonly AuditView[]> {
  if (!lookup || items.length === 0) return items;
  const subs = [
    ...new Set(
      items
        .filter((item) => item.actorKind === "operator")
        .map((item) => item.actorSub),
    ),
  ];
  if (subs.length === 0) return items;

  const emails = new Map<string, string>();
  await Promise.all(
    subs.map(async (sub) => {
      try {
        const email = await lookup.findEmailBySub(sub);
        if (email) emails.set(sub, email);
      } catch (error) {
        // 이메일·sub는 로그에 남기지 않고 오류 이름만 기록
        safeLog("warn", "ops_audit_actor_email_failed", {
          error: errorName(error),
          ...(ids ? { traceId: ids.traceId } : {}),
        });
      }
    }),
  );

  if (emails.size === 0) return items;
  return items.map((item) => {
    if (item.actorKind !== "operator") return item;
    const actorEmail = emails.get(item.actorSub);
    return actorEmail ? { ...item, actorEmail } : item;
  });
}
